#!/usr/bin/env node
/**
 * Verify that the committed `dist/` really is the build of the committed `src/`.
 *
 * `dist/` is checked in on purpose: the skill must run with a bare `node` and no
 * install step. This guard keeps that convenience honest — CI fails when the
 * two drift apart, so nobody has to trust a stale artifact.
 *
 * It recompiles in place, then reports which files changed. Exits 1 on drift;
 * the rebuilt output is left on disk so the fix is simply to commit it.
 *
 *   node scripts/check-dist-sync.mjs
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** Map of dist-relative path -> sha256, path-sorted for a stable diff. */
function snapshot() {
  const out = new Map();
  if (!existsSync(DIST)) return out;

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(DIST, full).replace(/\\/g, '/');
      out.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };
  walk(DIST);
  return out;
}

const before = snapshot();

const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) {
  console.error('check-dist-sync: typescript is not installed; run `npm ci` first');
  process.exit(1);
}

try {
  // stdio: 'inherit' — no pipes, so this works in constrained sandboxes too.
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
} catch {
  console.error('check-dist-sync: `tsc` failed');
  process.exit(1);
}

const after = snapshot();

const changed = [];
const added = [];
const removed = [];

for (const [file, hash] of after) {
  if (!before.has(file)) added.push(file);
  else if (before.get(file) !== hash) changed.push(file);
}
for (const file of before.keys()) {
  if (!after.has(file)) removed.push(file);
}

if (changed.length === 0 && added.length === 0 && removed.length === 0) {
  console.log(`check-dist-sync: OK (${after.size} files, identical to src/)`);
  process.exit(0);
}

console.log('check-dist-sync: dist/ is NOT in sync with src/');
for (const file of changed) console.log(`  modified  ${file}`);
for (const file of added) console.log(`  missing   ${file} (was not committed)`);
for (const file of removed) console.log(`  stale     ${file} (no longer generated)`);
console.log('\ndist/ has been rebuilt. Commit the result:');
console.log('  git add dist && git commit -m "Rebuild dist"');
process.exitCode = 1;
