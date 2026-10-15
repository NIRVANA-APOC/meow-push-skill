/**
 * Shared types and constants for the MeoW push CLI.
 *
 * Only erasable TypeScript syntax is used (no enums, no namespaces, no
 * parameter properties) so the sources run directly under Node's type
 * stripping as well as after a `tsc` build.
 */
/** Process exit codes. Chosen so an agent can branch without parsing text. */
export declare const EXIT: {
    /** Server confirmed the push. */
    readonly OK: 0;
    /** Bad local invocation; nothing was sent. */
    readonly USAGE: 1;
    /** Result indeterminate: network failure, timeout, 5xx or unparsable body. */
    readonly UNKNOWN: 2;
    /** Terminal rejection: 400 / 403 / 404. Retrying identical input cannot help. */
    readonly REJECTED: 3;
    /** Business status 429: rate limited or IP restricted. Do not loop. */
    readonly RATE_LIMITED: 4;
    /** HTTP 200 but the envelope contradicted itself (`status:200, data:false`). */
    readonly UNCONFIRMED: 5;
};
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
/** `msgType` query parameter. */
export type MsgType = 'text' | 'html';
export type HttpMethod = 'GET' | 'POST';
/** POST body encoding. `text` sends the raw message as `text/plain`. */
export type PostFormat = 'json' | 'form' | 'text';
/** Coarse classification of one push attempt. */
export type OutcomeKind = 'success' | 'unconfirmed' | 'rejected' | 'rate_limited' | 'unknown';
/** Everything needed to build one push request. */
export type SendOptions = {
    nickname: string;
    /** Always resolved: an omitted title becomes `MeoW`, the documented default. */
    title: string;
    msg: string;
    url: string | undefined;
    imgUrl: string | undefined;
    msgType: MsgType;
    htmlHeight: number | undefined;
    method: HttpMethod;
    format: PostFormat;
    baseUrl: string;
    timeoutMs: number;
};
/** A fully materialised HTTP request. Pure output of the builder. */
export type BuiltRequest = {
    method: HttpMethod;
    url: string;
    headers: Record<string, string>;
    /** `undefined` for GET. */
    body: string | undefined;
};
/** Non-fatal advisories surfaced to the caller (e.g. an over-long GET URL). */
export type Warning = {
    code: string;
    text: string;
};
/** The JSON envelope the API returns. `message` is the legacy spelling. */
export type ApiEnvelope = {
    status: number | null;
    data: boolean | null;
    msg: string | null;
    message: string | null;
};
/** Result of classifying one HTTP exchange. */
export type SendResult = {
    outcome: OutcomeKind;
    /** True only when the server positively confirmed delivery. */
    confirmed: boolean;
    exitCode: ExitCode;
    httpStatus: number | null;
    envelope: ApiEnvelope | null;
    rawBody: string | null;
    /** Human-readable server text, when present. */
    serverMessage: string | null;
    /** Stable machine token explaining a non-success classification. */
    reason: string | null;
    /** One-line explanation for the operator. */
    detail: string;
};
