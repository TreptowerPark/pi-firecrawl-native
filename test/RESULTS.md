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

## Untested

Live Firecrawl wire compatibility, authenticated/keyless server behavior,
Firecrawl-side DNS/redirect behavior, real CLI behavior, and performance/context
measurements remain untested. **Live validation pending.**
