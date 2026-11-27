import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clientRuntimeConnectSrc, clientRuntimeProblems } from "../vendor/kotoba-client-runtime.js";
import { descriptor, requestedCapabilities } from "../src/descriptor.mjs";
import {
  OVERRIDE_CONF_REL,
  assertOwnedOverrideConfFile,
  nativeCspParityProblems,
  resolveOverrideConfPath,
  validateBotsOriginOverride,
} from "../scripts/bots-origin.mjs";
import { planTauriBuild } from "../scripts/tauri-build.mjs";

const here = fileURLToPath(new URL("../", import.meta.url));
let testConfSeq = 0;
const nextBuildOverrideRel = (label) => `.build/test-host-${label}-${process.pid}-${++testConfSeq}.override.conf.json`;
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tauri-fixture-"));
  mkdirSync(path.join(dir, "in/sub"), { recursive: true });
  writeFileSync(path.join(dir, "in/index.html"), '<!doctype html><html><head><style>a{}</style></head><body><nav></nav><a href="https://example.com/x" style="color:red">x</a><script src="/app.js"></script></body></html>');
  writeFileSync(path.join(dir, "in/sub/page.html"), "<html><head></head><body></body></html>");
  writeFileSync(path.join(dir, "in/app.js"), "");
  return {
    dir,
    src: path.join(dir, "in"),
    out: path.join(dir, "out"),
  };
};
const build = (src, out, extraEnv = {}) => {
  const hasExplicitOverride = Object.hasOwn(extraEnv, "TAURI_OVERRIDE_CONF");
  const autoOverrideRel = nextBuildOverrideRel("fx");
  const autoOverridePath = path.join(here, autoOverrideRel);
  try {
    return execFileSync(
      process.execPath,
      [path.join(here, "scripts/build.mjs")],
      {
        env: {
          ...process.env,
          STATIC_SRC: src,
          TAURI_DIST: out,
          ...(hasExplicitOverride ? {} : { TAURI_OVERRIDE_CONF: autoOverrideRel }),
          ...extraEnv,
        },
        stdio: "pipe",
      },
    );
  } finally {
    if (!hasExplicitOverride) rmSync(autoOverridePath, { force: true });
  }
};

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
  let consentOpens = 0;
  let onConsentOpen = null;
  globalThis.location = new URL("https://tauri.localhost/index.html");
  globalThis.fetch = async (input) => { calls.push(String(input)); return { ok: true }; };
  const listeners = [];
  const makeNode = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      style: {},
      open: false,
      isConnected: true,
      disabled: false,
      textContent: "",
      append() {},
      setAttribute() {},
      addEventListener() {},
      remove() { node.isConnected = false; },
      focus() {},
      showModal() {
        node.open = true;
        consentOpens += 1;
        if (onConsentOpen) onConsentOpen();
      },
      close() { node.open = false; },
    };
    return node;
  };
  globalThis.document = {
    defaultView: { performance: { now: () => 0 }, MouseEvent: class {} },
    addEventListener: (type, fn) => listeners.push([type, fn]),
    createElement: makeNode,
    body: { append() {} },
    head: { append() {} },
  };
  await import(pathToFileURL(path.join(out, "host.js")).href);
  assert.deepEqual(await fetch("/local.json"), { ok: true });
  await assert.rejects(() => fetch("https://evil.example/x"), TypeError);
  await assert.rejects(() => fetch("https://evil.example/x", { method: "POST", body: "secret" }), TypeError);
  assert.deepEqual(calls, ["/local.json"]);
  assert.equal(consentOpens, 0);
  const click = listeners.find(([type]) => type === "click")[1];
  let prevented = false;
  click({ target: { closest: () => ({ getAttribute: () => "https://example.com/out" }) }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  prevented = false;
  click({ target: { closest: () => ({ getAttribute: () => "/local.html" }) }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);

  // ZB12-012: host enforces safeId directly on :bot_id (rejecting chars, reserved names, and
  // consecutive dots that kotoba-client-runtime's generic parameter matcher accepts) plus
  // >128-char, dot-segment, unicode/homoglyph, confusable-origin, credentialed, and malformed URLs
  // before entering consent or broker processing (0 consent opens, 0 fetch calls).
  for (const [label, badUrl] of [
    ["disallowed tilde in bot id", "https://bots.itonami.cloud/v1/grok-bots/bots/bot~1/activity"],
    ["disallowed colon in bot id", "https://bots.itonami.cloud/v1/grok-bots/bots/bot:1/activity"],
    ["disallowed at-sign in bot id", "https://bots.itonami.cloud/v1/grok-bots/bots/bot@1/activity"],
    ["reserved __proto__ bot id", "https://bots.itonami.cloud/v1/grok-bots/bots/__proto__/activity"],
    ["reserved constructor bot id", "https://bots.itonami.cloud/v1/grok-bots/bots/constructor/activity"],
    ["reserved prototype bot id", "https://bots.itonami.cloud/v1/grok-bots/bots/prototype/activity"],
    ["embedded double-dot bot id", "https://bots.itonami.cloud/v1/grok-bots/bots/bot..1/activity"],
    ["trailing double-dot bot id", "https://bots.itonami.cloud/v1/grok-bots/bots/bot../activity"],
    ["leading dot bot id", "https://bots.itonami.cloud/v1/grok-bots/bots/.hidden/activity"],
    ["129-char bot id", `https://bots.itonami.cloud/v1/grok-bots/bots/${"a".repeat(129)}/activity`],
    ["dot-segment traversal to declared route", "https://bots.itonami.cloud/v1/grok-bots/bots/../businesses"],
    ["single-dot segment", "https://bots.itonami.cloud/v1/grok-bots/bots/./business-8569-x/activity"],
    ["encoded dot traversal", "https://bots.itonami.cloud/v1/grok-bots/bots/%2e%2e/businesses"],
    ["backslash traversal", "https://bots.itonami.cloud/v1/grok-bots/bots/a\\..\\businesses"],
    ["unicode Japanese bot id", "https://bots.itonami.cloud/v1/grok-bots/bots/ボット/activity"],
    ["unicode Cyrillic bot id", "https://bots.itonami.cloud/v1/grok-bots/bots/b\u043et-1/activity"],
    ["unicode fullwidth bot id", "https://bots.itonami.cloud/v1/grok-bots/bots/\uff42\uff4f\uff54/activity"],
    ["zero-width space bot id", "https://bots.itonami.cloud/v1/grok-bots/bots/bot\u200b1/activity"],
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
  assert.equal(consentOpens, 0, "rejected bot IDs must never reach consent/broker");

  // Non-vacuous positive control: a valid safeId DOES reach the consent broker (and aborts cleanly without network I/O).
  const ac = new AbortController();
  onConsentOpen = () => queueMicrotask(() => ac.abort());
  await assert.rejects(
    () => fetch("https://bots.itonami.cloud/v1/grok-bots/bots/business-8569-x/activity", { signal: ac.signal }),
    /cancelled|not approved/u,
  );
  onConsentOpen = null;
  assert.equal(consentOpens, 1, "valid bot ID must reach consent broker");
  assert.deepEqual(calls, ["/local.json"]);

  // Malformed href click fails closed (preventDefault called instead of throwing)
  prevented = false;
  click({ target: { closest: () => ({ getAttribute: () => "http://[::1" }) }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});

test("ZB12-001: tauri.conf.json declares a non-null CSP aligned with descriptor.mjs and fails closed on drift", () => {
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

  // Negative controls: build fails closed if native tauri.conf.json is missing, has csp: null,
  // drifted connect-src, missing frame-ancestors, or mismatched core directive.
  for (const [label, badConfContent] of [
    ["missing config file", null],
    ["null csp", JSON.stringify({ app: { security: { csp: null } } })],
    ["drifted connect-src", JSON.stringify({ app: { security: { csp: csp.replace("https://bots.itonami.cloud", "https://evil.example") } } })],
    ["missing frame-ancestors", JSON.stringify({ app: { security: { csp: csp.replace("; frame-ancestors 'none'", "") } } })],
    ["unsafe script-src", JSON.stringify({ app: { security: { csp: csp.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") } } })],
  ]) {
    const f = fixture();
    const badConf = path.join(f.dir, "tauri.conf.json");
    if (badConfContent !== null) writeFileSync(badConf, badConfContent);
    assert.throws(
      () => build(f.src, f.out, { TAURI_CONF: badConf }),
      /tauri build/u,
      label,
    );
  }
});

test("TAURI-CSP-02: MANABI_BOTS_ORIGIN validation, release block, override CSP parity, and stale cleanup", () => {
  // 1. Strict MANABI_BOTS_ORIGIN validation
  assert.equal(validateBotsOriginOverride(""), null);
  assert.equal(validateBotsOriginOverride("https://127.0.0.1:18089"), "https://127.0.0.1:18089");
  assert.equal(validateBotsOriginOverride("https://10.0.2.2:18089", { allowEmulatorHost: true }), "https://10.0.2.2:18089");
  for (const [label, badOrigin] of [
    ["http loopback", "http://127.0.0.1:18089"],
    ["userinfo", "https://user:pass@127.0.0.1:18089"],
    ["path suffix", "https://127.0.0.1:18089/v1"],
    ["trailing slash", "https://127.0.0.1:18089/"],
    ["query string", "https://127.0.0.1:18089?x=1"],
    ["fragment", "https://127.0.0.1:18089#frag"],
    ["IPv6 loopback", "https://[::1]:18089"],
    ["missing port", "https://127.0.0.1"],
    ["default https port 443", "https://127.0.0.1:443"],
    ["out-of-range port", "https://127.0.0.1:70000"],
    ["localhost hostname", "https://localhost:18089"],
    ["public host", "https://evil.example:8443"],
    ["prod host as override", "https://bots.itonami.cloud"],
    ["emulator host without flag", "https://10.0.2.2:18089"],
  ]) {
    assert.throws(() => validateBotsOriginOverride(badOrigin), /MANABI_BOTS_ORIGIN/u, label);
    const f = fixture();
    assert.throws(() => build(f.src, f.out, { MANABI_BOTS_ORIGIN: badOrigin }), /tauri build/u, `build rejects ${label}`);
  }

  // 2. Wrapper blocks MANABI_BOTS_ORIGIN on --release, signing, non-debug builds, and explicit --config
  for (const [label, args] of [
    ["explicit --release", ["android", "build", "--debug", "--release", "--apk"]],
    ["release desktop without --debug", ["build", "--no-bundle"]],
    ["release android without --debug", ["android", "build", "--apk"]],
    ["--aab bundle", ["android", "build", "--debug", "--aab"]],
    ["--sign flag", ["android", "build", "--debug", "--sign"]],
    ["explicit --config conflict", ["android", "build", "--debug", "--config", "other.json"]],
  ]) {
    assert.throws(
      () => planTauriBuild(args, { MANABI_BOTS_ORIGIN: "https://127.0.0.1:18089" }),
      /forbidden|cannot combine/u,
      label,
    );
  }
  const relDir = mkdtempSync(path.join(tmpdir(), "tauri-wrap-rel-"));
  const relOverrideRel = nextBuildOverrideRel("rel");
  assert.throws(
    () => execFileSync(process.execPath, [path.join(here, "scripts/tauri-build.mjs"), "android", "build", "--release", "--apk"], {
      env: {
        ...process.env,
        MANABI_BOTS_ORIGIN: "https://127.0.0.1:18089",
        TAURI_DIST: path.join(relDir, "dist"),
        TAURI_OVERRIDE_CONF: relOverrideRel,
        TAURI_BUILD_DRY_RUN: "1",
      },
      stdio: "pipe",
    }),
    /forbidden/u,
    "CLI wrapper rejects MANABI_BOTS_ORIGIN + --release",
  );

  // 3. Valid MANABI_BOTS_ORIGIN debug override:
  //    - default planTauriBuild (no TAURI_OVERRIDE_CONF) passes --config .build/tauri.override.conf.json
  //    - custom TAURI_OVERRIDE_CONF inside .build/*.override.conf.json passes that exact verified path to --config
  //    - 100% HTML <meta> CSP <-> override config parity, dist/ stays clean, tauri.conf.json untouched.
  const defaultOverridePlan = planTauriBuild(["build", "--debug", "--no-bundle"], {
    MANABI_BOTS_ORIGIN: "https://127.0.0.1:18089",
  });
  assert.equal(defaultOverridePlan.overrideConfigArg, OVERRIDE_CONF_REL);
  assert.equal(defaultOverridePlan.overrideConfigPath, path.resolve(here, OVERRIDE_CONF_REL));
  assert.deepEqual(defaultOverridePlan.tauriArgs, ["build", "--debug", "--no-bundle", "--config", OVERRIDE_CONF_REL]);

  // Unsafe / non-owned TAURI_OVERRIDE_CONF targets (including package.json, PINS.json, tsconfig.json,
  // paths outside .build/, wrong suffix, traversal, and symlinks) are rejected fail-closed by
  // resolveOverrideConfPath, planTauriBuild, and build.mjs — and existing files stay byte-identical
  // across BOTH debug override builds AND normal non-override builds.
  const unsafeDir = mkdtempSync(path.join(tmpdir(), "tauri-unsafe-conf-"));
  const unsafeDist = path.join(unsafeDir, "dist");
  const pkgJsonPath = path.join(here, "package.json");
  const pkgJsonBefore = readFileSync(pkgJsonPath, "utf8");
  for (const [label, badTarget] of [
    ["project package.json (relative)", "package.json"],
    ["project package.json (absolute)", pkgJsonPath],
    ["root package.json", "../package.json"],
    ["root tsconfig.json", "../tsconfig.json"],
    ["vendor PINS.json", "vendor/PINS.json"],
    ["tauri.conf.json itself", path.join(here, "src-tauri/tauri.conf.json")],
    ["file inside src-tauri/", path.join(here, "src-tauri/override.json")],
    ["file inside dist/", path.join(unsafeDist, "tauri.override.conf.json")],
    ["path traversal out of .build/", ".build/../package.json"],
    ["non-override json inside .build/", ".build/arbitrary.json"],
    ["nested subdir inside .build/", ".build/sub/a.override.conf.json"],
    ["double-dot in filename", ".build/a..b.override.conf.json"],
    ["outside .build/ with matching suffix", path.join(unsafeDir, "outside.override.conf.json")],
    ["non-json file", path.join(unsafeDir, "override.txt")],
  ]) {
    assert.throws(
      () => resolveOverrideConfPath({
        tauriDir: here,
        distDir: unsafeDist,
        baseConfPath: path.join(here, "src-tauri/tauri.conf.json"),
        rawOverrideConf: badTarget,
      }),
      /TAURI_OVERRIDE_CONF/u,
      `resolveOverrideConfPath rejects ${label}`,
    );
    assert.throws(
      () => planTauriBuild(["build", "--debug", "--no-bundle"], {
        MANABI_BOTS_ORIGIN: "https://127.0.0.1:18089",
        TAURI_DIST: unsafeDist,
        TAURI_OVERRIDE_CONF: badTarget,
      }),
      /TAURI_OVERRIDE_CONF/u,
      `planTauriBuild rejects ${label}`,
    );
    const f = fixture();
    assert.throws(
      () => build(f.src, unsafeDist, {
        MANABI_BOTS_ORIGIN: "https://127.0.0.1:18089",
        TAURI_OVERRIDE_CONF: badTarget,
      }),
      /tauri build/u,
      `build.mjs (override) rejects ${label}`,
    );
    assert.throws(
      () => build(f.src, unsafeDist, {
        MANABI_BOTS_ORIGIN: "",
        TAURI_OVERRIDE_CONF: badTarget,
      }),
      /tauri build/u,
      `build.mjs (default) rejects ${label}`,
    );
  }
  assert.equal(readFileSync(pkgJsonPath, "utf8"), pkgJsonBefore, "tauri/package.json must remain byte-identical");

  // Ownership check: an existing non-override JSON or symlink inside .build/ matching *.override.conf.json
  // must fail closed without being overwritten (debug override) or deleted (default non-override).
  mkdirSync(path.join(here, ".build"), { recursive: true });
  const unownedRel = nextBuildOverrideRel("unowned");
  const unownedPath = path.join(here, unownedRel);
  const extraKeyRel = nextBuildOverrideRel("extrakey");
  const extraKeyPath = path.join(here, extraKeyRel);
  const symlinkRel = nextBuildOverrideRel("symlink");
  const symlinkPath = path.join(here, symlinkRel);
  try {
    const unownedBody = JSON.stringify({ owner: "external", keep: true }, null, 2) + "\n";
    writeFileSync(unownedPath, unownedBody);
    const extraKeyBody = JSON.stringify({ app: { security: { csp: "default-src 'none'" }, extra: true } }) + "\n";
    writeFileSync(extraKeyPath, extraKeyBody);
    symlinkSync(pkgJsonPath, symlinkPath);

    for (const [label, targetRel, targetAbs, expectedBody] of [
      ["arbitrary JSON inside .build/", unownedRel, unownedPath, unownedBody],
      ["extra-key JSON inside .build/", extraKeyRel, extraKeyPath, extraKeyBody],
    ]) {
      assert.throws(() => assertOwnedOverrideConfFile(targetAbs), /unowned/u, label);
      const f = fixture();
      assert.throws(
        () => build(f.src, unsafeDist, { MANABI_BOTS_ORIGIN: "https://127.0.0.1:18089", TAURI_OVERRIDE_CONF: targetRel }),
        /unowned/u,
        `debug override refuses to overwrite ${label}`,
      );
      assert.equal(readFileSync(targetAbs, "utf8"), expectedBody, `${label} unchanged after refused override`);
      assert.throws(
        () => build(f.src, unsafeDist, { MANABI_BOTS_ORIGIN: "", TAURI_OVERRIDE_CONF: targetRel }),
        /unowned/u,
        `default build refuses to delete ${label}`,
      );
      assert.equal(existsSync(targetAbs), true, `${label} not deleted after refused default build`);
      assert.equal(readFileSync(targetAbs, "utf8"), expectedBody, `${label} unchanged after refused default build`);
    }

    // Symlink inside .build/ pointing to package.json must be rejected without touching package.json
    const fSym = fixture();
    assert.throws(
      () => build(fSym.src, unsafeDist, { MANABI_BOTS_ORIGIN: "https://127.0.0.1:18089", TAURI_OVERRIDE_CONF: symlinkRel }),
      /symlink/u,
      "debug override rejects symlink in .build/",
    );
    assert.throws(
      () => build(fSym.src, unsafeDist, { MANABI_BOTS_ORIGIN: "", TAURI_OVERRIDE_CONF: symlinkRel }),
      /symlink/u,
      "default build rejects symlink in .build/",
    );
    assert.equal(readFileSync(pkgJsonPath, "utf8"), pkgJsonBefore, "symlink target package.json must remain byte-identical");
  } finally {
    rmSync(unownedPath, { force: true });
    rmSync(extraKeyPath, { force: true });
    rmSync(symlinkPath, { force: true });
  }

  const prodConfBefore = readFileSync(path.join(here, "src-tauri/tauri.conf.json"), "utf8");
  const workDir = mkdtempSync(path.join(tmpdir(), "tauri-wrap-ok-"));
  const distDir = path.join(workDir, "dist");
  const overrideRel = nextBuildOverrideRel("wrap");
  const overridePath = path.join(here, overrideRel);
  const desktopDir = mkdtempSync(path.join(tmpdir(), "tauri-desktop-debug-"));
  const desktopDist = path.join(desktopDir, "dist");
  const desktopCustomRel = nextBuildOverrideRel("desktop-stub");
  const desktopCustomPath = path.join(here, desktopCustomRel);
  try {
    const dryOverrideOut = execFileSync(
      process.execPath,
      [path.join(here, "scripts/tauri-build.mjs"), "android", "build", "--debug", "--apk", "--target", "x86_64"],
      {
        env: {
          ...process.env,
          MANABI_BOTS_ORIGIN: "https://127.0.0.1:18089",
          TAURI_DIST: distDir,
          TAURI_OVERRIDE_CONF: overrideRel,
          TAURI_BUILD_DRY_RUN: "1",
        },
        encoding: "utf8",
      },
    );
    const dryOverridePlan = JSON.parse(dryOverrideOut.trim().split("\n").at(-1));
    assert.equal(dryOverridePlan.overrideOrigin, "https://127.0.0.1:18089");
    assert.equal(dryOverridePlan.overrideConfig, overrideRel);
    assert.equal(dryOverridePlan.overrideConfigPath, overridePath);
    assert.deepEqual(dryOverridePlan.tauriArgs, [
      "android", "build", "--debug", "--apk", "--target", "x86_64",
      "--config", overrideRel,
    ]);
    assert.equal(existsSync(overridePath), true, "override config written inside .build/");
    assert.equal(existsSync(path.join(distDir, "tauri.override.conf.json")), false, "override config not placed inside dist/");
    assert.equal(readFileSync(path.join(here, "src-tauri/tauri.conf.json"), "utf8"), prodConfBefore, "tauri.conf.json remains immutable");

    const html = readFileSync(path.join(distDir, "index.html"), "utf8");
    const metaCsp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
    const overrideConf = JSON.parse(readFileSync(overridePath, "utf8"));
    assert.deepEqual(
      nativeCspParityProblems({
        nativeCsp: overrideConf?.app?.security?.csp,
        metaCsp,
        expectedConnectSrc: "connect-src 'self' https://127.0.0.1:18089 ipc: http://ipc.localhost",
        strictStyleMatch: true,
      }),
      [],
      "HTML <meta> CSP and override native CSP must match 100%",
    );

    // 4. Regression: `npm run build:desktop:debug` dry-run with custom .build/<name>.override.conf.json
    //    generates ONLY the custom file, passes that exact path to --config (not the default),
    //    and the file referenced by --config exists on disk with matching CSP.
    const defaultConfPath = path.resolve(here, OVERRIDE_CONF_REL);
    const defaultExistedBefore = existsSync(defaultConfPath);
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    const desktopDryOut = execFileSync(npmBin, ["run", "--silent", "build:desktop:debug"], {
      cwd: here,
      env: {
        ...process.env,
        MANABI_BOTS_ORIGIN: "https://127.0.0.1:18089",
        TAURI_DIST: desktopDist,
        TAURI_OVERRIDE_CONF: desktopCustomRel,
        TAURI_BUILD_DRY_RUN: "1",
      },
      encoding: "utf8",
    });
    const desktopPlan = JSON.parse(desktopDryOut.trim().split("\n").at(-1));
    const configFlagIdx = desktopPlan.tauriArgs.indexOf("--config");
    assert.ok(configFlagIdx >= 0, "tauriArgs must include --config");
    const passedConfigArg = desktopPlan.tauriArgs[configFlagIdx + 1];
    assert.equal(passedConfigArg, desktopCustomRel, "--config must point to the exact custom TAURI_OVERRIDE_CONF");
    assert.notEqual(passedConfigArg, OVERRIDE_CONF_REL, "--config must not fall back to the default override path");
    const resolvedPassedConfig = path.resolve(here, passedConfigArg);
    assert.equal(resolvedPassedConfig, desktopCustomPath);
    assert.equal(existsSync(resolvedPassedConfig), true, "file referenced by --config must exist on disk");
    assert.equal(existsSync(defaultConfPath), defaultExistedBefore, "default override path must not be created when custom path is used");
    const desktopHtml = readFileSync(path.join(desktopDist, "index.html"), "utf8");
    const desktopMetaCsp = desktopHtml.match(/Content-Security-Policy" content="([^"]+)"/)[1];
    const desktopConfJson = JSON.parse(readFileSync(resolvedPassedConfig, "utf8"));
    assert.deepEqual(
      nativeCspParityProblems({
        nativeCsp: desktopConfJson?.app?.security?.csp,
        metaCsp: desktopMetaCsp,
        expectedConnectSrc: "connect-src 'self' https://127.0.0.1:18089 ipc: http://ipc.localhost",
        strictStyleMatch: true,
      }),
      [],
      "desktop:debug --config file must match dist/index.html meta CSP 100%",
    );

    // 5. Stale owned override cleanup on non-override build and --config omitted.
    assert.equal(existsSync(overridePath), true);
    const dryDefaultOut = execFileSync(
      process.execPath,
      [path.join(here, "scripts/tauri-build.mjs"), "android", "build", "--debug", "--apk", "--target", "x86_64"],
      {
        env: {
          ...process.env,
          MANABI_BOTS_ORIGIN: "",
          TAURI_DIST: distDir,
          TAURI_OVERRIDE_CONF: overrideRel,
          TAURI_BUILD_DRY_RUN: "1",
        },
        encoding: "utf8",
      },
    );
    const dryDefaultPlan = JSON.parse(dryDefaultOut.trim().split("\n").at(-1));
    assert.equal(dryDefaultPlan.overrideOrigin, null);
    assert.equal(dryDefaultPlan.overrideConfig, null);
    assert.deepEqual(dryDefaultPlan.tauriArgs, ["android", "build", "--debug", "--apk", "--target", "x86_64"]);
    assert.equal(existsSync(overridePath), false, "stale owned override config must be removed on default build");
  } finally {
    rmSync(overridePath, { force: true });
    rmSync(desktopCustomPath, { force: true });
  }
});
