# pi-firecrawl-native

A small standalone Pi package exposing three bounded native Firecrawl tools:

- `firecrawl_developer` — matched developer docs, README, issue, and PR passages
- `firecrawl_question` — one generated focused answer from one known public URL
- `firecrawl_search` — explicit web/news, category, and recency search controls

**Current revision: implemented; validation pending.**

## Install

From this checkout:

```bash
pi install /home/brian/Projects/pi-firecrawl-native
```

Or from the reviewable GitHub repository:

```bash
pi install git:github.com/TreptowerPark/pi-firecrawl-native
```

Try for one run without changing settings:

```bash
pi -e /home/brian/Projects/pi-firecrawl-native/index.ts
```

## Contracts

All tools return compact JSON-shaped text. Default result limits are three and
cap at ten. Passages and snippets are capped at 650 characters; focused answers
are capped at 4,000 characters. A result has `truncated: true` when a bounded
field was clipped. Passage, snippet, and answer formatting preserves meaningful
newlines, indentation, and code fences while removing terminal escapes and
unsafe control characters.

### `firecrawl_developer`

An unscoped search uses the installed CLI. Supplying `type` or `repo` switches
to the Developer Index HTTP interface so the server receives its structured
`types` and `repos` filters before applying the small result limit. Returned
results must match the requested artifact type; repository-scoped results also
report the interface's `indexed` status.

A GitHub `repo` scope applies only to repository artifacts (`readme`, `issue`,
and `pull_request`). Firecrawl documentation sources use separate source IDs;
this package has no source-ID parameter and therefore rejects `repo` with
`type: "doc"` rather than treating a repository as documentation scope.

### `firecrawl_question`

The question tool sends only Firecrawl's focused `question` format to the
structured scrape interface. It accepts an answer only from a successful
structured response with `data.answer`; failed, malformed, missing-answer, and
other response shapes are errors. It never turns command output, Markdown, or
page content into an answer.

Its result includes the submitted source URL and labels the answer as a
`generated_summary` with evidence `not independently verified`; it is not a
quotation or independently verified evidence.

Before submission, a URL must be HTTP(S), credential-free, and public. The
client rejects local names, non-public IPv4/IPv6 literals, and names that do
not resolve exclusively to public IP addresses. This is client-side validation,
not proof that Firecrawl's own DNS resolution or redirect handling is similarly
constrained.

## Authentication

The CLI remains the transport for unscoped developer search and advanced search.
For structured developer scopes and focused questions, the extension reuses the
same existing `FIRECRAWL_API_KEY` / `FIRECRAWL_API_URL` configuration or the
Firecrawl CLI credential store. Credentials are used only in memory for the
request authorization: they are not copied into source, tracked files, command
arguments, output, errors, or logs. `PI_FIRECRAWL_COMMAND` still overrides the
CLI executable name for the operations that use it.

## Scope

This package intentionally exposes no Agent, Interact, Crawl, Map, bulk
scraping, page-specific highlights, full search Markdown, or research-paper
index tool. Use the existing on-demand Firecrawl router skill for Interact and
other deliberate full workflows.
