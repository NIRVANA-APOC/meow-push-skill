#!/usr/bin/env node
/**
 * End-to-end tests for the meow-push CLI.
 *
 * The CLI is driven in-process through its exported `main()`, with stdout and
 * stderr captured, against the local mock API in `mock-server.mjs`. Nothing
 * here touches the real MeoW service, so the suite is safe to run any time and
 * needs no credentials, no network and no registered nickname.
 *
 *   node scripts/test.mjs
 *
 * Requires `npm run build` first (the suite loads dist/cli.js).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { main } from '../dist/cli.js';
import { createMockServer } from './mock-server.mjs';

const results = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
}

async function test(name, fn) {
  try {
    await fn();
    results.push({ group: currentGroup, name, ok: true, error: null });
  } catch (error) {
    results.push({
      group: currentGroup,
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: 期望 ${b}，实际 ${a}`);
}

/** Strip the origin from an absolute URL, keeping path + query verbatim. */
function pathAndQuery(absoluteUrl) {
  const parsed = new URL(absoluteUrl);
  return `${parsed.pathname}${parsed.search}`;
}

/** Run the CLI in-process, capturing both streams. */
async function runCli(argv) {
  const out = [];
  const err = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (chunk) => {
    out.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    err.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  let code;
  try {
    code = await main(argv);
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return { code, stdout: out.join(''), stderr: err.join('') };
}

/**
 * Start a mock server, run the CLI against it, then shut it down.
 * Every send path must produce exactly one request: pushes are not idempotent.
 */
async function withMock(options, argv, { expectRequestCount = 1 } = {}) {
  const mock = createMockServer(options);
  const origin = await mock.listen(0);
  try {
    const result = await runCli([
      ...argv.slice(0, 1),
      ...argv.slice(1),
      '--base-url',
      origin,
      '--allow-http',
      '--timeout',
      '3000',
    ]);
    if (mock.requests.length !== expectRequestCount) {
      throw new Error(
        `请求数应为 ${expectRequestCount}，实际 ${mock.requests.length}（推送不可幂等）`,
      );
    }
    return { ...result, requests: mock.requests, origin };
  } finally {
    await mock.close();
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };

// ---------------------------------------------------------------------------
// 1. Request construction
// ---------------------------------------------------------------------------

group('请求构造');

await test('默认 POST：路径含昵称与标题，msgType 在查询串，标题与消息在 JSON body', async () => {
  const { code, requests } = await withMock({ status: 200 }, [
    'send',
    '--to',
    '张三',
    '--title',
    '系统通知',
    '--msg',
    '你好',
    '--json',
  ]);
  assertEqual(code, 0, 'exit code');
  assertEqual(requests.length, 1, '请求数');
  const req = requests[0];
  assertEqual(req.method, 'POST', 'method');
  assertEqual(
    req.url,
    `/${encodeURIComponent('张三')}/${encodeURIComponent('系统通知')}?msgType=text`,
    'path+query',
  );
  assertEqual(req.headers['content-type'], 'application/json; charset=utf-8', 'content-type');
  assertEqual(JSON.parse(req.body), { title: '系统通知', msg: '你好' }, 'json body');
});

await test('省略 --title 时使用文档默认标题 MeoW（不落入未文档化的 POST 路径）', async () => {
  const { code, requests } = await withMock({ status: 200 }, [
    'send',
    '--to',
    'demo',
    '--msg',
    'hi',
    '--json',
  ]);
  assertEqual(code, 0, 'exit code');
  assertEqual(requests[0].url, '/demo/MeoW?msgType=text', 'path+query');
  assertEqual(JSON.parse(requests[0].body), { title: 'MeoW', msg: 'hi' }, 'json body');
});

await test('--type html 时 msgType 与 htmlHeight 只出现在查询串，不进入 body', async () => {
  const { requests } = await withMock({ status: 200 }, [
    'send',
    '--to',
    'demo',
    '--msg',
    '<b>x</b>',
    '--type',
    'html',
    '--html-height',
    '350',
    '--json',
  ]);
  assertEqual(requests[0].url, '/demo/MeoW?msgType=html&htmlHeight=350', 'path+query');
  const body = JSON.parse(requests[0].body);
  assertEqual(body.msgType, undefined, 'body 不应包含 msgType');
  assertEqual(body.htmlHeight, undefined, 'body 不应包含 htmlHeight');
});

await test('--type html 未指定高度时显式采用文档默认值 200', async () => {
  const { stdout } = await withMock({ status: 200 }, [
    'send',
    '--to',
    'demo',
    '--msg',
    '<b>x</b>',
    '--type',
    'html',
    '--json',
  ]);
  const payload = JSON.parse(stdout);
  assertEqual(pathAndQuery(payload.request.url), '/demo/MeoW?msgType=html&htmlHeight=200', 'path+query');
  assertEqual(payload.htmlHeight, 200, '生效高度');
});

await test('GET：内容进入路径段，url/imgUrl 进入查询串并正确编码', async () => {
  const { requests } = await withMock({ status: 200 }, [
    'send',
    '--to',
    'demo',
    '--title',
    'T',
    '--msg',
    'hello world',
    '--method',
    'get',
    '--url',
    'https://example.com/a?b=1&c=2',
    '--img-url',
    'https://example.com/i.png',
    '--json',
  ]);
  const req = requests[0];
  assertEqual(req.method, 'GET', 'method');
  assertEqual(req.body, '', 'GET 不应有 body');
  assertEqual(
    req.url,
    '/demo/T/hello%20world?msgType=text' +
      '&url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2' +
      '&imgUrl=https%3A%2F%2Fexample.com%2Fi.png',
    'path+query',
  );
});

await test('POST form 编码', async () => {
  const { requests } = await withMock({ status: 200 }, [
    'send',
    '--to',
    'demo',
    '--title',
    'A B',
    '--msg',
    'x&y',
    '--format',
    'form',
    '--json',
  ]);
  assertEqual(
    requests[0].headers['content-type'],
    'application/x-www-form-urlencoded; charset=utf-8',
    'content-type',
  );
  assertEqual(requests[0].body, 'title=A%20B&msg=x%26y', 'form body');
});

await test('POST text/plain：body 即消息原文，标题在路径，url 在查询串', async () => {
  const { requests } = await withMock({ status: 200 }, [
    'send',
    '--to',
    'demo',
    '--title',
    'T',
    '--msg',
    'line1\n"quoted" <b>',
    '--format',
    'text',
    '--url',
    'https://e.com',
    '--json',
  ]);
  const req = requests[0];
  assertEqual(req.headers['content-type'], 'text/plain; charset=utf-8', 'content-type');
  assertEqual(req.body, 'line1\n"quoted" <b>', 'body 应为消息原文');
  assertEqual(req.url, '/demo/T?msgType=text&url=https%3A%2F%2Fe.com%2F', 'path+query');
});

await test('严格 RFC3986 编码：!/()*\' 与空格、& = ? 都被转义，body 保留原文', async () => {
  const { stdout } = await withMock({ status: 200 }, [
    'send',
    '--to',
    "a!()*'b",
    '--title',
    't&t=?',
    '--msg',
    '#中文 空格',
    '--json',
  ]);
  const { request } = JSON.parse(stdout);
  assertEqual(pathAndQuery(request.url), "/a%21%28%29%2A%27b/t%26t%3D%3F?msgType=text", '路径编码');
  assertEqual(JSON.parse(request.body).msg, '#中文 空格', 'body 保留原文');
});

await test('GET 时消息内容按段转义，含 / 的内容不会拆成新路径段', async () => {
  const { requests } = await withMock({ status: 200 }, [
    'send',
    '--to',
    'demo',
    '--title',
    'T',
    '--msg',
    'a/b?c#d',
    '--method',
    'get',
    '--json',
  ]);
  assertEqual(requests[0].url, '/demo/T/a%2Fb%3Fc%23d?msgType=text', 'path+query');
});

await test('预览/--json 报告的 URL 与实际发出的 URL 一致（"." / ".." 不得被规范化改写）', async () => {
  // A path segment of "." or ".." is deleted by the WHATWG URL parser, so the
  // wire path would silently differ from the reported one.
  const cases = [
    { name: '昵称为 ..', argv: ['send', '--to', '..', '--msg', 'hi'] },
    { name: '昵称为 .', argv: ['send', '--to', '.', '--msg', 'hi'] },
    { name: '标题为 ..', argv: ['send', '--to', 'demo', '--msg', 'hi', '--title', '..'] },
    { name: '标题为 .', argv: ['send', '--to', 'demo', '--msg', 'hi', '--title', '.'] },
  ];
  for (const c of cases) {
    const mock = createMockServer({ status: 200 });
    const origin = await mock.listen(0);
    try {
      const { code, stdout } = await runCli([
        ...c.argv,
        '--base-url',
        origin,
        '--allow-http',
        '--json',
      ]);
      assertEqual(code, 1, `${c.name} 的退出码应为 1`);
      assertEqual(mock.requests.length, 0, `${c.name} 不得发出请求`);
      const payload = JSON.parse(stdout);
      assert(
        /不能是 "\." 或 "\.\."/.test(payload.error),
        `${c.name} 应给出 "." / ".." 的专门错误，实际：${payload.error}`,
      );
    } finally {
      await mock.close();
    }
  }
});

await test('GET 时消息为 "." 或 ".." 同样被本地拒绝', async () => {
  for (const msg of ['.', '..']) {
    const mock = createMockServer({ status: 200 });
    const origin = await mock.listen(0);
    try {
      const { code, stdout } = await runCli([
        'send',
        '--to',
        'demo',
        '--msg',
        msg,
        '--method',
        'get',
        '--base-url',
        origin,
        '--allow-http',
        '--json',
      ]);
      assertEqual(code, 1, `--msg ${msg} 的退出码`);
      assertEqual(mock.requests.length, 0, '不得发出请求');
      assert(JSON.parse(stdout).error.includes('路径段'), '应说明路径段原因');
    } finally {
      await mock.close();
    }
  }
});

await test('POST 时消息为 "." 是合法内容（只有 GET 才把它放进路径）', async () => {
  const { code, requests } = await withMock({ status: 200 }, [
    'send',
    '--to',
    'demo',
    '--msg',
    '.',
    '--json',
  ]);
  assertEqual(code, 0, 'exit code');
  assertEqual(JSON.parse(requests[0].body).msg, '.', 'body 中的消息');
});

await test('--url / --img-url 发送规范化后的值，而不是原始字符串', async () => {
  const { stdout } = await withMock({ status: 200 }, [
    'send',
    '--to',
    'demo',
    '--msg',
    'hi',
    '--url',
    'https://Example.COM:443/a/../b',
    '--json',
  ]);
  const body = JSON.parse(JSON.parse(stdout).request.body);
  assertEqual(body.url, 'https://example.com/b', '规范化后的 URL');
});

await test('--url 含空格或控制字符时本地拒绝', async () => {
  for (const bad of [' https://e.com/x ', 'https://e.com/a\tb']) {
    const mock = createMockServer({ status: 200 });
    const origin = await mock.listen(0);
    try {
      const { code } = await runCli([
        'send',
        '--to',
        'demo',
        '--msg',
        'hi',
        '--url',
        bad,
        '--base-url',
        origin,
        '--allow-http',
        '--json',
      ]);
      assertEqual(code, 1, `--url ${JSON.stringify(bad)} 的退出码`);
      assertEqual(mock.requests.length, 0, '不得发出请求');
    } finally {
      await mock.close();
    }
  }
});

await test('--msg-file 原样读取文件内容（含引号、换行、HTML）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'meow-msg-'));
  const file = path.join(dir, 'notice.html');
  const content = '<p class="a">\n  "带引号" & <b>换行</b>\n</p>';
  writeFileSync(file, content, 'utf8');
  try {
    const { requests } = await withMock({ status: 200 }, [
      'send',
      '--to',
      'demo',
      '--msg-file',
      file,
      '--type',
      'html',
      '--json',
    ]);
    assertEqual(JSON.parse(requests[0].body).msg, content, '文件内容应原样传输');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('dry-run 不发出任何请求', async () => {
  const mock = createMockServer({ status: 200 });
  const origin = await mock.listen(0);
  try {
    const { code, stdout } = await runCli([
      'preview',
      '--to',
      'demo',
      '--msg',
      'hi',
      '--base-url',
      origin,
      '--allow-http',
      '--json',
    ]);
    assertEqual(code, 0, 'exit code');
    assertEqual(mock.requests.length, 0, '请求数必须为 0');
    const payload = JSON.parse(stdout);
    assertEqual(payload.dryRun, true, 'dryRun 标记');
    assertEqual(payload.request.method, 'POST', 'method');
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Response classification and exit codes
// ---------------------------------------------------------------------------

group('响应分类与退出码');

const replyCases = [
  { name: 'status=200 data=true → 0 且 confirmed', status: 200, exit: 0, outcome: 'success', confirmed: true },
  { name: 'status=400 → 3 rejected', status: 400, exit: 3, outcome: 'rejected', confirmed: false },
  { name: 'status=403 → 3 rejected', status: 403, exit: 3, outcome: 'rejected', confirmed: false },
  { name: 'status=404 → 3 rejected', status: 404, exit: 3, outcome: 'rejected', confirmed: false },
  { name: 'status=429 → 4 rate_limited', status: 429, exit: 4, outcome: 'rate_limited', confirmed: false },
  { name: 'status=500 → 2 unknown', status: 500, exit: 2, outcome: 'unknown', confirmed: false },
];

for (const c of replyCases) {
  await test(c.name, async () => {
    const { code, stdout } = await withMock({ status: c.status }, [
      'send',
      '--to',
      'demo',
      '--msg',
      'hi',
      '--json',
    ]);
    assertEqual(code, c.exit, 'exit code');
    const payload = JSON.parse(stdout);
    assertEqual(payload.outcome, c.outcome, 'outcome');
    assertEqual(payload.confirmed, c.confirmed, 'confirmed');
    assertEqual(payload.ok, c.outcome === 'success', 'ok');
  });
}

await test('status=200 但 data=false → 5 unconfirmed（自相矛盾，不算成功）', async () => {
  const { code, stdout } = await withMock({ rawBody: '{"status":200,"data":false,"msg":"?"}' }, [
    'send',
    '--to',
    'demo',
    '--msg',
    'hi',
    '--json',
  ]);
  assertEqual(code, 5, 'exit code');
  const payload = JSON.parse(stdout);
  assertEqual(payload.outcome, 'unconfirmed', 'outcome');
  assertEqual(payload.reason, 'status_200_data_false', 'reason');
});

await test('兼容旧式信封 {status:200,message:...} → 0 但 confirmed=false', async () => {
  const { code, stdout } = await withMock({ rawBody: '{"status":200,"message":"推送成功"}' }, [
    'send',
    '--to',
    'demo',
    '--msg',
    'hi',
    '--json',
  ]);
  assertEqual(code, 0, 'exit code');
  const payload = JSON.parse(stdout);
  assertEqual(payload.confirmed, false, 'confirmed');
  assertEqual(payload.reason, 'success_without_data_field', 'reason');
  assertEqual(payload.serverMessage, '推送成功', 'serverMessage 应回落到 message 字段');
});

await test('非 JSON 响应 → 2 unknown', async () => {
  const { code, stdout } = await withMock({ rawBody: '<html>502 Bad Gateway</html>' }, [
    'send',
    '--to',
    'demo',
    '--msg',
    'hi',
    '--json',
  ]);
  assertEqual(code, 2, 'exit code');
  assertEqual(JSON.parse(stdout).reason, 'non_json_response', 'reason');
});

await test('JSON 但缺少 status → 2 unknown', async () => {
  const { code, stdout } = await withMock({ rawBody: '{"hello":"world"}' }, [
    'send',
    '--to',
    'demo',
    '--msg',
    'hi',
    '--json',
  ]);
  assertEqual(code, 2, 'exit code');
  assertEqual(JSON.parse(stdout).reason, 'unrecognised_envelope', 'reason');
});

await test('HTTP 5xx（网关层）→ 2 unknown，即使 body 是合法信封', async () => {
  const { code, stdout } = await withMock(
    { status: 200, httpStatus: 503 },
    ['send', '--to', 'demo', '--msg', 'hi', '--json'],
  );
  assertEqual(code, 2, 'exit code');
  assertEqual(JSON.parse(stdout).reason, 'http_server_error', 'reason');
});

await test('HTTP 4xx 与业务 status=200 冲突 → 2 unknown，不当作成功', async () => {
  const { code, stdout } = await withMock(
    { rawBody: '{"status":200,"data":true,"msg":"发送成功"}', httpStatus: 403 },
    ['send', '--to', 'demo', '--msg', 'hi', '--json'],
  );
  assertEqual(code, 2, 'exit code');
  const payload = JSON.parse(stdout);
  assertEqual(payload.reason, 'http_status_conflict', 'reason');
  assertEqual(payload.outcome, 'unknown', 'outcome');
});

await test('重定向 → 2 unknown，不跟随（避免重复投递或 301/302/303 丢失请求体）', async () => {
  const mock = createMockServer({ status: 200, redirectTo: '/elsewhere' });
  const origin = await mock.listen(0);
  try {
    const { code, stdout } = await runCli([
      'send',
      '--to',
      'demo',
      '--msg',
      'hi',
      '--base-url',
      origin,
      '--allow-http',
      '--json',
    ]);
    assertEqual(code, 2, 'exit code');
    assertEqual(JSON.parse(stdout).reason, 'redirect_not_followed', 'reason');
    assertEqual(mock.requests.length, 1, '只应发出一次请求，且不跟随到新地址');
    assert(!mock.requests.some((r) => r.url === '/elsewhere'), '不得请求重定向目标');
  } finally {
    await mock.close();
  }
});

await test('业务状态码以数字字符串给出时仍可识别', async () => {
  const { code, stdout } = await withMock({ rawBody: '{"status":"200","data":"true"}' }, [
    'send',
    '--to',
    'demo',
    '--msg',
    'hi',
    '--json',
  ]);
  assertEqual(code, 0, 'exit code');
  const payload = JSON.parse(stdout);
  assertEqual(payload.confirmed, true, 'confirmed');
});

await test('响应体是 JSON 但不是对象（数组/字面量）→ 2 unknown', async () => {
  for (const body of ['[]', 'null', '42', '"ok"']) {
    const { code } = await withMock({ rawBody: body }, [
      'send',
      '--to',
      'demo',
      '--msg',
      'hi',
      '--json',
    ]);
    assertEqual(code, 2, `body=${body} 的 exit code`);
  }
});

await test('连接被拒绝 → 2 unknown，不重试', async () => {
  // Bind then release a port so that connecting to it is refused immediately.
  const mock = createMockServer({ status: 200 });
  const origin = await mock.listen(0);
  await mock.close();
  const { code, stdout } = await runCli([
    'send',
    '--to',
    'demo',
    '--msg',
    'hi',
    '--base-url',
    origin,
    '--allow-http',
    '--timeout',
    '3000',
    '--json',
  ]);
  assertEqual(code, 2, 'exit code');
  assertEqual(JSON.parse(stdout).reason, 'network_error', 'reason');
});

await test('超时 → 2 unknown，且只发出一次请求', async () => {
  const mock = createMockServer({ status: 200, delayMs: 1500 });
  const origin = await mock.listen(0);
  try {
    const { code, stdout } = await runCli([
      'send',
      '--to',
      'demo',
      '--msg',
      'hi',
      '--base-url',
      origin,
      '--allow-http',
      '--timeout',
      '150',
      '--json',
    ]);
    assertEqual(code, 2, 'exit code');
    assertEqual(JSON.parse(stdout).reason, 'timeout', 'reason');
    assertEqual(mock.requests.length, 1, '超时后不得重试');
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Argument validation: every case must fail locally without any request
// ---------------------------------------------------------------------------

group('参数校验（必须本地失败且不发请求）');

const usageCases = [
  { name: '缺少 --to', argv: ['send', '--msg', 'hi'], error: '缺少接收者昵称' },
  { name: '缺少消息内容', argv: ['send', '--to', 'demo'], error: '缺少消息内容' },
  { name: '同时给出 --msg 与 --msg-file', argv: ['send', '--to', 'demo', '--msg', 'a', '--msg-file', 'b'], error: '只能使用其中一个' },
  { name: '空消息', argv: ['send', '--to', 'demo', '--msg', ''], error: '消息内容不能为空' },
  { name: '昵称含斜杠', argv: ['send', '--to', 'a/b', '--msg', 'hi'], error: '昵称不能包含斜杠' },
  { name: '空白昵称', argv: ['send', '--to', '   ', '--msg', 'hi'], error: '缺少接收者昵称' },
  { name: '空标题', argv: ['send', '--to', 'demo', '--msg', 'hi', '--title', ''], error: '标题不能为空字符串' },
  { name: '--html-height 与 text 同用', argv: ['send', '--to', 'demo', '--msg', 'hi', '--html-height', '300'], error: '仅在 --type html 时有效' },
  { name: '--format 与 GET 同用', argv: ['send', '--to', 'demo', '--msg', 'hi', '--method', 'get', '--format', 'json'], error: '仅对 POST 有效' },
  { name: '非法 --type', argv: ['send', '--to', 'demo', '--msg', 'hi', '--type', 'markdown'], error: '只接受 text | html' },
  { name: '非法 --method', argv: ['send', '--to', 'demo', '--msg', 'hi', '--method', 'put'], error: '只接受 post | get' },
  { name: '相对 URL 的 --url', argv: ['send', '--to', 'demo', '--msg', 'hi', '--url', '/a/b'], error: '必须是绝对 URL' },
  { name: '非 http 协议的 --url', argv: ['send', '--to', 'demo', '--msg', 'hi', '--url', 'ftp://x/y'], error: '只支持 http/https' },
  { name: '未知参数', argv: ['send', '--to', 'demo', '--msg', 'hi', '--nope', '1'], error: '未知参数' },
  { name: '重复参数', argv: ['send', '--to', 'demo', '--to', 'x', '--msg', 'hi'], error: '重复出现' },
  { name: '取值缺失且下一个参数是选项', argv: ['send', '--to', 'demo', '--msg', 'hi', '--title', '--dry-run'], error: '缺少取值' },
  { name: '--timeout 非正数', argv: ['send', '--to', 'demo', '--msg', 'hi', '--timeout', '0'], error: '必须是 1..' },
  { name: '--timeout 超出 AbortSignal 上限', argv: ['send', '--to', 'demo', '--msg', 'hi', '--timeout', '4294967296'], error: '必须是 1..' },
  { name: '--html-height 超出上限', argv: ['send', '--to', 'demo', '--msg', 'hi', '--type', 'html', '--html-height', '10000000'], error: '必须是 1..' },
  { name: '缺少 --msg-file 的文件', argv: ['send', '--to', 'demo', '--msg-file', 'no-such-file-xyz'], error: '无法读取消息文件' },
  { name: '未知子命令', argv: ['frobnicate'], error: '未知子命令' },
];

for (const c of usageCases) {
  await test(c.name, async () => {
    const mock = createMockServer({ status: 200 });
    const origin = await mock.listen(0);
    try {
      const { code, stdout } = await runCli([
        ...c.argv,
        '--base-url',
        origin,
        '--allow-http',
        '--json',
      ]);
      assertEqual(code, 1, 'exit code 应为 1（用法错误）');
      assertEqual(mock.requests.length, 0, '不得发出请求');
      const payload = JSON.parse(stdout);
      assertEqual(payload.exitCode, 1, 'json exitCode');
      assert(typeof payload.error === 'string' && payload.error.length > 0, 'json 应带 error 文案');
      assert(
        payload.error.includes(c.error),
        `error 文案应包含「${c.error}」，实际：${payload.error}`,
      );
    } finally {
      await mock.close();
    }
  });
}

await test('真正的取值缺失（不带后续选项）也被拒绝', async () => {
  const { code, stdout } = await runCli(['send', '--to', '--json']);
  assertEqual(code, 1, 'exit code');
  assert(JSON.parse(stdout).error.includes('缺少取值'), '应提示缺少取值');
});

await test('取值以 - 开头时可用 --flag=value 传入', async () => {
  const { code, requests } = await withMock({ status: 200 }, [
    'send',
    '--to',
    'demo',
    '--msg=--dry-run',
    '--json',
  ]);
  assertEqual(code, 0, 'exit code');
  assertEqual(JSON.parse(requests[0].body).msg, '--dry-run', 'body 中的消息');
});

await test('send --title --dry-run 不得变成真实推送', async () => {
  const mock = createMockServer({ status: 200 });
  const origin = await mock.listen(0);
  try {
    const { code } = await runCli([
      'send',
      '--to',
      'demo',
      '--msg',
      'hi',
      '--title',
      '--dry-run',
      '--base-url',
      origin,
      '--allow-http',
    ]);
    assertEqual(code, 1, 'exit code 应为 1');
    assertEqual(mock.requests.length, 0, '绝不能发出真实推送');
  } finally {
    await mock.close();
  }
});

await test('明文 HTTP 默认被拒绝，--allow-http 才放行', async () => {
  const { code } = await runCli([
    'send',
    '--to',
    'demo',
    '--msg',
    'hi',
    '--base-url',
    'http://127.0.0.1:9/',
    '--json',
  ]);
  assertEqual(code, 1, 'exit code');
});

// ---------------------------------------------------------------------------
// 4. Output contract and self-check commands
// ---------------------------------------------------------------------------

group('输出契约与自检');

await test('--json 时 stdout 可被 JSON.parse，且不含额外文本', async () => {
  const { stdout, stderr } = await withMock({ status: 200 }, [
    'send',
    '--to',
    'demo',
    '--msg',
    'hi',
    '--json',
  ]);
  const payload = JSON.parse(stdout);
  assertEqual(payload.tool, 'meow-push', 'tool 字段');
  assertEqual(stderr, '', 'stderr 应为空');
});

await test('默认（非 --json）输出是人类可读的行文本', async () => {
  const { stdout } = await withMock({ status: 404 }, ['send', '--to', 'demo', '--msg', 'hi']);
  assert(stdout.includes('[!]'), '应带失败标记');
  assert(stdout.includes('demo'), '应带接收者');
  assert(stdout.includes('404') || stdout.includes('未在 MeoW 注册'), '应解释原因');
  assert(!stdout.trim().startsWith('{'), '不应是 JSON');
});

await test('schema 输出可用于 agent 发现能力', async () => {
  const { code, stdout } = await runCli(['schema']);
  assertEqual(code, 0, 'exit code');
  const payload = JSON.parse(stdout);
  assertEqual(payload.api.baseUrl, 'https://api.chuckfang.com', 'baseUrl');
  for (const command of ['send', 'preview', 'doctor', 'schema']) {
    assert(payload.commands[command] !== undefined, `schema 应包含 ${command}`);
  }
  assert(Array.isArray(payload.exitCodes) && payload.exitCodes.length === 6, '退出码表');
  const sendFlags = payload.commands.send.flags.map((f) => f.name);
  for (const flag of ['to', 'msg', 'title', 'type', 'dry-run', 'json']) {
    assert(sendFlags.includes(flag), `send 应包含 --${flag}`);
  }
});

await test('schema 接受 --json 并拒绝多余位置参数（与其他子命令一致）', async () => {
  const withJson = await runCli(['schema', '--json']);
  assertEqual(withJson.code, 0, 'schema --json 的退出码');
  const payload = JSON.parse(withJson.stdout);
  assertEqual(payload.tool, 'meow-push', 'tool');
  const extra = await runCli(['schema', 'extra']);
  assertEqual(extra.code, 1, 'schema extra 的退出码');
});

await test('doctor 不推送任何消息', async () => {
  const mock = createMockServer({ status: 200 });
  const origin = await mock.listen(0);
  try {
    const { code, stdout } = await runCli([
      'doctor',
      '--base-url',
      origin,
      '--allow-http',
      '--json',
    ]);
    assertEqual(code, 0, 'exit code');
    assertEqual(mock.requests.length, 0, 'doctor 不带 --probe 时不应请求');
    assertEqual(JSON.parse(stdout).command, 'doctor', 'command');
  } finally {
    await mock.close();
  }
});

await test('doctor --probe 命中 IP 限制时返回 4 并给出可执行建议', async () => {
  const mock = createMockServer({
    rawBody: '{"status":429,"data":false,"msg":"IP限制，请联系开发者"}',
  });
  const origin = await mock.listen(0);
  try {
    const { code, stdout } = await runCli([
      'doctor',
      '--probe',
      '--base-url',
      origin,
      '--allow-http',
      '--json',
    ]);
    assertEqual(code, 4, 'exit code');
    const payload = JSON.parse(stdout);
    assertEqual(payload.probe.ipRestricted, true, 'ipRestricted');
    assert(
      payload.checks.some((c) => c.detail.includes('IP')),
      '应提示 IP 限制',
    );
  } finally {
    await mock.close();
  }
});

await test('doctor --probe 只请求根路径，不构成推送', async () => {
  const mock = createMockServer({ status: 200 });
  const origin = await mock.listen(0);
  try {
    await runCli(['doctor', '--probe', '--base-url', origin, '--allow-http', '--json']);
    assertEqual(mock.requests.length, 1, '请求数');
    assertEqual(mock.requests[0].url, '/', '只应请求根路径');
  } finally {
    await mock.close();
  }
});

await test('doctor --probe 遇到 HTML 根路径不得谎报「已连通」', async () => {
  const mock = createMockServer({ rawBody: '<html>Not Found</html>' });
  const origin = await mock.listen(0);
  try {
    const { code, stdout } = await runCli([
      'doctor',
      '--probe',
      '--base-url',
      origin,
      '--allow-http',
      '--json',
    ]);
    assertEqual(code, 2, 'exit code');
    const payload = JSON.parse(stdout);
    assertEqual(payload.probe.envelopeRecognised, false, 'envelopeRecognised');
    assertEqual(payload.ok, false, 'ok');
    assert(
      payload.checks.some((c) => c.name === 'probe' && !c.ok),
      'probe 检查必须为失败',
    );
  } finally {
    await mock.close();
  }
});

await test('doctor --probe 遇到 404 空体不得谎报「已连通」', async () => {
  const mock = createMockServer({ httpStatus: 404, rawBody: '' });
  const origin = await mock.listen(0);
  try {
    const { code, stdout } = await runCli([
      'doctor',
      '--probe',
      '--base-url',
      origin,
      '--allow-http',
      '--json',
    ]);
    assertEqual(code, 2, 'exit code');
    assertEqual(JSON.parse(stdout).probe.envelopeRecognised, false, 'envelopeRecognised');
  } finally {
    await mock.close();
  }
});

await test('help 与 --version 可用', async () => {
  const help = await runCli(['help']);
  assertEqual(help.code, 0, 'help exit code');
  assert(help.stdout.includes('meow-push'), 'help 应提到工具名');
  assert(help.stdout.includes('退出码'), 'help 应说明退出码');
  const version = await runCli(['--version']);
  assertEqual(version.code, 0, 'version exit code');
  assert(/^\d+\.\d+\.\d+\s*$/.test(version.stdout), 'version 应是语义化版本');
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

let lastGroup = '';
let failed = 0;
for (const r of results) {
  if (r.group !== lastGroup) {
    process.stdout.write(`\n${r.group}\n`);
    lastGroup = r.group;
  }
  if (r.ok) {
    process.stdout.write(`  PASS  ${r.name}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  FAIL  ${r.name}\n        ${r.error}\n`);
  }
}

const total = results.length;
process.stdout.write(
  `\n${total - failed}/${total} 通过${failed === 0 ? '' : `，${failed} 个失败`}\n`,
);
process.exitCode = failed === 0 ? 0 : 1;
