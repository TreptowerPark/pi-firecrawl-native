# pi-firecrawl-native

A small standalone Pi package exposing three bounded native Firecrawl capabilities:

- `firecrawl_developer` — exact docs, README, issue, and PR evidence
- `firecrawl_question` — one focused answer from one known HTTP(S) URL
- `firecrawl_search` — explicit web/news, category, and recency controls

The tools return compact JSON-shaped text. Developer passages and search
highlights are bounded; the question tool returns the focused answer only and
never falls back to page Markdown.

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

## Authentication

The extension invokes the installed `firecrawl` CLI without an API-key
argument. The CLI's existing authentication/configuration is therefore reused
(the usual `~/.config/firecrawl-cli/credentials.json` store or its supported
environment configuration). This package never reads, prints, stores, or
commits the credential.

The CLI must be on `PATH`. Set `PI_FIRECRAWL_COMMAND` only if the executable
has a different name or location.

## Scope

This package intentionally does not expose Firecrawl Agent, Interact, Crawl,
Map, bulk scraping, full search Markdown, or the research paper index. Use the
existing on-demand Firecrawl router skill for Interact and other deliberate
full workflows.

## Development

Pi loads `index.ts` directly; there is no build step. Check syntax with:

```bash
node --experimental-strip-types --check index.ts
```
