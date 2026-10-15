/**
 * MeoW push client: request construction, HTTP exchange and response
 * classification.
 *
 * Verified against the OpenAPI 3.1 document embedded in
 * https://www.chuckfang.com/MeoW/api_doc.html
 * and one live probe of https://api.chuckfang.com/ .
 */
import type { ApiEnvelope, BuiltRequest, SendOptions, SendResult, Warning } from './types.ts';
/** Documented default title, applied server-side when the title is omitted. */
export declare const DEFAULT_TITLE = "MeoW";
/** Documented default HTML display height, in pixels. */
export declare const DEFAULT_HTML_HEIGHT = 200;
export declare const DEFAULT_BASE_URL = "https://api.chuckfang.com";
export declare const DEFAULT_TIMEOUT_MS = 15000;
/** Percent-encode one path segment or query component (UTF-8, uppercase hex). */
export declare function rfc3986(value: string): string;
/** Join `key=value` pairs with `&`, percent-encoding both sides. */
export declare function encodePairs(pairs: readonly (readonly [string, string])[]): string;
/**
 * Validate and normalise the API base URL.
 * Plain HTTP is refused unless explicitly allowed, because the payload —
 * including the message body — travels in the clear.
 */
export declare function normalizeBaseUrl(raw: string, allowHttp: boolean): string;
/**
 * The only URL shape that can be probed without delivering a message.
 * Hits the API root, which carries no nickname and therefore pushes nothing.
 */
export declare function buildProbeUrl(baseUrl: string): string;
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
export declare function buildRequest(options: SendOptions): {
    request: BuiltRequest;
    warnings: Warning[];
};
/** Project a parsed body onto the documented envelope, tolerating the legacy `message` spelling. */
export declare function toEnvelope(value: unknown): ApiEnvelope | null;
/**
 * Map one HTTP exchange onto an outcome.
 *
 * Success requires business status 200. `data: true` makes it *confirmed*; a
 * 200 without a `data` field is still an acceptance under the documented
 * contract (the page's own examples show a data-less 200), but it is reported
 * as unconfirmed rather than claimed as delivered. `status: 200, data: false`
 * is self-contradictory and never treated as success.
 */
export declare function classify(httpStatus: number | null, rawBody: string | null): SendResult;
/**
 * Perform one push attempt. Never retries: pushes are not idempotent, so an
 * indeterminate result is reported as such instead of being replayed.
 */
export declare function sendPush(request: BuiltRequest, timeoutMs: number): Promise<SendResult>;
/**
 * Probe the API root. Carries no nickname, so it cannot deliver a message;
 * it only reveals reachability and whether the outbound IP is restricted.
 *
 * Unlike `sendPush`, this follows redirects: it is an idempotent GET that
 * delivers nothing, so following is safe and lets an http:// base URL reach
 * the https:// endpoint.
 */
export declare function probeEndpoint(baseUrl: string, timeoutMs: number): Promise<{
    httpStatus: number | null;
    envelope: ApiEnvelope | null;
    rawBody: string | null;
    error: string | null;
}>;
