#!/usr/bin/env node
/**
 * Guard against publishing private data.
 *
 * Scans the working tree for content that must not appear in a public
 * repository: absolute local paths, the current user or host name, credentials,
 * and environment-specific leftovers. Read-only; exits 1 when anything matches.
 *
 *   node scripts/scan-secrets.mjs
 *
 * Deliberately derives every environment-specific needle at runtime
 * (`os.userInfo()`, `os.homedir()`, `os.hostname()`) so that this file itself
 * contains no personal strings.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage']);

const USERNAME = (() => {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
})();

const HOME = homedir();
const HOST = hostname();

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Identity rules catch a developer's own machine name leaking into the tree.
 * On CI the "identity" is a disposable runner container, so those two rules are
 * skipped there; path and credential rules always run.
 */
const IN_CI = Boolean(process.env.CI);

const RULES = [
  ['absolute-user-path', /(?:[A-Za-z]:[\\/]{1,2}(?:Users|Documents)[\\/]{1,2}|\/(?:home|Users)\/)[^\s"'`)]+/g],
  ['home-directory', new RegExp(escapeRegExp(HOME).replace(/\\\\/g, '[\\\\/]{1,2}'), 'gi')],
  ['user-name', !IN_CI && USERNAME.length >= 3 ? new RegExp(`\\b${escapeRegExp(USERNAME)}\\b`, 'gi') : null],
  ['host-name', !IN_CI && HOST.length >= 3 ? new RegExp(`\\b${escapeRegExp(HOST)}\\b`, 'gi') : null],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._-]{16,}/g],
  ['assigned-secret', /\b(?:secret|password|passwd|api[_-]?key|access[_-]?token|private[_-]?key|auth[_-]?token)\b\s*[:=]\s*["']?[^\s"',]{8,}/gi],
  ['session-id', /\b(?:session|sess)-[0-9a-f]{8}-[0-9a-f-]{8,}\b/gi],
  ['scratch-directory', /(?:\.scan|\.review-tmp|\.secret-scan)\b/g],
].filter(([, pattern]) => pattern !== null);

/**
 * The repository owner is public by definition — it is in the repo URL, the
 * licence attribution and the commit identity. Read it from `package.json` so
 * the intentional public handle is not mistaken for a leaked local username.
 */
const PUBLIC_LOGINS = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const url = typeof pkg.repository?.url === 'string' ? pkg.repository.url : '';
    const owner = /github\.com[/:]([^/]+)\//.exec(url);
    return owner === null ? [] : [owner[1].toLowerCase()];
  } catch {
    return [];
  }
})();

/**
 * Intentional public values that would otherwise trip a rule. Loopback is used
 * by the bundled mock server, the noreply domain is GitHub's privacy-preserving
 * commit address, and the repo owner is public attribution.
 */
const ALLOW = [
  (hit) => /127\.0\.0\.1/.test(hit),
  (hit) => /(?:^|[.@])users\.noreply\.github\.com$/.test(hit),
  (hit, line) =>
    PUBLIC_LOGINS.some((login) => line.toLowerCase().includes(login)),
];

const COLLECTOR = [];

/** This file necessarily contains every pattern, so it never scans itself. */
const SELF = fileURLToPath(import.meta.url);

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (full === SELF) continue;
    if (statSync(full).size > 8 * 1024 * 1024) continue;

    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue; // binary
    COLLECTOR.push([full, text]);
  }
}

walk(ROOT);

const findings = [];
for (const [full, text] of COLLECTOR) {
  const rel = path.relative(ROOT, full).replace(/\\/g, '/');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const [rule, pattern] of RULES) {
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (match === null) continue;
      if (ALLOW.some((allow) => allow(match[0], line))) continue;
      findings.push({ rule, file: rel, line: i + 1, hit: match[0].slice(0, 100) });
    }
  }
}

const byRule = new Map();
for (const finding of findings) {
  if (!byRule.has(finding.rule)) byRule.set(finding.rule, []);
  byRule.get(finding.rule).push(finding);
}

console.log(`scanned ${COLLECTOR.length} text files`);

if (findings.length === 0) {
  console.log('CLEAN — nothing to redact');
  process.exit(0);
}

for (const [rule, list] of [...byRule].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n### ${rule} (${list.length})`);
  for (const finding of list.slice(0, 15)) {
    console.log(`  ${finding.file}:${finding.line}  ${finding.hit}`);
  }
  if (list.length > 15) console.log(`  ... and ${list.length - 15} more`);
}

console.log(`\nTOTAL FINDINGS: ${findings.length}`);
process.exitCode = 1;
