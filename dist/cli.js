#!/usr/bin/env node
/**
 * meow-push — MeoW 消息推送 CLI
 *
 * A small, dependency-free command line front end for the MeoW push API
 * (https://www.chuckfang.com/MeoW/api_doc.html). Designed to be driven by an
 * agent: every outcome is a stable exit code, and `--json` gives a
 * machine-readable result on stdout.
 */
import { readFileSync } from 'node:fs';
import { UsageError, describeFlags, parseArgs, renderFlags } from "./args.js";
import { DEFAULT_BASE_URL, DEFAULT_HTML_HEIGHT, DEFAULT_TIMEOUT_MS, DEFAULT_TITLE, buildRequest, normalizeBaseUrl, probeEndpoint, sendPush, } from "./client.js";
import { EXIT } from "./types.js";
const TOOL = 'meow-push';
const FALLBACK_VERSION = '1.0.0';
/** Upper bound accepted by `AbortSignal.timeout()`. */
const MAX_TIMEOUT_MS = 4_294_967_295;
/** Sanity bound for `--html-height`; far beyond any real display. */
const MAX_HTML_HEIGHT = 1_000_000;
/**
 * A path segment that is exactly "." or ".."; the URL parser deletes it, so
 * the request on the wire would differ from the previewed one.
 */
