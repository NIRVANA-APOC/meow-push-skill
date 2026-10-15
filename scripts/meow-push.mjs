#!/usr/bin/env node
/**
 * meow-push launcher.
 *
 * Prefers the compiled `dist/cli.js` so the CLI runs with a bare `node` and no
 * build step. Falls back to running the TypeScript sources directly when the
 * installed Node strips types natively (>= 22.18, or >= 23), so a fresh
 * checkout works before `npm run build` too.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const distEntry = path.join(root, 'dist', 'main.js');
const srcEntry = path.join(root, 'src', 'main.ts');

function supportsNativeTypeStripping() {
  const [majorRaw, minorRaw] = process.versions.node.split('.');
  const major = Number.parseInt(majorRaw, 10);
  const minor = Number.parseInt(minorRaw, 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  if (major >= 24) return true;
  if (major === 23) return true;
  return major === 22 && minor >= 18;
}

if (existsSync(distEntry)) {
  await import(pathToFileURL(distEntry).href);
} else if (existsSync(srcEntry) && supportsNativeTypeStripping()) {
  process.stderr.write(
    '[meow-push] 未找到 dist/main.js，正在用 Node 原生类型擦除直接运行 src/main.ts。' +
      '如需消除此提示，请运行 npm run build。\n',
  );
  await import(pathToFileURL(srcEntry).href);
} else {
  process.stderr.write(
    '[meow-push] 未找到 dist/main.js，且当前 Node (' +
      process.versions.node +
      ') 不支持直接运行 TypeScript。\n' +
      '请在技能目录执行：npm install && npm run build（需要 Node >= 20）。\n',
  );
  process.exitCode = 1;
}
