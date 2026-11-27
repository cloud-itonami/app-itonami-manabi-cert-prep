// Package the static bundle as the Tauri frontend: copy it, add the pinned consent
// broker, the host adapter and the descriptor, and derive a per-page CSP from the
// declared service origins. It changes nothing in the source bundle.
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { descriptor, requestedCapabilities } from "../src/descriptor.mjs";
import { clientRuntimeConnectSrc, clientRuntimeProblems } from "../vendor/kotoba-client-runtime.js";
import {
  OVERRIDE_CONF_REL,
  buildNativeCspFromMeta,
  nativeCspParityProblems,
  validateBotsOriginOverride,
} from "./bots-origin.mjs";

const here = fileURLToPath(new URL("../", import.meta.url));
const source = path.resolve(process.env.STATIC_SRC ?? path.join(here, "../public"));
const out = path.resolve(process.env.TAURI_DIST ?? path.join(here, "dist"));
const confPath = path.resolve(process.env.TAURI_CONF ?? path.join(here, "src-tauri/tauri.conf.json"));
const overrideConfPath = path.resolve(process.env.TAURI_OVERRIDE_CONF ?? path.join(here, OVERRIDE_CONF_REL));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => { console.error(`tauri build: ${message}`); process.exit(1); };

const pins = JSON.parse(await readFile(path.join(here, "vendor/PINS.json"), "utf8"));
for (const [name, digest] of Object.entries(pins.files)) {
  if (sha(await readFile(path.join(here, "vendor", name))) !== digest) fail(`canonical runtime pin drift: ${name}`);
}
try { await stat(path.join(source, "index.html")); } catch { fail(`${path.join(source, "index.html")} is missing`); }

// Build-time origin override for local/dev stub testing only (TAURI-CSP-02).
// Committed source & tauri.conf.json always keep production https://bots.itonami.cloud.
let botsOriginOverride = null;
try {
  botsOriginOverride = validateBotsOriginOverride(process.env.MANABI_BOTS_ORIGIN, {
    allowEmulatorHost: process.env.MANABI_BOTS_ALLOW_EMULATOR_HOST === "1",
  });
} catch (err) {
  fail(err.message);
}
if (botsOriginOverride) {
  for (const op of descriptor.operations) op.endpoint.origin = botsOriginOverride;
}

const capabilities = requestedCapabilities(descriptor);
const problems = clientRuntimeProblems(descriptor, capabilities, ["https://tauri.localhost"]);
if (problems.length) fail(`descriptor is invalid: ${JSON.stringify(problems)}`);
const connect = clientRuntimeConnectSrc(descriptor, capabilities, [], ["https://tauri.localhost"]);
const expectedConnectSrc = `${connect === "connect-src 'none'" ? "connect-src 'self'" : connect.replace("connect-src ", "connect-src 'self' ")} ipc: http://ipc.localhost`;

