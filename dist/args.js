/**
 * Minimal, spec-driven command-line parser.
 *
 * One flag table per command drives parsing, `--help` and `schema` output, so
 * the three can never drift apart.
 */
import { UsageError } from "./errors.js";
export { UsageError };
const FLAG_NAME = /^[a-z][a-z0-9-]*$/;
function findFlag(specs, token) {
    if (token.startsWith('--')) {
        const name = token.slice(2);
        return specs.find((s) => s.name === name);
    }
    return specs.find((s) => s.alias !== null && s.alias === token.slice(1));
}
function coerce(spec, raw) {
    if (spec.kind === 'integer') {
        if (!/^-?\d+$/.test(raw)) {
            throw new UsageError(`--${spec.name} 需要一个整数，收到 "${raw}"`);
        }
        return Number.parseInt(raw, 10);
    }
    if (spec.choices !== null && !spec.choices.includes(raw)) {
        throw new UsageError(`--${spec.name} 只接受 ${spec.choices.join(' | ')}，收到 "${raw}"`);
    }
    return raw;
}
/**
 * Parse `argv` (already stripped of `node` and the script path) against `specs`.
 * Boolean flags never consume the following token, so `--json --to x` works.
 */
export function parseArgs(argv, specs) {
    const values = {};
    const positionals = [];
    let literal = false;
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === undefined)
            break;
        if (literal) {
            positionals.push(token);
            continue;
        }
        if (token === '--') {
            literal = true;
            continue;
        }
        if (!token.startsWith('-') || token === '-') {
            positionals.push(token);
            continue;
        }
        const eq = token.indexOf('=');
        const head = eq === -1 ? token : token.slice(0, eq);
        const inline = eq === -1 ? undefined : token.slice(eq + 1);
        const spec = findFlag(specs, head);
        if (spec === undefined) {
            throw new UsageError(`未知参数 ${head}；用 --help 查看可用参数`);
        }
        if (values[spec.name] !== undefined) {
            throw new UsageError(`参数 --${spec.name} 重复出现`);
        }
        if (spec.kind === 'boolean') {
            if (inline !== undefined && inline !== 'true' && inline !== 'false') {
                throw new UsageError(`--${spec.name} 是开关，不接受 "${inline}"`);
            }
            values[spec.name] = inline === undefined ? true : inline === 'true';
            continue;
        }
        if (inline !== undefined) {
            values[spec.name] = coerce(spec, inline);
            continue;
        }
        const next = argv[i + 1];
        if (next === undefined) {
            throw new UsageError(`--${spec.name} 缺少取值`);
        }
        // Refuse to eat a following option as a value: `send --title --dry-run`
        // would otherwise push for real while the operator expected a preview.
        // A value that genuinely starts with "-" must use --name=value.
        if (findFlag(specs, next) !== undefined) {
            throw new UsageError(`--${spec.name} 缺少取值：下一个参数 ${next} 是另一个选项。` +
                `若取值本身以 - 开头，请写成 --${spec.name}=${next}`);
        }
        values[spec.name] = coerce(spec, next);
        i += 1;
    }
    return { values, positionals };
}
export function flagName(spec) {
    return FLAG_NAME.test(spec.name) ? `--${spec.name}` : spec.name;
}
/** Render the flag table for `--help`. */
export function renderFlags(specs) {
    const rows = specs.map((s) => {
        const names = [flagName(s)];
        if (s.alias !== null)
            names.push(`-${s.alias}`);
        const left = `${names.join(', ')}${s.valueHint === null ? '' : ` ${s.valueHint}`}`;
        const bits = [s.help];
        if (s.choices !== null)
            bits.push(`可选值：${s.choices.join(' | ')}`);
        if (s.defaultValue !== null)
            bits.push(`默认：${String(s.defaultValue)}`);
        return [left, bits.join('；')];
    });
    const width = Math.max(...rows.map(([left]) => left.length));
    return rows
        .map(([left, right]) => `  ${left.padEnd(width)}  ${right}`)
        .join('\n');
}
/** Machine-readable description of the flag table, for agents. */
export function describeFlags(specs) {
    return specs.map((s) => ({
        name: s.name,
        alias: s.alias,
        kind: s.kind,
        choices: s.choices,
        default: s.defaultValue,
        help: s.help,
        valueHint: s.valueHint,
    }));
}
//# sourceMappingURL=args.js.map