const DOT_SEGMENT = /^\.\.?$/;
function rejectDotSegment(label, value) {
    if (DOT_SEGMENT.test(value)) {
        throw new UsageError(`${label} 不能是 "." 或 ".."：URL 解析器会把它当作相对路径段删掉，实际发出的地址将与预览不一致`);
    }
}
export function readVersion() {
    try {
        const url = new URL('../package.json', import.meta.url);
        const pkg = JSON.parse(readFileSync(url, 'utf8'));
        return typeof pkg.version === 'string' ? pkg.version : FALLBACK_VERSION;
    }
    catch {
        return FALLBACK_VERSION;
    }
}
const GLOBAL_FLAGS = [
    {
        name: 'help',
        alias: 'h',
        kind: 'boolean',
        help: '显示帮助',
        valueHint: null,
        defaultValue: null,
        choices: null,
    },
    {
        name: 'version',
        alias: 'V',
        kind: 'boolean',
        help: '显示版本',
        valueHint: null,
        defaultValue: null,
        choices: null,
    },
];
/** Shared by every command that can emit a machine-readable result. */
const JSON_FLAG = {
    name: 'json',
    alias: null,
    kind: 'boolean',
    help: '以 JSON 输出结果（stdout 只有 JSON）',
    valueHint: null,
    defaultValue: false,
    choices: null,
};
const SEND_FLAGS = [
    {
        name: 'to',
        alias: 't',
        kind: 'string',
        help: '接收者 MeoW 昵称（必填，不能包含斜杠）',
        valueHint: '<昵称>',
        defaultValue: null,
        choices: null,
    },
    {
        name: 'msg',
        alias: 'm',
        kind: 'string',
        help: '消息内容（与 --msg-file 二选一）',
        valueHint: '<内容>',
        defaultValue: null,
        choices: null,
    },
    {
        name: 'msg-file',
        alias: null,
        kind: 'string',
        help: '从文件读取消息内容，- 表示 stdin（适合含引号的 HTML）',
        valueHint: '<路径>',
        defaultValue: null,
        choices: null,
    },
    {
        name: 'title',
        alias: null,
        kind: 'string',
        help: '消息标题；省略时由 CLI 填入文档默认值 MeoW',
        valueHint: '<标题>',
        defaultValue: null,
        choices: null,
    },
    {
        name: 'url',
        alias: 'u',
        kind: 'string',
        help: '点击通知后的跳转链接',
        valueHint: '<URL>',
        defaultValue: null,
        choices: null,
    },
    {
        name: 'img-url',
        alias: null,
        kind: 'string',
        help: '通知图标 URL，建议 216×216 PNG',
        valueHint: '<URL>',
        defaultValue: null,
        choices: null,
    },
    {
        name: 'type',
        alias: null,
        kind: 'string',
        help: '消息显示类型，text 纯文本 / html 由 App 渲染',
        valueHint: '<text|html>',
        defaultValue: 'text',
        choices: ['text', 'html'],
    },
    {
        name: 'html-height',
        alias: null,
        kind: 'integer',
        help: `仅在 --type html 时生效的显示高度（像素，1..${MAX_HTML_HEIGHT}）`,
        valueHint: '<像素>',
        defaultValue: DEFAULT_HTML_HEIGHT,
        choices: null,
    },
    {
        name: 'method',
        alias: null,
        kind: 'string',
        help: '请求方法；post 更稳（GET 把内容放在路径里）',
        valueHint: '<post|get>',
        defaultValue: 'post',
        choices: ['post', 'get'],
    },
    {
        name: 'format',
        alias: null,
        kind: 'string',
        help: 'POST 请求体编码',
        valueHint: '<json|form|text>',
        defaultValue: 'json',
        choices: ['json', 'form', 'text'],
    },
    {
        name: 'base-url',
        alias: null,
        kind: 'string',
        help: 'API 基地址（一般无需修改）',
        valueHint: '<URL>',
        defaultValue: DEFAULT_BASE_URL,
        choices: null,
    },
    {
        name: 'allow-http',
        alias: null,
        kind: 'boolean',
        help: '允许明文 HTTP 基地址（不推荐，内容不作加密）',
        valueHint: null,
        defaultValue: false,
        choices: null,
    },
    {
        name: 'timeout',
        alias: null,
        kind: 'integer',
        help: '单次请求超时（毫秒）',
        valueHint: '<毫秒>',
        defaultValue: DEFAULT_TIMEOUT_MS,
        choices: null,
    },
    {
        name: 'dry-run',
        alias: 'n',
        kind: 'boolean',
        help: '只打印将要发出的请求，不实际推送',
        valueHint: null,
        defaultValue: false,
        choices: null,
    },
    JSON_FLAG,
];
const DOCTOR_FLAGS = [
    {
        name: 'probe',
        alias: null,
        kind: 'boolean',
        help: '额外请求 API 根路径，检查连通性与 IP 限制（不会推送消息）',
        valueHint: null,
        defaultValue: false,
        choices: null,
    },
    {
        name: 'base-url',
        alias: null,
        kind: 'string',
        help: 'API 基地址',
        valueHint: '<URL>',
        defaultValue: DEFAULT_BASE_URL,
        choices: null,
    },
    {
        name: 'allow-http',
        alias: null,
        kind: 'boolean',
        help: '允许明文 HTTP 基地址',
        valueHint: null,
        defaultValue: false,
        choices: null,
    },
    {
        name: 'timeout',
        alias: null,
        kind: 'integer',
        help: '探测超时（毫秒）',
        valueHint: '<毫秒>',
        defaultValue: DEFAULT_TIMEOUT_MS,
        choices: null,
    },
    JSON_FLAG,
];
const EXIT_CODE_DOC = [
    { code: EXIT.OK, name: 'success', meaning: '服务端已受理推送（confirmed 表示信封是否含 data:true 确认）' },
    { code: EXIT.USAGE, name: 'usage', meaning: '本地参数错误，未发出任何请求' },
    { code: EXIT.UNKNOWN, name: 'unknown', meaning: '结果不确定：网络错误 / 超时 / 重定向 / 5xx / HTTP 与业务状态冲突 / 响应无法解析；不要自动重发' },
    { code: EXIT.REJECTED, name: 'rejected', meaning: '业务状态码 400 / 403 / 404；改参数前重试无意义，用 reason 区分具体原因' },
    { code: EXIT.RATE_LIMITED, name: 'rate_limited', meaning: '业务状态码 429；频率或 IP 受限，不要循环重试' },
    { code: EXIT.UNCONFIRMED, name: 'unconfirmed', meaning: '业务码 200 却带 data=false，语义不一致，按失败处理且不要重发' },
];
const HELP = `meow-push ${readVersion()} — MeoW 消息推送 CLI

用法
  meow-push send     --to <昵称> --msg <内容> [选项]
  meow-push preview  --to <昵称> --msg <内容> [选项]     等价于 send --dry-run
  meow-push doctor   [--probe]                          环境与连通性自检（不会推送）
  meow-push schema                                      以 JSON 输出命令/参数/退出码
  meow-push help

send / preview 选项
${renderFlags([...SEND_FLAGS, ...GLOBAL_FLAGS])}

doctor 选项
${renderFlags([...DOCTOR_FLAGS, ...GLOBAL_FLAGS])}

退出码
${EXIT_CODE_DOC.map((e) => `  ${e.code}  ${e.name.padEnd(12)}${e.meaning}`).join('\n')}

示例
  # 只预览，不发送
  meow-push preview --to JohnDoe --title 系统通知 --msg "构建已完成"

  # 推送 HTML 消息并带跳转链接
  meow-push send --to JohnDoe --type html --html-height 300 \\
    --title 系统通知 --msg '<b>有新消息</b>' --url https://example.com

  # 内容含大量引号时从文件读取
  meow-push send --to JohnDoe --msg-file ./notice.html --type html

接口：https://www.chuckfang.com/MeoW/api_doc.html
`;
function outputJson(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function note(text, json) {
    if (json)
        process.stderr.write(`${text}\n`);
    else
        process.stdout.write(`${text}\n`);
}
function readStringFlag(args, name) {
    const value = args.values[name];
    return typeof value === 'string' ? value : undefined;
}
function readBooleanFlag(args, name) {
    return args.values[name] === true;
}
function readIntegerFlag(args, name, fallback) {
    const value = args.values[name];
    return typeof value === 'number' ? value : fallback;
}
function readMessage(args) {
    const inline = readStringFlag(args, 'msg');
    const fromFile = readStringFlag(args, 'msg-file');
    if (inline === undefined && fromFile === undefined) {
        throw new UsageError('缺少消息内容：请用 --msg <内容> 或 --msg-file <路径>');
    }
    if (inline !== undefined && fromFile !== undefined) {
        throw new UsageError('--msg 与 --msg-file 只能使用其中一个');
    }
    if (inline !== undefined)
        return inline;
    const path = fromFile;
    try {
        return path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UsageError(`无法读取消息文件 ${path}：${message}`);
    }
}
function requireAbsoluteHttpUrl(label, value) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new UsageError(`${label} 必须是绝对 URL，收到 "${value}"`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new UsageError(`${label} 只支持 http/https，收到 "${value}"`);
    }
    if (/[\u0000-\u0020\u007F]/.test(value)) {
        throw new UsageError(`${label} 不能包含空格或控制字符，收到 "${value}"`);
    }
    // Send the normalised form: what was validated must be what is transmitted.
    return parsed.href;
}
function requireTimeout(value, label) {
    if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
        throw new UsageError(`${label} 必须是 1..${MAX_TIMEOUT_MS} 之间的整数（毫秒）`);
    }
    return value;
}
function buildSendOptions(args, forceDryRun) {
    const nickname = readStringFlag(args, 'to');
    if (nickname === undefined || nickname.trim() === '') {
        throw new UsageError('缺少接收者昵称：请用 --to <昵称>');
    }
    if (nickname.includes('/')) {
        throw new UsageError('昵称不能包含斜杠 /（接口要求）');
    }
    if (/[\u0000-\u001F\u007F]/.test(nickname)) {
        throw new UsageError('昵称不能包含控制字符');
    }
    rejectDotSegment('昵称', nickname);
    const msg = readMessage(args);
    if (msg.length === 0) {
        throw new UsageError('消息内容不能为空（服务端会返回 400）');
    }
    const title = readStringFlag(args, 'title');
    if (title !== undefined && title.length === 0) {
        throw new UsageError('标题不能为空字符串；如需使用默认标题请省略 --title');
    }
    if (title !== undefined)
        rejectDotSegment('标题', title);
    const msgType = (readStringFlag(args, 'type') ?? 'text');
    const htmlHeightGiven = args.values['html-height'] !== undefined;
    if (msgType !== 'html' && htmlHeightGiven) {
        throw new UsageError('--html-height 仅在 --type html 时有效');
    }
    let htmlHeight;
    if (msgType === 'html') {
        htmlHeight = readIntegerFlag(args, 'html-height', DEFAULT_HTML_HEIGHT);
        if (!Number.isInteger(htmlHeight) || htmlHeight <= 0 || htmlHeight > MAX_HTML_HEIGHT) {
            throw new UsageError(`--html-height 必须是 1..${MAX_HTML_HEIGHT} 之间的整数（像素）`);
        }
    }
    const method = (readStringFlag(args, 'method') ?? 'post').toUpperCase();
    // GET puts the message in the URL path, where "." / ".." would be dropped.
    if (method === 'GET')
        rejectDotSegment('消息内容（GET 时进入 URL 路径）', msg);
    const formatGiven = args.values['format'] !== undefined;
    if (method === 'GET' && formatGiven) {
        throw new UsageError('--format 仅对 POST 有效；GET 请改用 --method post');
    }
    const format = (readStringFlag(args, 'format') ?? 'json');
    const timeoutMs = requireTimeout(readIntegerFlag(args, 'timeout', DEFAULT_TIMEOUT_MS), '--timeout');
    const baseUrl = normalizeBaseUrl(readStringFlag(args, 'base-url') ?? DEFAULT_BASE_URL, readBooleanFlag(args, 'allow-http'));
    const url = readStringFlag(args, 'url');
    const imgUrl = readStringFlag(args, 'img-url');
    const options = {
        nickname,
        title: title ?? DEFAULT_TITLE,
        msg,
        url: url === undefined ? undefined : requireAbsoluteHttpUrl('--url', url),
        imgUrl: imgUrl === undefined ? undefined : requireAbsoluteHttpUrl('--img-url', imgUrl),
        msgType,
        htmlHeight,
        method,
        format,
        baseUrl,
        timeoutMs,
    };
    return { options, dryRun: forceDryRun || readBooleanFlag(args, 'dry-run') };
}
function describeShape(options) {
    const bits = [options.method, options.format.toLowerCase()];
    bits.push(options.msgType === 'html' ? `html/${String(options.htmlHeight)}px` : 'text');
    bits.push(`标题「${options.title}」`);
    return bits.join(' · ');
}
function renderRequest(request) {
    const lines = [`  ${request.method} ${request.url}`];
    for (const [key, value] of Object.entries(request.headers)) {
        lines.push(`  ${key}: ${value}`);
    }
    if (request.body !== undefined) {
        lines.push(`  body: ${request.body}`);
    }
    return lines.join('\n');
}
function renderWarnings(warnings, json) {
    for (const warning of warnings) {
        note(`[!] ${warning.text}`, json);
    }
}
function printSendResult(result, options, request, warnings, json) {
    if (json) {
        outputJson({
            tool: TOOL,
            version: readVersion(),
            command: 'send',
            ok: result.outcome === 'success',
            outcome: result.outcome,
            confirmed: result.confirmed,
            exitCode: result.exitCode,
            dryRun: false,
            recipient: options.nickname,
            title: options.title,
            msgType: options.msgType,
            htmlHeight: options.htmlHeight ?? null,
            httpStatus: result.httpStatus,
            envelope: result.envelope,
            serverMessage: result.serverMessage,
            reason: result.reason,
            detail: result.detail,
            request: {
                method: request.method,
                url: request.url,
                headers: request.headers,
                body: request.body ?? null,
            },
            warnings,
        });
        return;
    }
    const label = result.outcome === 'success'
        ? result.confirmed
            ? '[ok]  推送成功（服务端已确认）'
            : '[ok]  推送已受理（服务端未返回 data 确认字段）'
        : result.outcome === 'rejected'
            ? '[!]   推送被拒绝'
            : result.outcome === 'rate_limited'
                ? '[!]   推送被限流'
                : result.outcome === 'unconfirmed'
                    ? '[?]   推送结果无法确认'
                    : '[?]   推送结果不确定';
    const lines = [label];
    lines.push(`  接收者  ${options.nickname}`);
    lines.push(`  标题    ${options.title}`);
    lines.push(`  形状    ${describeShape(options)}`);
    lines.push(`  接口    ${request.method} ${request.url}`);
    if (result.envelope !== null) {
        const parts = [`status=${String(result.envelope.status)}`];
        if (result.envelope.data !== null)
            parts.push(`data=${String(result.envelope.data)}`);
        const text = result.serverMessage;
        lines.push(`  响应    ${parts.join(' ')}${text === null ? '' : ` 「${text}」`}`);
    }
    else if (result.httpStatus !== null) {
        lines.push(`  响应    HTTP ${result.httpStatus}（无可用 JSON 信封）`);
    }
    lines.push(`  说明    ${result.detail}`);
    process.stdout.write(`${lines.join('\n')}\n`);
}
function printPreview(options, request, warnings, json) {
    if (json) {
        outputJson({
            tool: TOOL,
            version: readVersion(),
            command: 'preview',
            ok: true,
            outcome: 'preview',
            confirmed: false,
            exitCode: EXIT.OK,
            dryRun: true,
            recipient: options.nickname,
            title: options.title,
            msgType: options.msgType,
            htmlHeight: options.htmlHeight ?? null,
            request: {
                method: request.method,
                url: request.url,
                headers: request.headers,
                body: request.body ?? null,
            },
            warnings,
        });
        return;
    }
    process.stdout.write(`[dry-run] 仅预览，未发出任何请求\n${renderRequest(request)}\n`);
}
async function runSend(argv, forceDryRun) {
    const args = parseArgs(argv, [...SEND_FLAGS, ...GLOBAL_FLAGS]);
    const json = readBooleanFlag(args, 'json');
    if (readBooleanFlag(args, 'help')) {
        process.stdout.write(HELP);
        return EXIT.OK;
    }
    if (readBooleanFlag(args, 'version')) {
        process.stdout.write(`${readVersion()}\n`);
        return EXIT.OK;
    }
    if (args.positionals.length > 0) {
        throw new UsageError(`多余的参数：${args.positionals.join(' ')}`);
    }
    const { options, dryRun } = buildSendOptions(args, forceDryRun);
    const { request, warnings } = buildRequest(options);
    if (dryRun) {
        printPreview(options, request, warnings, json);
        renderWarnings(warnings, json);
        return EXIT.OK;
    }
    const result = await sendPush(request, options.timeoutMs);
    printSendResult(result, options, request, warnings, json);
    renderWarnings(warnings, json);
    return result.exitCode;
}
async function runDoctor(argv) {
    const args = parseArgs(argv, [...DOCTOR_FLAGS, ...GLOBAL_FLAGS]);
    const json = readBooleanFlag(args, 'json');
    if (readBooleanFlag(args, 'help')) {
        process.stdout.write(HELP);
        return EXIT.OK;
    }
    if (readBooleanFlag(args, 'version')) {
        process.stdout.write(`${readVersion()}\n`);
        return EXIT.OK;
    }
    if (args.positionals.length > 0) {
        throw new UsageError(`多余的参数：${args.positionals.join(' ')}`);
    }
    const baseUrl = normalizeBaseUrl(readStringFlag(args, 'base-url') ?? DEFAULT_BASE_URL, readBooleanFlag(args, 'allow-http'));
    const timeoutMs = requireTimeout(readIntegerFlag(args, 'timeout', DEFAULT_TIMEOUT_MS), '--timeout');
    const checks = [];
    const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    checks.push({
        name: 'node_version',
        ok: major >= 20,
        detail: `Node ${process.versions.node}${major >= 20 ? '' : '（需要 >= 20）'}`,
    });
    checks.push({
        name: 'base_url',
        ok: true,
        detail: baseUrl,
    });
    checks.push({
        name: 'transport',
        ok: baseUrl.startsWith('https://'),
        detail: baseUrl.startsWith('https://')
            ? 'HTTPS'
            : '明文 HTTP：消息内容不会被加密，仅建议自建调试服务使用',
    });
    let probe = null;
    let exitCode = EXIT.OK;
    if (readBooleanFlag(args, 'probe')) {
        const outcome = await probeEndpoint(baseUrl, timeoutMs);
        const bizStatus = outcome.envelope?.status ?? null;
        const restricted = bizStatus === 429 && (outcome.envelope?.msg ?? '').includes('IP');
        probe = {
            url: `${baseUrl}/`,
            httpStatus: outcome.httpStatus,
            envelope: outcome.envelope,
            error: outcome.error,
            /** Whether the root response carried a recognisable MeoW business status. */
            envelopeRecognised: bizStatus !== null,
            ipRestricted: restricted,
        };
        if (outcome.error !== null) {
            checks.push({ name: 'probe', ok: false, detail: `无法连接：${outcome.error}` });
            exitCode = EXIT.UNKNOWN;
        }
        else if (restricted) {
            checks.push({
                name: 'probe',
                ok: false,
                detail: '出口 IP 被限制：服务端返回「IP限制，请联系开发者」。推送大概率失败，请更换可信 IP 或申请白名单。',
            });
            exitCode = EXIT.RATE_LIMITED;
        }
        else if (bizStatus === null) {
            // Reaching a host is not the same as reaching the MeoW API: without a
            // parseable envelope the IP restriction cannot be assessed at all.
            checks.push({
                name: 'probe',
                ok: false,
                detail: `根路径返回了 HTTP ${String(outcome.httpStatus)} 但没有可解析的 API 信封，` +
                    '无法判断这是否为 MeoW 接口、也无法判断 IP 是否受限。请确认 --base-url 是否正确。',
            });
            exitCode = EXIT.UNKNOWN;
        }
        else if (outcome.httpStatus !== null && outcome.httpStatus >= 500) {
            checks.push({ name: 'probe', ok: false, detail: `HTTP ${outcome.httpStatus}` });
            exitCode = EXIT.UNKNOWN;
        }
        else {
            checks.push({
                name: 'probe',
                ok: true,
                detail: `已连通（HTTP ${String(outcome.httpStatus)}，业务 status=${String(bizStatus)}）。` +
                    '根路径探测不能证明昵称已注册，也不能证明一次真实推送会成功。',
            });
        }
    }
    if (json) {
        outputJson({
            tool: TOOL,
            version: readVersion(),
            command: 'doctor',
            ok: checks.every((c) => c.ok),
            exitCode,
            baseUrl,
            timeoutMs,
            node: process.versions.node,
            checks,
            probe,
        });
        return exitCode;
    }
    const lines = [`meow-push ${readVersion()} 自检`];
    for (const check of checks) {
        lines.push(`  ${check.ok ? '[ok]' : '[!] '} ${check.name.padEnd(14)}${check.detail}`);
    }
    if (!readBooleanFlag(args, 'probe')) {
        lines.push('  提示   加 --probe 可检查连通性与出口 IP 限制（不会推送消息）');
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return exitCode;
}
function runSchema(argv) {
    const args = parseArgs(argv, [...GLOBAL_FLAGS, JSON_FLAG]);
    if (readBooleanFlag(args, 'help')) {
        process.stdout.write(HELP);
        return EXIT.OK;
    }
    if (readBooleanFlag(args, 'version')) {
        process.stdout.write(`${readVersion()}\n`);
        return EXIT.OK;
    }
    if (args.positionals.length > 0) {
        throw new UsageError(`schema 不接受额外参数：${args.positionals.join(' ')}`);
    }
    outputJson({
        tool: TOOL,
        version: readVersion(),
        api: {
            doc: 'https://www.chuckfang.com/MeoW/api_doc.html',
            baseUrl: DEFAULT_BASE_URL,
            endpoints: {
                get_with_title: 'GET /{nickname}/{title}/{msg}?msgType&htmlHeight&url&imgUrl',
                get_without_title: 'GET /{nickname}/{msg}?msgType&htmlHeight&url&imgUrl',
                post: 'POST /{nickname}/{title}?msgType&htmlHeight  body: title,msg,url,imgUrl',
            },
            successRule: 'JSON envelope status===200 且 data===true 才算确认送达',
            businessCodes: {
                200: '成功',
                400: '标题或消息参数错误',
                403: '内容策略禁止发送',
                404: '昵称未注册',
                429: '发送或 IP 频率超限',
                500: '服务器错误',
            },
            httpStatusNote: 'HTTP 状态码恒为 200，业务结果只看 JSON 的 status 字段',
        },
        commands: {
            send: {
                summary: '实际推送一条消息（不可幂等，失败不做自动重试）',
                flags: describeFlags([...SEND_FLAGS, ...GLOBAL_FLAGS]),
            },
            preview: {
                summary: '等价于 send --dry-run：只构造并打印请求',
                flags: describeFlags([...SEND_FLAGS, ...GLOBAL_FLAGS]),
            },
            doctor: {
                summary: '环境与连通性自检；--probe 请求 API 根路径，不会推送',
                flags: describeFlags([...DOCTOR_FLAGS, ...GLOBAL_FLAGS]),
            },
            schema: { summary: '输出本 JSON', flags: describeFlags(GLOBAL_FLAGS) },
        },
        exitCodes: EXIT_CODE_DOC,
        limits: {
            nonMember: '3 秒 1 条、每分钟 15 条、每小时 60 条、每天 1000 条',
            ipNotice: '不要使用多人共享的公共出口 IP；可信 IP 可向开发者申请白名单',
        },
    });
    return EXIT.OK;
}
async function run(argv) {
    const jsonRequested = argv.includes('--json');
    const command = argv[0];
    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
        process.stdout.write(HELP);
        return EXIT.OK;
    }
    if (command === '--version' || command === '-V' || command === 'version') {
        process.stdout.write(`${readVersion()}\n`);
        return EXIT.OK;
    }
    const rest = argv.slice(1);
    if (command === 'send')
        return runSend(rest, false);
    if (command === 'preview' || command === 'dry-run')
        return runSend(rest, true);
    if (command === 'doctor')
        return runDoctor(rest);
    if (command === 'schema')
        return runSchema(rest);
    if (jsonRequested) {
        outputJson({
            tool: TOOL,
            ok: false,
            outcome: 'usage_error',
            exitCode: EXIT.USAGE,
            error: `未知子命令 "${command}"；可用：send | preview | doctor | schema | help`,
        });
        return EXIT.USAGE;
    }
    process.stderr.write(`未知子命令 "${command}"；可用：send | preview | doctor | schema | help\n\n${HELP}`);
    return EXIT.USAGE;
}
/**
 * Total entry point: always resolves to a process exit code and never throws.
 * Keeping it side-effect free lets `scripts/test.mjs` drive the real CLI
 * in-process while `src/main.ts` supplies the executable wrapper.
 */
export async function main(argv) {
    const json = argv.includes('--json');
    try {
        return await run(argv);
    }
    catch (error) {
        if (error instanceof UsageError) {
            if (json) {
                outputJson({
                    tool: TOOL,
                    ok: false,
                    outcome: 'usage_error',
                    exitCode: EXIT.USAGE,
                    error: error.message,
                });
            }
            else {
                process.stderr.write(`参数错误：${error.message}\n\n用 meow-push help 查看用法。\n`);
            }
            return EXIT.USAGE;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (json) {
            outputJson({
                tool: TOOL,
                ok: false,
                outcome: 'internal_error',
                exitCode: EXIT.UNKNOWN,
                error: message,
            });
        }
        else {
            process.stderr.write(`内部错误：${message}\n`);
        }
        return EXIT.UNKNOWN;
    }
}
//# sourceMappingURL=cli.js.map