// Always verify base tauri.conf.json carries a non-null CSP (never allow silent csp: null).
let baseTauriConf;
try {
  baseTauriConf = JSON.parse(await readFile(confPath, "utf8"));
} catch {
  fail(`unable to read Tauri config: ${confPath}`);
}
if (typeof baseTauriConf?.app?.security?.csp !== "string" || baseTauriConf.app.security.csp.trim() === "") {
  fail("src-tauri/tauri.conf.json must declare a non-null descriptor-derived app.security.csp");
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(source, out, { recursive: true });
await cp(path.join(here, "vendor/kotoba-client-runtime.js"), path.join(out, "runtime.js"));
await cp(path.join(here, "vendor/kotoba-client-consent.css"), path.join(out, "runtime-consent.css"));
await cp(path.join(here, "src/host.js"), path.join(out, "host.js"));
await cp(path.join(here, "src/bot-domain.mjs"), path.join(out, "bot-domain.js"));
if (botsOriginOverride) {
  // Patch the copied dist file only; the committed source keeps the prod origin.
  const domainJs = await readFile(path.join(out, "bot-domain.js"), "utf8");
  if (!domainJs.includes('export const botsOrigin = "https://bots.itonami.cloud";')) {
    fail("bot-domain.js does not carry the production botsOrigin constant");
  }
  await writeFile(path.join(out, "bot-domain.js"),
    domainJs.replace('export const botsOrigin = "https://bots.itonami.cloud";',
      `export const botsOrigin = ${JSON.stringify(botsOriginOverride)};`));
}
// Bot status page (Tauri host only): the page and the bundled profile.
// The page reaches bots.itonami.cloud only through host.js and the broker.
const botPage = process.env.BOT_PAGE !== "0";
if (botPage) {
  await cp(path.join(here, "src/bot/bot.html"), path.join(out, "bot.html"));
  await cp(path.join(here, "src/bot/bot.js"), path.join(out, "bot.js"));
  if (botsOriginOverride) {
    const botHtml = await readFile(path.join(out, "bot.html"), "utf8");
    await writeFile(path.join(out, "bot.html"),
      botHtml.replaceAll("https://bots.itonami.cloud", botsOriginOverride));
  }
  const profile = JSON.parse(await readFile(path.join(here, "../profiles/business-bot-profile.json"), "utf8"));
  const { profileProblems } = await import("../src/bot-domain.mjs");
  const profileIssues = profileProblems(profile);
  if (profileIssues.length) fail(`bundled bot profile is invalid: ${profileIssues.join(", ")}`);
  await writeFile(path.join(out, "bot-profile.json"), JSON.stringify(profile, null, 2) + "\n");
}
// One document (KOTOBA-159): fold every page into index.html as a hidden
// <section data-page="/x.html">, so the frontend is a single guest document, as
// restricted-wasm-v1 will need. src/spa.js shows one section at a time. Ids that
// more than one page used are prefixed per page (spa.js maps #anchors to them).
// Page scripts are deduplicated and loaded once at the end. ../public is unchanged.
const { idKey } = await import("../src/spa.js");
const pagesFound = [];
await (async function collect(dir) {
  for (const entry of await readdir(path.join(out, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) await collect(rel); else if (rel.endsWith(".html")) pagesFound.push(rel);
  }
})("");
if (!pagesFound.includes("index.html")) fail("index.html is missing");
const ordered = ["index.html", ...pagesFound.filter((rel) => rel !== "index.html").sort()];
const parsed = [];
for (const rel of ordered) {
  const html = await readFile(path.join(out, rel), "utf8");
  if (!/<head[^>]*>/iu.test(html)) fail(`${rel} has no <head>`);
  const body = /<body[^>]*>([\s\S]*)<\/body>/iu.exec(html);
  if (!body) fail(`${rel} has no <body>`);
  const scripts = [...body[1].matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/giu)].map((m) => ({ tag: m[0].trim(), src: m[1] }));
  const content = body[1].replace(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>\s*<\/script>/giu, "");
  if (/<script\b/iu.test(content)) fail(`${rel} has an inline script, which the CSP would block`);
  const title = /<title>([^<]*)<\/title>/iu.exec(html)?.[1] ?? "";
  const ids = [...content.matchAll(/\sid=["']([^"']+)["']/giu)].map((m) => m[1]);
  parsed.push({ rel, page: `/${rel}`, html, content, scripts, title, ids });
}
const idCount = new Map();
for (const p of parsed) for (const id of new Set(p.ids)) idCount.set(id, (idCount.get(id) ?? 0) + 1);
const shared = new Set([...idCount].filter(([, n]) => n > 1).map(([id]) => id));
const escapeAttr = (v) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const sections = parsed.map((p) => {
  const content = p.content.replace(/(\sid=["'])([^"']+)(["'])/giu, (m, a, id, b) => (shared.has(id) ? `${a}${idKey(p.page)}--${id}${b}` : m));
  return `<section data-page="${escapeAttr(p.page)}" data-title="${escapeAttr(p.title)}"${p.rel === "index.html" ? "" : " hidden"}>${content}</section>`;
});
const scriptTags = [];
for (const p of parsed) for (const sc of p.scripts) if (!scriptTags.some((t) => t.src === sc.src)) scriptTags.push(sc);
const index = parsed[0].html.replace(/<body([^>]*)>[\s\S]*<\/body>/iu, (m, attrs) =>
  `<body${attrs}>\n${sections.join("\n")}\n${scriptTags.map((t) => t.tag).join("\n")}\n<script type="module" src="/spa.js"></script>\n</body>`);
for (const p of parsed) await rm(path.join(out, p.rel));
await writeFile(path.join(out, "index.html"), index);
await cp(path.join(here, "src/spa.js"), path.join(out, "spa.js"));
for (const dir of new Set(parsed.map((p) => path.posix.dirname(p.rel)).filter((d) => d !== "."))) {
  try { if ((await readdir(path.join(out, dir))).length === 0) await rm(path.join(out, dir), { recursive: true }); } catch {}
}
await writeFile(path.join(out, "descriptor.json"), JSON.stringify(descriptor, null, 2) + "\n");
await writeFile(path.join(out, "descriptor.js"), `export default ${JSON.stringify(descriptor)};\n`);

const htmlFiles = [];
const walk = async (dir, collect) => {
  for (const entry of await readdir(path.join(out, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) await walk(rel, collect); else collect(rel);
  }
};
await walk("", (rel) => { if (rel.endsWith(".html")) htmlFiles.push(rel); });
let indexMetaCsp = null;
for (const rel of htmlFiles) {
  let html = await readFile(path.join(out, rel), "utf8");
  if (/<meta[^>]+http-equiv=["']Content-Security-Policy/iu.test(html)) fail(`${rel} already carries a CSP; refusing to merge policies`);
  if (!/<head[^>]*>/iu.test(html)) fail(`${rel} has no <head>`);
  if (/<script\b(?![^>]*\bsrc=)[^>]*>/iu.test(html)) fail(`${rel} has an inline script, which the CSP would block`);
  const hashes = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)].map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  const inlineAttrs = /\sstyle=/iu.test(html);
  const csp = ["default-src 'none'", "script-src 'self'", `style-src 'self' ${hashes.join(" ")}`.trim(),
    ...(inlineAttrs ? ["style-src-attr 'unsafe-inline'"] : []), "img-src 'self' data:", "font-src 'self'",
    expectedConnectSrc,
    "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"].join("; ");
  if (rel === "index.html") indexMetaCsp = csp;
  if (botPage && rel === "index.html") {
    if (!/<nav>/iu.test(html)) fail("index.html has no <nav> for the bot page link");
    html = html.replace(/<nav>/iu, '<nav>\n      <a href="/bot.html">bot</a>');
  }
  html = html.replace(/<head([^>]*)>/iu,`<head$1><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="/runtime-consent.css"><script type="module" src="/host.js"></script>`);
  await writeFile(path.join(out, rel), html);
}

// TAURI-CSP-02: write or clean the native CSP override config outside dist/,
// then verify 100% native-vs-HTML CSP parity unconditionally (never skipped).
if (botsOriginOverride) {
  const overrideCsp = buildNativeCspFromMeta(indexMetaCsp);
  await mkdir(path.dirname(overrideConfPath), { recursive: true });
  await writeFile(overrideConfPath, JSON.stringify({ app: { security: { csp: overrideCsp } } }, null, 2) + "\n");
} else {
  await rm(overrideConfPath, { force: true });
}
const effectiveNativeConfPath = botsOriginOverride ? overrideConfPath : confPath;
const effectiveNativeConf = JSON.parse(await readFile(effectiveNativeConfPath, "utf8"));
const parityProblems = nativeCspParityProblems({
  nativeCsp: effectiveNativeConf?.app?.security?.csp,
  metaCsp: indexMetaCsp,
  expectedConnectSrc,
  strictStyleMatch: Boolean(botsOriginOverride),
});
if (parityProblems.length) {
  fail(`native Tauri CSP (${effectiveNativeConfPath}) parity failure: ${parityProblems.join("; ")}`);
}

const files = {};
await walk("", (rel) => { files[rel] = null; });
for (const rel of Object.keys(files)) if (rel !== "release.json") files[rel] = sha(await readFile(path.join(out, rel)));
delete files["release.json"];
await writeFile(path.join(out, "release.json"), JSON.stringify({ schema: "awai.app.artifact.v1", id: "cloud.itonami.manabi-cert-prep", tauri: "3.0.0-alpha.6", runtimePins: pins, files }, null, 2) + "\n");
console.log(`Manabi Cert Prep Tauri frontend: ${Object.keys(files).length} files, ${htmlFiles.length} pages; ${connect}`);
