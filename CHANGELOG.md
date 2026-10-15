# Changelog

All notable changes to this skill are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-10-16

First public release.

### Added

- `SKILL.md` — agent-facing contract: when to send, what must be confirmed
  before sending, how to interpret each exit code, and the rate-limit and
  egress-IP rules.
- `references/api.md` — offline API reference: routes, parameters, response
  envelope, business codes, limits, and the documented-vs-observed
  discrepancies.
- `references/openapi.json` — the OpenAPI 3.1 document embedded in the upstream
  doc page, exported verbatim for offline parsing.
- Zero-dependency TypeScript CLI (`src/`, compiled to `dist/`) with the
  `send`, `preview`, `doctor` and `schema` commands.
- `scripts/meow-push.mjs` — launcher that prefers the committed `dist/` and
  falls back to running the TypeScript sources where Node strips types natively.
- `scripts/mock-server.mjs` — a local stand-in for the MeoW API.
- `scripts/test.mjs` — 68 end-to-end tests that never touch the network.
- `scripts/scan-secrets.mjs` — guard against publishing private data.
- `scripts/check-dist-sync.mjs` — keeps the committed `dist/` honest.
- GitHub Actions CI across Node 20, 22 and 24.

### Notes

- Success requires business `status === 200`; `data === true` marks it
  confirmed. A `200` without `data` is reported as accepted-but-unconfirmed.
- Pushes are not idempotent: the CLI never retries and never follows
  redirects, so an indeterminate result is reported rather than replayed.
