/**
 * MeoW push client: request construction, HTTP exchange and response
 * classification.
 *
 * Verified against the OpenAPI 3.1 document embedded in
 * https://www.chuckfang.com/MeoW/api_doc.html
 * and one live probe of https://api.chuckfang.com/ .
 */

import { UsageError } from './errors.ts';
import { EXIT } from './types.ts';
import type {
  ApiEnvelope,
  BuiltRequest,
  SendOptions,
  SendResult,
  Warning,
} from './types.ts';

/** Documented default title, applied server-side when the title is omitted. */
export const DEFAULT_TITLE = 'MeoW';

/** Documented default HTML display height, in pixels. */
export const DEFAULT_HTML_HEIGHT = 200;

export const DEFAULT_BASE_URL = 'https://api.chuckfang.com';

export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * RFC 3986 unreserved set only. `encodeURIComponent` leaves `!'()*` alone,
 * which some routers mishandle inside path segments, so escape those too.
 */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

const encoder = new TextEncoder();

/** Percent-encode one path segment or query component (UTF-8, uppercase hex). */
export function rfc3986(value: string): string {
  let out = '';
  for (const ch of value) {
    if (UNRESERVED.test(ch)) {
      out += ch;
      continue;
    }
    for (const byte of encoder.encode(ch)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** Join `key=value` pairs with `&`, percent-encoding both sides. */
export function encodePairs(pairs: readonly (readonly [string, string])[]): string {
  return pairs.map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join('&');
}

/**
 * Validate and normalise the API base URL.
 * Plain HTTP is refused unless explicitly allowed, because the payload —
 * including the message body — travels in the clear.
 */
export function normalizeBaseUrl(raw: string, allowHttp: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UsageError(`base URL 不是合法 URL：${raw}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new UsageError(`base URL 只支持 http/https：${raw}`);
  }
  if (parsed.protocol === 'http:' && !allowHttp) {
    throw new UsageError(
      `拒绝使用明文 HTTP（${raw}）；如确认要使用，请加 --allow-http。推荐使用 https://api.chuckfang.com`,
    );
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

/**
 * The only URL shape that can be probed without delivering a message.
 * Hits the API root, which carries no nickname and therefore pushes nothing.
 */
export function buildProbeUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/`;
}

/** Advisories for a built request, without failing it. */
function collectWarnings(options: SendOptions, url: string): Warning[] {
  const warnings: Warning[] = [];
  if (options.method === 'GET' && url.length > 1800) {
    warnings.push({
      code: 'long_get_url',
      text:
        `GET URL 长度 ${url.length}，已接近常见 2KB 上限（中文百分号编码后每字 9 字符）。` +
        '建议改用 --method post。',
    });
  }
  return warnings;
}

/**
 * Build the exact HTTP request for one push. Pure: performs no I/O, so the
 * same function backs `send --dry-run` and the live send path.
 *
 * Only documented routes are used:
 *   GET  /{nickname}/{title}/{msg}   "含标题" variant
 *   POST /{nickname}/{title}         the only documented POST route
 *
 * `title` is always resolved by the caller (`MeoW` when the user omitted it —
 * the same default the service applies), so an omitted title never leaves the
 * request on an undocumented two-segment POST path.
 *
 * `msgType` and `htmlHeight` are query parameters in every case; they are
 * never JSON body fields.
 */
export function buildRequest(options: SendOptions): {
  request: BuiltRequest;
  warnings: Warning[];
} {
  const path =
    options.method === 'GET'
      ? `/${[options.nickname, options.title, options.msg].map(rfc3986).join('/')}`
      : `/${[options.nickname, options.title].map(rfc3986).join('/')}`;

  const query: Array<[string, string]> = [['msgType', options.msgType]];
  if (options.msgType === 'html' && options.htmlHeight !== undefined) {
    query.push(['htmlHeight', String(options.htmlHeight)]);
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: string | undefined;

  if (options.method === 'GET') {
    if (options.url !== undefined) query.push(['url', options.url]);
    if (options.imgUrl !== undefined) query.push(['imgUrl', options.imgUrl]);
  } else if (options.format === 'json') {
    const payload: Record<string, string> = {
      title: options.title,
      msg: options.msg,
    };
    if (options.url !== undefined) payload.url = options.url;
    if (options.imgUrl !== undefined) payload.imgUrl = options.imgUrl;
    body = JSON.stringify(payload);
    headers['Content-Type'] = 'application/json; charset=utf-8';
  } else if (options.format === 'form') {
    const form: Array<[string, string]> = [
      ['title', options.title],
      ['msg', options.msg],
    ];
    if (options.url !== undefined) form.push(['url', options.url]);
    if (options.imgUrl !== undefined) form.push(['imgUrl', options.imgUrl]);
    body = encodePairs(form);
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
  } else {
    // text/plain: the body *is* the message, so the title rides in the path
    // and the optional url/imgUrl have to go in the query string.
    body = options.msg;
    headers['Content-Type'] = 'text/plain; charset=utf-8';
    if (options.url !== undefined) query.push(['url', options.url]);
    if (options.imgUrl !== undefined) query.push(['imgUrl', options.imgUrl]);
  }

  const suffix = query.length > 0 ? `?${encodePairs(query)}` : '';
  const url = `${options.baseUrl}${path}${suffix}`;

  // Safety net: the WHATWG URL parser deletes a path segment that is exactly
  // "." or ".." (even percent-encoded, since %2E is decoded for that test), so
  // the request on the wire would silently differ from the one we validated,
  // preview and report. Callers reject those upfront; this catches any other
  // rewriting the parser might apply.
  if (new URL(url).pathname !== path) {
    throw new UsageError(
      `URL 规范化会改写请求路径（构建值 ${path}，实际将请求 ${new URL(url).pathname}）。` +
        '请检查昵称、标题与消息内容中是否有 "." 或 ".." 这类相对路径段。',
    );
  }

  return { request: { method: options.method, url, headers, body }, warnings: collectWarnings(options, url) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readStatus(source: Record<string, unknown>): number | null {
  const raw = source.status;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
    return Number.parseInt(raw.trim(), 10);
  }
  return null;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | null {
  const raw = source[key];
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

function readText(source: Record<string, unknown>, key: string): string | null {
  const raw = source[key];
  return typeof raw === 'string' ? raw : null;
}

/** Project a parsed body onto the documented envelope, tolerating the legacy `message` spelling. */
export function toEnvelope(value: unknown): ApiEnvelope | null {
  const record = asRecord(value);
  if (record === null) return null;
  const envelope: ApiEnvelope = {
    status: readStatus(record),
    data: readBoolean(record, 'data'),
    msg: readText(record, 'msg'),
    message: readText(record, 'message'),
  };
  if (
    envelope.status === null &&
    envelope.data === null &&
    envelope.msg === null &&
    envelope.message === null
  ) {
    return null;
  }
  return envelope;
}

type ResultFields = {
  outcome: SendResult['outcome'];
  confirmed: boolean;
  exitCode: SendResult['exitCode'];
  detail: string;
  httpStatus?: number | null;
  envelope?: ApiEnvelope | null;
  rawBody?: string | null;
  serverMessage?: string | null;
  reason?: string | null;
};

function result(fields: ResultFields): SendResult {
  return {
    outcome: fields.outcome,
    confirmed: fields.confirmed,
    exitCode: fields.exitCode,
    detail: fields.detail,
    httpStatus: fields.httpStatus ?? null,
    envelope: fields.envelope ?? null,
    rawBody: fields.rawBody ?? null,
    serverMessage: fields.serverMessage ?? null,
    reason: fields.reason ?? null,
  };
}

/**
 * Map one HTTP exchange onto an outcome.
 *
 * Success requires business status 200. `data: true` makes it *confirmed*; a
 * 200 without a `data` field is still an acceptance under the documented
 * contract (the page's own examples show a data-less 200), but it is reported
 * as unconfirmed rather than claimed as delivered. `status: 200, data: false`
 * is self-contradictory and never treated as success.
 */
export function classify(httpStatus: number | null, rawBody: string | null): SendResult {
  if (httpStatus !== null && httpStatus >= 300 && httpStatus < 400) {
    return result({
      outcome: 'unknown',
      confirmed: false,
      exitCode: EXIT.UNKNOWN,
      httpStatus,
      rawBody,
      reason: 'redirect_not_followed',
      detail:
        `收到 HTTP ${httpStatus} 重定向。推送不可幂等，跟随重定向可能重复投递或在 301/302/303 下丢失请求体，` +
        '因此不跟随。请直接使用最终的 API 地址（例如 https://api.chuckfang.com）。',
    });
  }
  if (httpStatus !== null && httpStatus >= 500) {
    return result({
      outcome: 'unknown',
      confirmed: false,
      exitCode: EXIT.UNKNOWN,
      httpStatus,
      rawBody,
      reason: 'http_server_error',
      detail: `HTTP ${httpStatus}：服务端网关错误，无法判断消息是否已送达。请勿自动重发。`,
    });
  }
  if (httpStatus === 429) {
    return result({
      outcome: 'rate_limited',
      confirmed: false,
      exitCode: EXIT.RATE_LIMITED,
      httpStatus,
      rawBody,
      reason: 'http_rate_limited',
      detail: 'HTTP 429：请求被限流。请勿循环重试。',
    });
  }
  if (rawBody === null) {
    return result({
      outcome: 'unknown',
      confirmed: false,
      exitCode: EXIT.UNKNOWN,
      httpStatus,
      reason: 'no_response_body',
      detail: '未读到响应体，无法判断推送结果。请勿自动重发。',
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return result({
      outcome: 'unknown',
      confirmed: false,
      exitCode: EXIT.UNKNOWN,
      httpStatus,
      rawBody,
      reason: 'non_json_response',
      detail: `响应不是 JSON（HTTP ${String(httpStatus)}），无法判断推送结果。请勿自动重发。`,
    });
  }

  const envelope = toEnvelope(parsed);
  if (envelope === null) {
    return result({
      outcome: 'unknown',
      confirmed: false,
      exitCode: EXIT.UNKNOWN,
      httpStatus,
      rawBody,
      reason: 'unrecognised_envelope',
      detail: '响应 JSON 中不含 status/msg 字段，无法判断推送结果。请勿自动重发。',
    });
  }

  const serverMessage = envelope.msg ?? envelope.message;
  const biz = envelope.status;

  if (biz === null) {
    return result({
      outcome: 'unknown',
      confirmed: false,
      exitCode: EXIT.UNKNOWN,
      httpStatus,
      envelope,
      rawBody,
      serverMessage,
      reason: 'missing_business_status',
      detail: '响应缺少业务状态码 status，无法判断推送结果。请勿自动重发。',
    });
  }

  if (biz === 200) {
    // The service documents HTTP 200 for every exchange, so an HTTP error
    // status alongside a business 200 means an intermediary answered — the
    // request may never have reached the push endpoint.
    if (httpStatus !== null && httpStatus >= 400) {
      return result({
        outcome: 'unknown',
        confirmed: false,
        exitCode: EXIT.UNKNOWN,
        httpStatus,
        envelope,
        rawBody,
        serverMessage,
        reason: 'http_status_conflict',
        detail: `HTTP ${httpStatus} 与业务 status=200 冲突，响应可能来自中间层，无法确认是否送达。请勿自动重发。`,
      });
    }
    if (envelope.data === false) {
      return result({
        outcome: 'unconfirmed',
        confirmed: false,
        exitCode: EXIT.UNCONFIRMED,
        httpStatus,
        envelope,
        rawBody,
        serverMessage,
        reason: 'status_200_data_false',
        detail:
          '业务状态码为 200 却带 data=false，二者语义不一致，不能视为成功。请按失败处理，不要自动重发。',
      });
    }
    if (envelope.data === true) {
      return result({
        outcome: 'success',
        confirmed: true,
        exitCode: EXIT.OK,
        httpStatus,
        envelope,
        rawBody,
        serverMessage,
        detail: '服务端已受理本次推送（信封含 data=true）。这只表示服务端接受，不代表设备已收到通知。',
      });
    }
    return result({
      outcome: 'success',
      confirmed: false,
      exitCode: EXIT.OK,
      httpStatus,
      envelope,
      rawBody,
      serverMessage,
      reason: 'success_without_data_field',
      detail:
        '服务端返回 status=200 但未包含 data 确认字段；按文档示例这表示已受理，请视为可能已送达，不要重发。',
    });
  }

  if (biz === 400 || biz === 403 || biz === 404) {
    const detail =
      biz === 400
        ? '参数错误（标题或消息不合法）。'
        : biz === 403
          ? '内容被策略拦截（可能含敏感词）。'
          : '该昵称未在 MeoW 注册。';
    return result({
      outcome: 'rejected',
      confirmed: false,
      exitCode: EXIT.REJECTED,
      httpStatus,
      envelope,
      rawBody,
      serverMessage,
      reason: `business_${biz}`,
      detail: `${detail}相同参数重试不会成功，请先修正后再试。`,
    });
  }

  if (biz === 429) {
    return result({
      outcome: 'rate_limited',
      confirmed: false,
      exitCode: EXIT.RATE_LIMITED,
      httpStatus,
      envelope,
      rawBody,
      serverMessage,
      reason: 'business_429',
      detail:
        '触发频率或 IP 限制。非会员上限：3 秒 1 条、每分钟 15 条、每小时 60 条、每天 1000 条。请勿循环重试。',
    });
  }

  if (biz === 500) {
    return result({
      outcome: 'unknown',
      confirmed: false,
      exitCode: EXIT.UNKNOWN,
      httpStatus,
      envelope,
      rawBody,
      serverMessage,
      reason: 'business_500',
      detail: '服务端内部错误，无法判断消息是否已送达。请勿自动重发。',
    });
  }

  return result({
    outcome: 'unknown',
    confirmed: false,
    exitCode: EXIT.UNKNOWN,
    httpStatus,
    envelope,
    rawBody,
    serverMessage,
    reason: 'unexpected_business_status',
    detail: `未记录的业务状态码 ${biz}，无法判断推送结果。请勿自动重发。`,
  });
}

/**
 * Perform one push attempt. Never retries: pushes are not idempotent, so an
 * indeterminate result is reported as such instead of being replayed.
 */
export async function sendPush(
  request: BuiltRequest,
  timeoutMs: number,
): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(timeoutMs),
      // Deliberately not 'follow': see the redirect branch in classify().
      redirect: 'manual',
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : String(error);
    if (name === 'TimeoutError' || name === 'AbortError') {
      return result({
        outcome: 'unknown',
        confirmed: false,
        exitCode: EXIT.UNKNOWN,
        reason: 'timeout',
        detail: `请求超时（${timeoutMs}ms）。消息可能已经发出，请勿自动重发。`,
      });
    }
    return result({
      outcome: 'unknown',
      confirmed: false,
      exitCode: EXIT.UNKNOWN,
      reason: 'network_error',
      detail: `网络错误，未取得响应：${message}。消息是否送达未知，请勿自动重发。`,
    });
  }

  let rawBody: string | null = null;
  try {
    rawBody = await response.text();
  } catch {
    rawBody = null;
  }

  return classify(response.status, rawBody);
}

/**
 * Probe the API root. Carries no nickname, so it cannot deliver a message;
 * it only reveals reachability and whether the outbound IP is restricted.
 *
 * Unlike `sendPush`, this follows redirects: it is an idempotent GET that
 * delivers nothing, so following is safe and lets an http:// base URL reach
 * the https:// endpoint.
 */
export async function probeEndpoint(
  baseUrl: string,
  timeoutMs: number,
): Promise<{ httpStatus: number | null; envelope: ApiEnvelope | null; rawBody: string | null; error: string | null }> {
  try {
    const response = await fetch(buildProbeUrl(baseUrl), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    const rawBody = await response.text().catch(() => null);
    let envelope: ApiEnvelope | null = null;
    if (rawBody !== null) {
      try {
        envelope = toEnvelope(JSON.parse(rawBody));
      } catch {
        envelope = null;
      }
    }
    return { httpStatus: response.status, envelope, rawBody, error: null };
  } catch (error) {
    return {
      httpStatus: null,
      envelope: null,
      rawBody: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
