# Offline correctness-pass test record

Tested production revision: `5765f61a362d1293b47b49c976c2778a88a256cb`.

Commands run from this repository:

```bash
node --experimental-strip-types --check index.ts
node --experimental-strip-types --test --test-concurrency=1 \
  --import ./test/preload.mjs ./test/index.test.mjs
```

The syntax check passed. It is not a complete TypeScript type check: this small
package has no local TypeScript project configuration or installed dependencies.
The test suite imported the extension with the installed Pi packages and invoked
its registered handlers.

## Fixtures and isolation

`test/preload.mjs` maps only the extension's DNS, filesystem credential read,
and child-process imports to deterministic mocks. `globalThis.fetch` is also
mocked. Credentials, DNS records, CLI output, HTTP responses, cancellation, and
timeouts are synthetic; no real credential store, CLI, network, Firecrawl API,
model, or service is used.

The focused-question fixtures follow the installed Firecrawl SDK's
`QuestionFormat` and scrape envelope (`src/v2/types.ts` and
`src/v2/methods/scrape.ts`). Developer fixtures follow the installed CLI's
Developer Index endpoint and response declarations (`dist/commands/developer.js`
and `dist/types/developer.d.ts`).

## Result

The final suite run had **13 passing tests and 0 failing tests**.

Passed coverage includes registration/import, focused-question response
rejection and formatting/bounds, CLI and structured developer scoping,
advanced-search arguments and bounds, public URL/DNS rejection paths, synthetic
credential precedence, error sanitization, cancellation, timeout, and response
size limits.

### Resolved redirect-safety defect

`direct HTTP disables automatic API redirects` now passes. The shared
`requestFirecrawlJson` fetch init explicitly sets `redirect: "error"`, so all
structured direct requests fail closed on redirects rather than following them.
The test confirms that policy in the mocked fetch call.

## Authenticated live validation — 2026-09-11

This validation used the production implementation in
`5765f61a362d1293b47b49c976c2778a88a256cb`. Immediately beforehand,
`git diff 5765f61a362d1293b47b49c976c2778a88a256cb -- index.ts` was empty.
The globally installed package resolved to this checkout (`pi list`), and an
actual import through the installed Pi APIs registered exactly:

- `firecrawl_developer`
- `firecrawl_question`
- `firecrawl_search`

No `web_search` tool is registered or overridden by this package. The existing
Pi web-search configuration still selects `exa` when no provider is supplied.
No Pi reload, source/routing/configuration change, retry, or local-validation
failure was performed.

A temporary, non-repository harness invoked the five requested calls serially
against the configured authenticated Firecrawl CLI/API. It recorded only
transport metadata, bounded output measurements, response keys, and
credit/rate-limit fields; it did not print or retain credentials or result text.
All five calls succeeded:

| Call | Transport | Handler latency | Bounded output | Observable credits | Contract observation |
|---|---|---:|---|---|---|
| Unscoped developer (`Firecrawl`, limit 1) | CLI | 1,858 ms | 1 result; 284-char passage; 432 B result | none exposed | CLI exited 0 with `success`, `results`, and tolerated `partial`; exact args used `developer … --limit 1 --json`. |
| Repository developer (`firecrawl/firecrawl`, limit 1) | Direct HTTP | 1,324 ms | 1 result; 650-char clipped passage; 973 B result | none exposed | `GET /v2/search/developer` returned HTTP 200 and confirmed `{ repo: "firecrawl/firecrawl", indexed: true }`; repeated README/issue/PR `types` filters were sent before `k=1`. |
| Repository issue developer (`firecrawl/firecrawl`, `issue`, limit 1) | Direct HTTP | 689 ms | 1 result; 20-char passage; 303 B result | none exposed | HTTP 200; response scope confirmed indexed and request sent only `types=issue` before `k=1`. |
| Focused question (`https://example.com/`) | Direct HTTP | 893 ms | 14-char answer; 133 B result | none exposed | `POST /v2/scrape` returned HTTP 200 with `success` and `data.answer`; no page Markdown was returned. |
| Advanced search (`Firecrawl`, `github`, limit 1) | CLI | 1,248 ms | 1 result; 642-char snippet; 859 B result | `creditsUsed: 2` | CLI exited 0; exact args included `--highlights --json --categories github`; raw envelope used `success`, `data`, `id`, and `creditsUsed`. |

The three direct HTTP responses were all HTTP 200 and each observed real fetch
init had `redirect: "error"`; no redirect was observed. The developer envelopes
had `success`, `results`, `repos`, and tolerated `partial`; the focused-question
envelope had `success` plus `data.answer` and `data.metadata`. There were no
response-shape mismatches, output-bound violations, or result-count violations.
No direct-HTTP credit or rate-limit header/body field was exposed for the two
Developer Index calls or the focused question, and the unscoped developer CLI
envelope exposed none.

## Remaining limits

The offline suite remains **13 passing tests and 0 failing tests**; it and the
live results are separate evidence. The live run establishes these specific
wire calls under the then-current authenticated account, not universal API
compatibility. It does not prove Firecrawl-side DNS resolution or destination
redirect constraints, keyless behavior, every response shape/error path, or
performance/context measurements.
