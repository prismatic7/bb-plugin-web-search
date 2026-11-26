// bb-plugin-web-search — search and read the web from a BB thread.
//
// BB ships no web access, and every provider a thread runs on has a different
// idea of what "search" means. This plugin gives all of them the same pair of
// tools over a provider chain that prefers what is already on this network:
//
//   searxng   → the homelab instance (metasearch, keyless, no rate limit we own)
//   keenable  → the local CLI's index (keyless, carries acquisition dates)
//   brave     → API key
//   serper    → API key
//
// The first provider that answers wins; the others are never called. Every
// result names the provider that produced it, because a metasearch hit and an
// index hit are not the same kind of evidence.
//
// Extraction prefers `keenable fetch`, which returns markdown, and falls back
// to fetching the page and stripping tags.
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFileCb);

export type ProviderName = "searxng" | "keenable" | "brave" | "serper";

export interface Result {
  title: string;
  url: string;
  snippet: string;
  provider: ProviderName;
  acquired?: string;
}

// ─── Normalisers (pure) ───────────────────────────────────────────────

/** SearXNG JSON: {results:[{title,url,content}]}. */
export function normaliseSearxng(body: any): Result[] {
  const rows = Array.isArray(body?.results) ? body.results : [];
  return rows
    .filter((r: any) => r && typeof r.url === "string")
    .map((r: any) => ({
      title: String(r.title ?? r.url),
      url: r.url,
      snippet: tidy(String(r.content ?? "")),
      provider: "searxng" as const,
    }));
}

/** Keenable YAML: {results:[{title,url,snippet,acquired_at}]}. */
export function normaliseKeenable(yamlText: string): Result[] {
  let doc: any;
  try {
    doc = parseYaml(yamlText);
  } catch {
    return [];
  }
  const rows = Array.isArray(doc?.results) ? doc.results : [];
  return rows
    .filter((r: any) => r && typeof r.url === "string")
    .map((r: any) => ({
      title: String(r.title ?? r.url),
      url: r.url,
      snippet: tidy(String(r.snippet ?? "")),
      provider: "keenable" as const,
      acquired: r.acquired_at ? String(r.acquired_at) : undefined,
    }));
}

/** Brave's web search JSON. */
export function normaliseBrave(body: any): Result[] {
  const rows = body?.web?.results;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r: any) => r && typeof r.url === "string")
    .map((r: any) => ({
      title: String(r.title ?? r.url),
      url: r.url,
      snippet: tidy(String(r.description ?? "")),
      provider: "brave" as const,
    }));
}

/** Serper's /search JSON. */
export function normaliseSerper(body: any): Result[] {
  const rows = body?.organic;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r: any) => r && typeof r.link === "string")
    .map((r: any) => ({
      title: String(r.title ?? r.link),
      url: r.link,
      snippet: tidy(String(r.snippet ?? "")),
      provider: "serper" as const,
    }));
}

/** Collapse whitespace and trim a snippet to a readable length. */
export function tidy(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat;
}

