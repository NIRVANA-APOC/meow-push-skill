#!/usr/bin/env node
/**
 * Executable wrapper for the MeoW push CLI.
 *
 * Kept separate from `cli.ts` so the CLI stays importable: importing `cli.ts`
 * has no side effects, which is what lets the test suite drive the real `main`
 * in-process. `scripts/meow-push.mjs` imports this module's compiled output.
 */

import { main } from './cli.ts';

process.exitCode = await main(process.argv.slice(2));
