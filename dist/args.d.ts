/**
 * Minimal, spec-driven command-line parser.
 *
 * One flag table per command drives parsing, `--help` and `schema` output, so
 * the three can never drift apart.
 */
import { UsageError } from './errors.ts';
export { UsageError };
export type FlagKind = 'string' | 'boolean' | 'integer';
export type FlagSpec = {
    /** Long name without leading dashes, e.g. `html-height`. */
    name: string;
    /** Optional single-character alias, e.g. `t` for `-t`. */
    alias: string | null;
    kind: FlagKind;
    /** Short help text. */
    help: string;
    /** Placeholder shown in help, e.g. `<昵称>`. `null` for booleans. */
    valueHint: string | null;
    /** Default rendered in help and in `schema` output. */
    defaultValue: string | number | boolean | null;
    /** Allowed values for a constrained string flag. */
    choices: readonly string[] | null;
};
export type ParsedArgs = {
    /** Values keyed by `FlagSpec.name`; absent flags are omitted. */
    values: Record<string, string | number | boolean>;
    positionals: string[];
};
/**
 * Parse `argv` (already stripped of `node` and the script path) against `specs`.
 * Boolean flags never consume the following token, so `--json --to x` works.
 */
export declare function parseArgs(argv: readonly string[], specs: readonly FlagSpec[]): ParsedArgs;
export declare function flagName(spec: FlagSpec): string;
/** Render the flag table for `--help`. */
export declare function renderFlags(specs: readonly FlagSpec[]): string;
/** Machine-readable description of the flag table, for agents. */
export declare function describeFlags(specs: readonly FlagSpec[]): Record<string, unknown>[];