/** Dedupe by URL, keeping the first (highest-priority) provider's copy. */
export function dedupe(results: Result[]): Result[] {
  const seen = new Set<string>();
  const out: Result[] = [];
  for (const r of results) {
    const key = r.url.replace(/#.*$/, "").replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Walk the chain until a provider returns results. `run` is injected so the
 * order and the stop-at-first-success rule are testable without a network.
 */
export async function firstProvider(
  order: ProviderName[],
  run: (p: ProviderName) => Promise<Result[]>,
  onError?: (p: ProviderName, message: string) => void,
): Promise<{ provider: ProviderName | null; results: Result[]; tried: ProviderName[] }> {
  const tried: ProviderName[] = [];
  for (const p of order) {
    tried.push(p);
    try {
      const results = await run(p);
      if (results.length) return { provider: p, results, tried };
    } catch (err: any) {
      onError?.(p, err?.message ?? String(err));
    }
  }
  return { provider: null, results: [], tried };
}

/** Strip a page down to readable text, for the no-keenable fallback. */
export function htmlToText(html: string): string {
  const withoutHead = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = withoutHead
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|pre|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function decodeEntities(text: string): string {
  const map: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => map[name.toLowerCase()] ?? m);
}

/** Render results for the agent: numbered, with provider and URL. */
export function renderResults(query: string, provider: string | null, results: Result[], tried: string[]): string {
  if (!results.length) {
    return `bb_web_search: no results for "${query}" (tried: ${tried.join(" → ") || "nothing configured"})`;
  }
  const lines = results.map(
    (r, i) =>
      `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}${r.acquired ? `\n   acquired ${r.acquired.slice(0, 10)}` : ""}`,
  );
  return `bb_web_search "${query}" — ${results.length} result(s) via ${provider}${tried.length > 1 ? ` (after ${tried.slice(0, -1).join(", ")})` : ""}\n\n${lines.join("\n\n")}`;
}

// ─── Plugin ───────────────────────────────────────────────────────────

const ORDER_DEFAULT = "searxng,keenable,brave,serper";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("bb-plugin-web-search loaded");

  const settings = bb.settings.define({
    providerOrder: {
      type: "string" as const,
      label: "Provider order",
      default: ORDER_DEFAULT,
      description: "Comma-separated. The first provider that returns results wins.",
    },
    searxngUrl: {
      type: "string" as const,
      label: "SearXNG URL",
      default: process.env.SEARXNG_INSTANCE_URL ?? "",
      description: "Base URL of a SearXNG instance with JSON output enabled.",
    },
    keenablePath: {
      type: "string" as const,
      label: "Keenable CLI",
      default: process.env.KEENABLE_CLI_PATH ?? "keenable",
      description: "Path to the keenable binary. Empty = disabled.",
    },
    braveApiKey: {
      type: "string" as const,
      label: "Brave API key",
      secret: true,
      default: process.env.BRAVE_API_KEY ?? "",
      description: "Optional. Leave empty to skip Brave.",
    },
    serperApiKey: {
      type: "string" as const,
      label: "Serper API key",
      secret: true,
      default: process.env.SERPER_API_KEY ?? "",
      description: "Optional. Leave empty to skip Serper.",
    },
    maxResults: {
      type: "number" as const,
      label: "Results per search",
      default: 8,
      description: "Cap on returned results.",
    },
  });

  let cfg = await settings.get();
  settings.onChange((next) => {
    cfg = next;
    bb.log.info(`[web-search] settings changed → ${cfg.providerOrder}`);
  });

  const order = (): ProviderName[] =>
    cfg.providerOrder
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is ProviderName => ["searxng", "keenable", "brave", "serper"].includes(s));

  async function searchSearxng(query: string): Promise<Result[]> {
    if (!cfg.searxngUrl.trim()) throw new Error("no SearXNG URL configured");
    const url = `${cfg.searxngUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
    return normaliseSearxng(await res.json());
  }

  async function searchKeenable(query: string): Promise<Result[]> {
    const bin = cfg.keenablePath.trim();
    if (!bin) throw new Error("keenable disabled");
    const { stdout } = await execFileAsync(bin, ["search", query], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    return normaliseKeenable(stdout);
  }

  async function searchBrave(query: string): Promise<Result[]> {
    if (!cfg.braveApiKey.trim()) throw new Error("no Brave key");
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${cfg.maxResults}`,
      { headers: { accept: "application/json", "x-subscription-token": cfg.braveApiKey.trim() }, signal: AbortSignal.timeout(20_000) },
    );
    if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
    return normaliseBrave(await res.json());
  }

  async function searchSerper(query: string): Promise<Result[]> {
    if (!cfg.serperApiKey.trim()) throw new Error("no Serper key");
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cfg.serperApiKey.trim() },
      body: JSON.stringify({ q: query, num: cfg.maxResults }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
    return normaliseSerper(await res.json());
  }

  const adapters: Record<ProviderName, (q: string) => Promise<Result[]>> = {
    searxng: searchSearxng,
    keenable: searchKeenable,
    brave: searchBrave,
    serper: searchSerper,
  };

  bb.agents.registerTool({
    name: "bb_web_search",
    description:
      "Search the web and get ranked results with URLs and snippets. Providers are tried in order — " +
      "the homelab SearXNG instance, the local Keenable index, then Brave and Serper if keys are set — " +
      "and the answer says which one produced it. Use it for current information, library documentation " +
      "and anything the codebase cannot answer; follow up with bb_web_extract to read a page.",
    parameters: z.object({
      query: z.string().min(1).describe("What to search for."),
      maxResults: z.number().int().min(1).max(20).optional().describe("Cap on results (default 8)."),
    }),
    async execute({ query, maxResults }) {
      const { provider, results, tried } = await firstProvider(order(), (p) => adapters[p](query), (p, m) =>
        bb.log.warn(`[web-search] ${p}: ${m}`),
      );
      const cap = maxResults ?? cfg.maxResults;
      return renderResults(query, provider, dedupe(results).slice(0, cap), tried);
    },
  });

  bb.agents.registerTool({
    name: "bb_web_extract",
    description:
      "Read a web page as markdown text. Prefers the Keenable CLI's fetch (clean markdown); falls back " +
      "to fetching the page and stripping tags. Returns the URL, the title if known, and the text, " +
      "capped. Use it after bb_web_search, or on a URL the user gave you.",
    parameters: z.object({
      url: z.string().url().describe("Page URL."),
      maxChars: z.number().int().min(1000).max(100_000).optional().describe("Text cap (default 20000)."),
    }),
    async execute({ url, maxChars }) {
      const cap = maxChars ?? 20_000;
      const bin = cfg.keenablePath.trim();
      if (bin) {
        try {
          const { stdout } = await execFileAsync(bin, ["fetch", url, "--max-chars", String(cap)], {
            timeout: 90_000,
            maxBuffer: 8 * 1024 * 1024,
          });
          const doc: any = parseYaml(stdout);
          const first = Array.isArray(doc?.results) ? doc.results[0] : doc?.result ?? doc;
          const content = String(first?.content ?? first?.markdown ?? "");
          if (content.trim()) {
            return `# ${first?.title ?? url}\n${url}\n\n${content.slice(0, cap)}`;
          }
        } catch (err: any) {
          bb.log.warn(`[web-search] keenable fetch failed, falling back: ${err?.message}`);
        }
      }
      try {
        const res = await fetch(url, {
          headers: { "user-agent": "Mozilla/5.0 (compatible; bb-plugin-web-search)", accept: "text/html,*/*" },
          signal: AbortSignal.timeout(30_000),
          redirect: "follow",
        });
        if (!res.ok) return `bb_web_extract: HTTP ${res.status} for ${url}`;
        const type = res.headers.get("content-type") ?? "";
        const body = await res.text();
        const text = type.includes("html") ? htmlToText(body) : body;
        const title = /<title>([^<]{1,300})<\/title>/i.exec(body)?.[1]?.trim();
        return `# ${title ?? url}\n${url}\n\n${text.slice(0, cap)}${text.length > cap ? "\n… truncated" : ""}`;
      } catch (err: any) {
        return `bb_web_extract failed: ${err?.message ?? String(err)}`;
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("bb-plugin-web-search disposed");
  });
}
