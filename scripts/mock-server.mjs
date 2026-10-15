#!/usr/bin/env node
/**
 * A local stand-in for the MeoW push API.
 *
 * Used by `scripts/test.mjs` to verify the CLI without touching the real
 * service, and usable standalone for manual checks:
 *
 *   node scripts/mock-server.mjs 8787
 *   node scripts/meow-push.mjs send --to demo --msg hi \
 *     --base-url http://127.0.0.1:8787 --allow-http
 *
 * Env:
 *   MEOW_MOCK_STATUS   business status to reply with (default 200)
 *   MEOW_MOCK_DELAY    milliseconds to stall before replying (default 0)
 *   MEOW_MOCK_BODY     raw body override, e.g. "<html>nope</html>"
 *   MEOW_MOCK_REDIRECT reply 302 to this path instead of answering
 */

import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPLIES = {
  200: { status: 200, data: true, msg: '发送成功' },
  400: { status: 400, data: false, msg: '发送失败，标题不能为空' },
  403: { status: 403, data: false, msg: '敏感词，禁止发送' },
  404: { status: 404, data: false, msg: '发送失败，该昵称没有注册' },
  429: { status: 429, data: false, msg: '非会员用户每分钟只能发送15条消息' },
  500: { status: 500, msg: '服务器内部错误' },
};

/**
 * @param {{ status?: number, delayMs?: number, rawBody?: string, httpStatus?: number, redirectTo?: string }} [options]
 */
export function createMockServer(options = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: rawBody,
      });

      const reply = () => {
        if (options.redirectTo !== undefined) {
          res.writeHead(302, { location: options.redirectTo });
          res.end();
          return;
        }
        if (options.rawBody !== undefined) {
          res.writeHead(options.httpStatus ?? 200, {
            'content-type': 'text/html; charset=utf-8',
          });
          res.end(options.rawBody);
          return;
        }
        const status = options.status ?? 200;
        const payload = DEFAULT_REPLIES[status] ?? {
          status,
          data: false,
          msg: `mock status ${status}`,
        };
        res.writeHead(options.httpStatus ?? 200, {
          'content-type': 'application/json; charset=utf-8',
        });
        res.end(JSON.stringify(payload));
      };

      if (options.delayMs !== undefined && options.delayMs > 0) {
        setTimeout(reply, options.delayMs);
      } else {
        reply();
      }
    });
  });

  return {
    requests,
    /** Start on an ephemeral (or given) port; resolves to the origin. */
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      return `http://127.0.0.1:${bound}`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const port = Number.parseInt(process.argv[2] ?? '8787', 10);
  const mock = createMockServer({
    ...(process.env.MEOW_MOCK_STATUS === undefined
      ? {}
      : { status: Number.parseInt(process.env.MEOW_MOCK_STATUS, 10) }),
    ...(process.env.MEOW_MOCK_DELAY === undefined
      ? {}
      : { delayMs: Number.parseInt(process.env.MEOW_MOCK_DELAY, 10) }),
    ...(process.env.MEOW_MOCK_BODY === undefined
      ? {}
      : { rawBody: process.env.MEOW_MOCK_BODY }),
    ...(process.env.MEOW_MOCK_REDIRECT === undefined
      ? {}
      : { redirectTo: process.env.MEOW_MOCK_REDIRECT }),
  });
  const origin = await mock.listen(port);
  process.stdout.write(
    `MeoW mock API listening on ${origin}\n` +
      `  try: node scripts/meow-push.mjs send --to demo --msg hello --base-url ${origin} --allow-http\n`,
  );
}
