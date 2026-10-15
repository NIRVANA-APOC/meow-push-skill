/**
 * Shared types and constants for the MeoW push CLI.
 *
 * Only erasable TypeScript syntax is used (no enums, no namespaces, no
 * parameter properties) so the sources run directly under Node's type
 * stripping as well as after a `tsc` build.
 */
/** Process exit codes. Chosen so an agent can branch without parsing text. */
export const EXIT = {
    /** Server confirmed the push. */
    OK: 0,
    /** Bad local invocation; nothing was sent. */
    USAGE: 1,
    /** Result indeterminate: network failure, timeout, 5xx or unparsable body. */
    UNKNOWN: 2,
    /** Terminal rejection: 400 / 403 / 404. Retrying identical input cannot help. */
    REJECTED: 3,
    /** Business status 429: rate limited or IP restricted. Do not loop. */
    RATE_LIMITED: 4,
    /** HTTP 200 but the envelope contradicted itself (`status:200, data:false`). */
    UNCONFIRMED: 5,
};
//# sourceMappingURL=types.js.map