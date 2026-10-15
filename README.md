# meow-push-skill

An **agent skill** plus a **zero-dependency TypeScript CLI** for pushing text or HTML
notifications to a [MeoW](https://www.chuckfang.com/MeoW/api_doc.html) nickname.

[![CI](https://github.com/NIRVANA-APOC/meow-push-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/NIRVANA-APOC/meow-push-skill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

> 中文说明见 [README.zh-CN.md](README.zh-CN.md)。

The skill teaches an agent *when* to send, what must be confirmed first, and how to read the result
honestly. The CLI handles URL encoding, request construction, response classification and exit
codes, so the agent never hand-rolls a request.

```bash
meow-push preview --to JohnDoe --title "Build" --msg "Build finished"
meow-push send    --to JohnDoe --title "Build" --msg "Build finished" --json
```

## Why a CLI instead of raw HTTP

The MeoW API is a simple GET/POST endpoint, but three properties make it easy to get wrong:

- **Pushes are not idempotent.** A timeout or a 5xx leaves delivery genuinely unknown. The CLI
  never retries and never follows redirects, and reports "unknown" instead of guessing.
- **The response contract is subtle.** The HTTP status is always `200`; the real result lives in
  the JSON body, and the published examples disagree with the actual envelope (see
  [`references/api.md`](references/api.md)).
- **Rate limits and egress-IP rules are enforced server-side**, and a shared public IP can get a
  whole host quarantined.

## Install

This repository *is* the skill bundle: the root contains `SKILL.md`. Copy the directory into any
scanned skill root — a directory bundle must sit at `<root>/<any-name>/SKILL.md`, exactly one
level deep:

```bash
git clone https://github.com/NIRVANA-APOC/meow-push-skill.git
cp -r meow-push-skill ~/.dsh/skills/meow-push          # DeepSeek Harness
# cp -r meow-push-skill ~/.claude/skills/meow-push     # Claude Code
```

The skill registers under the `name` in its frontmatter (`meow-push`) regardless of the directory
name. Then invoke the bundled CLI:

```bash
node "<skill-dir>/scripts/meow-push.mjs" send --to JohnDoe --msg "hello" --json
```

No install step is needed: `dist/` is committed, so a bare `node` (≥ 20) runs the CLI. If `dist/`
is missing, the launcher falls back to running the TypeScript sources directly on Node ≥ 22.18.

## Commands

| Command | Purpose |
| --- | --- |
| `send` | Push one message. Never retries. |
| `preview` | Build and print the request without sending it (same as `send --dry-run` / `send -n`). |
| `doctor` | Local self-check. `--probe` also hits the API root to test reachability and detect egress-IP restrictions. Never pushes. |
| `schema` | Machine-readable description of every command, flag, and exit code. |

```bash
meow-push preview --to JohnDoe --title "系统通知" --msg "<b>hello</b>" --type html
meow-push send    --to JohnDoe --title "Build" --msg-file ./notice.html --type html --json
meow-push send    --to JohnDoe --msg "hi" --url https://example.com --img-url https://example.com/i.png
meow-push doctor --probe
meow-push schema
```

Run `meow-push help` for the full flag list.

## Exit codes

Exit codes are the contract for an agent — no text parsing required.

| Code | Meaning | What an agent should do |
| --- | --- | --- |
| `0` | Accepted by the server. `--json`'s `confirmed` says whether the envelope carried `data: true`. | Report it as sent; with `confirmed: false` say "submitted", not "confirmed". |
| `1` | Local argument error. **Nothing was sent.** | Fix the arguments and retry. |
| `2` | Indeterminate: network error, timeout, redirect, 5xx, HTTP/business status conflict, unparseable body. | **Never retry automatically.** Tell the user delivery is unknown. |
| `3` | Rejected: business `400` / `403` / `404`. | Retrying identical input cannot help. |
| `4` | Rate limited or IP restricted (`429`). | Do not loop. |
| `5` | Semantic conflict: business `200` with `data: false`. | Treat as a failure; do not resend. |

`--json` also emits a stable `reason` field (`business_404`, `timeout`, `redirect_not_followed`, …)
to distinguish cases that share an exit code. See [`SKILL.md`](SKILL.md) for the full table.

## Response handling

Success requires business `status === 200`, and the CLI never claims more than the server said:

| Server response | Reported as |
| --- | --- |
| `{"status":200,"data":true,"msg":"发送成功"}` | accepted, `confirmed: true` |
| `{"status":200,"msg":"…"}` (no `data`) | accepted, `confirmed: false` — "submitted" |
| `{"status":200,"data":false}` | exit `5`, semantic conflict |
| `{"status":404,…}` | exit `3`, nickname not registered |
| non-JSON / empty / unparseable | exit `2`, unknown — never replayed |

## Layout

```
SKILL.md                     Agent-facing contract (the skill entry point)
README.md / README.zh-CN.md  This file, English and Chinese
CHANGELOG.md                 Release notes
LICENSE                      MIT
references/api.md            Offline API reference and observed-vs-documented notes
references/openapi.json      The upstream OpenAPI 3.1 document, exported verbatim
src/                         TypeScript CLI source
  main.ts                    Executable entry
  cli.ts                     Command dispatch, flag tables, output, exit-code mapping
  client.ts                  Request construction, HTTP, response classification
  args.ts                    Parser (one flag table drives --help and schema)
  errors.ts, types.ts        Shared error class, types and exit codes
dist/                        Compiled output (committed so the skill runs with no build)
scripts/meow-push.mjs        Launcher: prefers dist/, falls back to the TS sources
scripts/mock-server.mjs      Local MeoW API stand-in for tests and manual checks
scripts/test.mjs             68 end-to-end tests, no network required
scripts/scan-secrets.mjs     Guard against publishing private data
scripts/check-dist-sync.mjs  Verifies the committed dist/ matches src/
```

## Development

```bash
npm ci
npm run verify     # typecheck → build → dist-sync → tests → secret scan
```

Individual steps: `npm run typecheck`, `npm run build`, `npm test`, `npm run check:dist-sync`,
`npm run scan:secrets`.

`npm test` starts the bundled mock API on an ephemeral port and drives the real CLI in-process. It
needs no network, no credentials and no registered nickname, so it is safe to run anywhere. It
covers request construction, strict RFC 3986 encoding, every response-envelope shape, all six exit
codes, 21 local-validation cases (each asserting that *zero* requests were sent), and the
guarantees that `preview` never sends and that every send path issues exactly one request.

Manual poking against the mock:

```bash
npm run mock                                    # terminal 1
node scripts/meow-push.mjs send --to demo --msg hi \
  --base-url http://127.0.0.1:8787 --allow-http # terminal 2
```

## Design principles

- **Never risk a duplicate.** No automatic retries, no redirect following, one request per
  invocation. An inconclusive result is surfaced as inconclusive.
- **Only documented routes.** `POST /{nickname}/{title}`; an omitted title is filled in locally
  with the documented default `MeoW`.
- **`msgType` and `htmlHeight` are query parameters**, never JSON body fields.
- **Strict RFC 3986 encoding** — only the unreserved set stays literal, and spaces become `%20`,
  not `+`.
- **What you preview is what is sent.** Path segments that the URL parser would rewrite (`.`,
  `..`) are rejected outright, and `--url` values are normalised before transmission.
- **No silent success.** `data: true` means the server accepted the push, not that a device
  received it, and the wording always stays within that limit.
- **Plain HTTP is refused** unless `--allow-http` is passed, because message content travels in the
  request.

## Verification status

- 68/68 automated tests pass; CI runs them on Node 20, 22 and 24.
- `references/openapi.json` was diffed against the OpenAPI document embedded in the live API page
  and matches exactly.
- Response classification and the exit-code mapping were exercised against the real
  `api.chuckfang.com` endpoint.
- A **successful live push was not verified**: the upstream service restricts the egress IP that
  was available during development and returns `429 IP限制，请联系开发者` for every request. The
  success path is therefore covered by the bundled mock, and the failure path by the live probe
  (`meow-push doctor --probe`). See [`references/api.md`](references/api.md) §5.

## License

[MIT](LICENSE)
