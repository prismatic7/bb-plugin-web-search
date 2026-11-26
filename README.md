# bb-plugin-web-search

Search and read the web from any BB thread. BB ships no web access of its own,
and each provider in a thread has a different idea of what "search" means; this
gives them all the same two tools.

## Tools

### `web_search(query, maxResults?)`

Walks a provider chain and stops at the first provider that answers:

| Provider | What it is | Cost |
|---|---|---|
| `searxng` | The homelab SearXNG instance (metasearch) | keyless, self-hosted |
| `keenable` | The local Keenable CLI's index | keyless, local |
| `brave` | Brave Search API | key |
| `serper` | Serper (Google) | key |

The result block names the provider that produced it — a metasearch hit and an
indexed hit are different kinds of evidence, and Keenable's results carry their
acquisition date. Duplicates across providers are collapsed by URL.

Order is a setting (`searxng,keenable,brave,serper` by default); a provider
with no URL, no binary or no key is skipped, and its reason is logged.

### `web_extract(url, maxChars?)`

Reads a page as markdown: `keenable fetch` first, then a plain HTTP fetch with
tags, scripts and styles stripped. Capped, with the URL and title returned so a
citation is possible.

## Settings

| Setting | Default |
|---|---|
| `providerOrder` | `searxng,keenable,brave,serper` |
| `searxngUrl` | `SEARXNG_INSTANCE_URL` |
| `keenablePath` | `KEENABLE_CLI_PATH` or `keenable` |
| `braveApiKey` | `BRAVE_API_KEY` (secret) |
| `serperApiKey` | `SERPER_API_KEY` (secret) |
| `maxResults` | `8` |

## Install

```sh
npm install
npm run bundle
bb plugin install . --yes
bb plugin reload web-search
```

## Development

```sh
npm run build      # tsc typecheck
npm test           # normalisers, chain, HTML fallback, plus live SearXNG/keenable checks
npm run bundle     # bb plugin build → dist/
```

The live tests skip when `SEARXNG_INSTANCE_URL` is unset or `keenable` is not on
PATH, so the suite is honest in CI and thorough on this machine.
