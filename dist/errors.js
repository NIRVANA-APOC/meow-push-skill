/**
 * Errors raised for locally detectable mistakes, before any request is sent.
 *
 * Kept in its own module so both the argument parser and the HTTP client can
 * throw the same class without a circular import; `main()` maps it to exit
 * code 1.
 */
export class UsageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UsageError';
    }
}
//# sourceMappingURL=errors.js.map