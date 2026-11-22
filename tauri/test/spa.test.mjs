// One-document frontend (KOTOBA-159): the router's pure functions, and the folded build of the real pages.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashFor, idKey, normalizePage, routeFromHash, routeFromHref } from "../src/spa.js";

const here = fileURLToPath(new URL("../", import.meta.url));
const pages = new Set(["/index.html", "/domains.html", "/history.html", "/study/cisa.html", "/study/cissp.html", "/bot.html"]);
const base = "https://tauri.localhost/index.html#/domains.html";

test("router: links map to folded pages and anchors; others are left alone", () => {
  assert.equal(normalizePage("/", pages), "/index.html");
  assert.equal(normalizePage("/nope.html", pages), null);
  assert.deepEqual(routeFromHref("/", base, pages), { page: "/index.html", anchor: "" });
  assert.deepEqual(routeFromHref("/domains.html", base, pages), { page: "/domains.html", anchor: "" });
  assert.deepEqual(routeFromHref("/study/cissp.html#d3", base, pages), { page: "/study/cissp.html", anchor: "d3" });
  assert.equal(routeFromHref("https://github.com/etzhayyim/root", base, pages), null);
  assert.equal(routeFromHref("/unknown.html", base, pages), null);
  assert.equal(routeFromHref("#d1", base, pages), null);
  assert.equal(routeFromHref("", base, pages), null);
});

test("router: the hash round-trips, and an empty or unknown hash is the start page", () => {
  for (const r of [{ page: "/index.html", anchor: "" }, { page: "/study/cisa.html", anchor: "d5" }, { page: "/history.html", anchor: "" }]) {
    assert.deepEqual(routeFromHash(hashFor(r), pages), r);
  }
  assert.deepEqual(routeFromHash("", pages), { page: "/index.html", anchor: "" });
  assert.deepEqual(routeFromHash("#/evil.html", pages), { page: "/index.html", anchor: "" });
  assert.equal(idKey("/study/cisa.html"), "study-cisa");
});

const strip = (html) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
const bodyOf = (html) => /<body[^>]*>([\s\S]*)<\/body>/iu.exec(html)[1];

test("the real build is one document that keeps every page's text, with unique ids and no dead links", () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), "tauri-spa-")), "dist");
  execFileSync(process.execPath, [path.join(here, "scripts/build.mjs")], { env: { ...process.env, TAURI_DIST: out }, stdio: "pipe" });
  const html = readdirSync(out, { recursive: true }).filter((f) => String(f).endsWith(".html"));
  assert.deepEqual(html, ["index.html"]);
  const doc = readFileSync(path.join(out, "index.html"), "utf8");
  const sections = [...doc.matchAll(/<section data-page="([^"]+)" data-title="([^"]*)"( hidden)?>([\s\S]*?)<\/section>/gu)];
  assert.deepEqual(new Set(sections.map((m) => m[1])), pages);
  assert.deepEqual(sections.filter((m) => !m[3]).map((m) => m[1]), ["/index.html"], "only the start page is visible at first");
  const sources = { "/index.html": "../public/index.html", "/domains.html": "../public/domains.html", "/history.html": "../public/history.html",
    "/study/cisa.html": "../public/study/cisa.html", "/study/cissp.html": "../public/study/cissp.html", "/bot.html": "src/bot/bot.html" };
  for (const m of sections) {
    const source = readFileSync(path.join(here, sources[m[1]]), "utf8");
    assert.equal(m[2], /<title>([^<]*)<\/title>/u.exec(source)[1], `${m[1]} title`);
    let text = strip(m[4]);
    if (m[1] === "/index.html") text = text.replace(/^(.*?)bot /u, "$1"); // the build adds the bot link to the start page's nav
    assert.equal(text, strip(bodyOf(source)), `${m[1]} text`);
  }
  const ids = [...doc.matchAll(/\sid="([^"]+)"/gu)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "ids are unique in the document");
  for (const p of ["study-cisa", "study-cissp"]) for (let n = 1; n <= 5; n++) assert.ok(ids.includes(`${p}--d${n}`), `${p}--d${n}`);
  for (const [, href] of doc.matchAll(/<a\b[^>]*\shref="([^"]+)"/gu)) {
    if (/^https:\/\//u.test(href)) continue;
    const route = routeFromHref(href, "https://tauri.localhost/index.html", pages);
    assert.ok(route, `internal link ${href} resolves to a folded page`);
    if (route.anchor) assert.ok(ids.includes(`${idKey(route.page)}--${route.anchor}`) || ids.includes(route.anchor), `anchor ${href}`);
  }
  const scripts = [...doc.matchAll(/<script\b[^>]*src="([^"]+)"/gu)].map((m) => m[1]);
  assert.deepEqual(scripts, ["/host.js", "/calm.js", "/bot.js", "/spa.js"], "each script once; the host first");
});

test("folding fails closed on a page without <body> or with an inline script", () => {
  for (const [label, page] of [["no body", "<html><head></head></html>"], ["inline script", "<html><head></head><body><script>x()</script></body></html>"]]) {
    const dir = mkdtempSync(path.join(tmpdir(), "tauri-spa-bad-"));
    mkdirSync(path.join(dir, "in"));
    writeFileSync(path.join(dir, "in/index.html"), "<html><head></head><body><nav></nav></body></html>");
    writeFileSync(path.join(dir, "in/other.html"), page);
    assert.throws(() => execFileSync(process.execPath, [path.join(here, "scripts/build.mjs")], { env: { ...process.env, STATIC_SRC: path.join(dir, "in"), TAURI_DIST: path.join(dir, "out"), BOT_PAGE: "0" }, stdio: "pipe" }), /tauri build/u, label);
  }
});
