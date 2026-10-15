#!/usr/bin/env node
/**
 * meow-push — MeoW 消息推送 CLI
 *
 * A small, dependency-free command line front end for the MeoW push API
 * (https://www.chuckfang.com/MeoW/api_doc.html). Designed to be driven by an
 * agent: every outcome is a stable exit code, and `--json` gives a
 * machine-readable result on stdout.
 */
export declare function readVersion(): string;
/**
 * Total entry point: always resolves to a process exit code and never throws.
 * Keeping it side-effect free lets `scripts/test.mjs` drive the real CLI
 * in-process while `src/main.ts` supplies the executable wrapper.
 */
export declare function main(argv: readonly string[]): Promise<number>;
