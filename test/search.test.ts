// web-search tests: normalisers, dedupe, the chain's stop-at-first-success
// rule, the text fallback, and live checks against the providers that are
// configured in this environment.
//
// Run: node --test test/search.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  dedupe,
  firstProvider,
  htmlToText,
  normaliseBrave,
  normaliseKeenable,
  normaliseSearxng,
  normaliseSerper,
  renderResults,
  tidy,
} from "../server.ts";

const SEARXNG = { results: [
  { title: "A", url: "https://a.example/x", content: "  alpha\n   beta  " },
  { title: "B", url: "https://b.example/", content: "gamma" },
] };

const KEENABLE = `query: q
results:
- title: K1
  url: https://k.example/one
  acquired_at: 2026-11-24T17:56:31Z
  snippet: |-
    line one
    line two
`;

test("normaliseSearxng maps and tidies", () => {
  const r = normaliseSearxng(SEARXNG);
  assert.equal(r.length, 2);
  assert.equal(r[0].provider, "searxng");
  assert.equal(r[0].snippet, "alpha beta");
});

test("normaliseKeenable parses YAML and keeps the acquisition date", () => {
  const r = normaliseKeenable(KEENABLE);
  assert.equal(r.length, 1);
  assert.equal(r[0].provider, "keenable");
  assert.match(r[0].snippet, /line one line two/);
  assert.equal(r[0].acquired, "2026-11-24T17:56:31Z");
});

test("normaliseKeenable survives output that is not YAML", () => {
  assert.deepEqual(normaliseKeenable("<html>nope"), []);
});

test("brave and serper normalisers", () => {
  assert.equal(normaliseBrave({ web: { results: [{ title: "T", url: "https://x.example", description: "d" }] } })[0].provider, "brave");
  assert.equal(normaliseSerper({ organic: [{ title: "T", link: "https://y.example", snippet: "s" }] })[0].url, "https://y.example");
  assert.deepEqual(normaliseBrave({}), []);
  assert.deepEqual(normaliseSerper({}), []);
});

test("dedupe keeps the first provider's copy of a URL", () => {
  const merged = dedupe([
    { title: "a", url: "https://x.example/p/", snippet: "", provider: "searxng" },
    { title: "b", url: "https://x.example/p", snippet: "", provider: "brave" },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].provider, "searxng");
});

test("the chain stops at the first provider that returns results", async () => {
  const calls: string[] = [];
  const out = await firstProvider(["searxng", "keenable", "brave"], async (p) => {
    calls.push(p);
    if (p === "searxng") return [];
    return [{ title: "hit", url: "https://h.example", snippet: "", provider: p }];
  });
  assert.equal(out.provider, "keenable");
  assert.deepEqual(calls, ["searxng", "keenable"]);
});

test("a failing provider is skipped, and the failures are reported", async () => {
  const errors: string[] = [];
  const out = await firstProvider(
    ["brave", "searxng"],
    async (p) => {
      if (p === "brave") throw new Error("no Brave key");
      return [{ title: "hit", url: "https://h.example", snippet: "", provider: p }];
    },
    (_p, m) => errors.push(m),
  );
  assert.equal(out.provider, "searxng");
  assert.deepEqual(errors, ["no Brave key"]);
  assert.deepEqual(out.tried, ["brave", "searxng"]);
});

test("nothing configured renders a clear miss", () => {
  const out = renderResults("q", null, [], []);
  assert.match(out, /no results/);
  assert.match(out, /nothing configured/);
});

test("renderResults names the provider and its fallbacks", () => {
  const out = renderResults(
    "q",
    "searxng",
    [{ title: "T", url: "https://x.example", snippet: "s", provider: "searxng" }],
    ["searxng"],
  );
  assert.match(out, /via searxng/);
  const fell = renderResults("q", "keenable", [{ title: "T", url: "https://x.example", snippet: "s", provider: "keenable" }], ["searxng", "keenable"]);
  assert.match(fell, /after searxng/);
});

test("htmlToText drops scripts and keeps structure", () => {
  const html = '<html><head><title>T</title><style>.a{}</style></head><body><h1>Head</h1><p>One &amp; two</p><script>var x=1</script><p>Three</p></body></html>';
  const text = htmlToText(html);
  assert.match(text, /Head/);
  assert.match(text, /One & two/);
  assert.equal(text.includes("var x"), false);
  assert.match(text, /\n/);
});

test("tidy truncates long snippets with an ellipsis", () => {
  const out = tidy("x".repeat(400), 50);
  assert.equal(out.length, 50);
  assert.match(out, /…$/);
});

// ─── Live checks, gated on what this machine actually has ─────────────

test("live: SearXNG answers the JSON API", async (t) => {
  const base = process.env.SEARXNG_INSTANCE_URL;
  if (!base) return t.skip("SEARXNG_INSTANCE_URL not set");
  const res = await fetch(`${base.replace(/\/$/, "")}/search?q=ast-grep&format=json`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(res.ok, true);
  const results = normaliseSearxng(await res.json());
  assert.ok(results.length > 0, "expected at least one result");
  assert.ok(results[0].url.startsWith("http"));
});

test("live: keenable CLI returns parseable YAML", (t) => {
  const bin = process.env.KEENABLE_CLI_PATH || "keenable";
  let stdout: string;
  try {
    stdout = execFileSync(bin, ["search", "ast-grep"], { encoding: "utf8", timeout: 60_000 });
  } catch {
    return t.skip("keenable not available");
  }
  const results = normaliseKeenable(stdout);
  assert.ok(results.length > 0, "expected at least one result");
  assert.equal(results[0].provider, "keenable");
});
