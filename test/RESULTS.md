# Offline correctness-pass test record

Tested production revision: `03c2c80ed24bf54e1dcc09965cbf780391ea0ae6`.

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

The final suite run had **12 passing tests and 1 failing test**.

Passed coverage includes registration/import, focused-question response
rejection and formatting/bounds, CLI and structured developer scoping,
advanced-search arguments and bounds, public URL/DNS rejection paths, synthetic
credential precedence, error sanitization, cancellation, timeout, and response
size limits.

### Actionable failure: structured HTTP redirect policy

`direct HTTP disables automatic API redirects` fails reproducibly:

```text
actual fetch init.redirect: undefined
expected: "error"
```

`requestFirecrawlJson` does not set `redirect: "error"` on credentialed direct
fetches. This leaves redirect handling to the runtime default. The mocked test
does not claim to prove where credentials would travel after a real redirect,
but the client does not explicitly reject redirects. This requires a separate
implementation decision/fix; no production behavior was changed here.

## Untested

Live Firecrawl wire compatibility, authenticated/keyless server behavior,
Firecrawl-side DNS/redirect behavior, real CLI behavior, and performance/context
measurements remain untested. **Live validation pending.**
