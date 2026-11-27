import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as d from "../src/bot-domain.mjs";
import { descriptor, requestedCapabilities } from "../src/descriptor.mjs";
import { clientEndpointAllowsRequest, clientRuntimeConnectSrc } from "../vendor/kotoba-client-runtime.js";

const here = fileURLToPath(new URL("../", import.meta.url));
const json = (rel) => JSON.parse(readFileSync(path.join(here, rel), "utf8"));
const clone = (x) => structuredClone(x);
const profile = json("../profiles/business-bot-profile.json");
// Real public responses captured on 2026-11-18 from https://bots.itonami.cloud.
const businesses = json("test/fixtures/businesses-20261118.json");
const feed7310 = json("test/fixtures/activity-7310-20261118.json");
const reason = (fn) => { try { fn(); } catch (e) { return e.reason; } return null; };

// A launched 8569 row built from a real row, for the cases the live list cannot show yet.
const launchedList = (botPatch = {}) => {
  const row = clone(businesses.data[0]);
  row.business.id = d.blueprintId;
  Object.assign(row.bot, botPatch);
  return { object: "list", data: [row] };
};

test("bundled profile is the unchanged 8569 entry with provenance", () => {
  assert.deepEqual(d.profileProblems(profile), []);
  assert.equal(profile.profile.business_blueprint.isic_rev5, "8569");
  assert.equal(profile.profile.business_blueprint.governor, "learner-safety-governor");
  for (const [mutate, problem] of [
    [(p) => { p.profile.mission.domain_family = "labor"; }, "domain-family"],
    [(p) => { p.profile.business_blueprint.id = "cloud-itonami-isic-6399"; }, "blueprint"],
    [(p) => { p.provenance.revision = "main"; }, "provenance"],
    [(p) => { p.profile.money.allowed_services.push("openai"); }, "allowed-services"],
    [(p) => { p.profile.health_rule.fail_closed = false; }, "health-rule"],
  ]) {
    const p = clone(profile); mutate(p);
    assert.ok(d.profileProblems(p).includes(problem), problem);
  }
});

test("live list (2026-11-18): the 8569 bot is not launched, and that is never healthy", () => {
  const a = d.assignment(businesses);
  assert.deepEqual(a, { state: "not-launched", others: businesses.data.length });
  assert.deepEqual(d.health(a, null, Date.now()), { verdict: "not-launched", reasons: ["bot-not-launched"] });
});

test("unverifiable list shapes are refused, not shown", () => {
  assert.equal(reason(() => d.assignment({ object: "page", data: [] })), "assignment-list-shape");
  const dup = launchedList(); dup.data.push(clone(dup.data[0]));
  assert.equal(reason(() => d.assignment(dup)), "assignment-duplicate");
  assert.equal(reason(() => d.assignment(launchedList({ bot_id: "../x" }))), "assignment-bot-shape");
  const transferable = launchedList(); transferable.data[0].position.transferable = true;
  assert.equal(reason(() => d.assignment(transferable)), "assignment-position-shape");
});

test("health is fail-closed: running alone is not healthy", () => {
  const now = Date.parse("2026-11-18T00:00:00Z");
  const fresh = now - 60_000;
  const running = d.assignment(launchedList({ status: "running", last_checkpoint_at: fresh, interval_ms: 3_600_000 }));
  const okEvent = [{ at: fresh, error: null }];
  assert.equal(d.health(running, okEvent, now).verdict, "healthy");
  assert.deepEqual(d.health(running, null, now), { verdict: "unknown", reasons: ["activity-not-read"] });
  assert.deepEqual(d.health(running, [], now).reasons, ["no-activity"]);
  assert.deepEqual(d.health(running, [{ at: fresh, error: "murakumo fleet unreachable" }], now).reasons, ["latest-event-error"]);
  const stale = d.assignment(launchedList({ status: "running", last_checkpoint_at: now - 3 * 3_600_000, interval_ms: 3_600_000 }));
  assert.equal(d.health(stale, okEvent, now).verdict, "unhealthy");
  const noCp = d.assignment(launchedList({ status: "running", last_checkpoint_at: null }));
  assert.ok(d.health(noCp, okEvent, now).reasons.includes("no-checkpoint"));
  // The real 7310 row: held, with an erroring newest event.
  const held = d.assignment(launchedList());
  const events = d.activity(feed7310, feed7310.bot_id);
  const h = d.health(held, events, now);
  assert.equal(h.verdict, "unhealthy");
  assert.ok(h.reasons.includes("status-held"));
});

test("activity feed: real feed parses newest-first and bounded; mismatches are refused", () => {
  const events = d.activity(feed7310, feed7310.bot_id);
  assert.equal(events.length, d.maxEvents);
  assert.ok(events.every((e, i) => i === 0 || events[i - 1].at >= e.at));
  assert.ok(events.every((e) => /^[0-9a-f]{64}$/u.test(e.digest)));
  assert.equal(reason(() => d.activity(feed7310, "business-other")), "activity-feed-shape");
  const tampered = clone(feed7310); tampered.data[0].integrity.digest = "x";
  assert.equal(reason(() => d.activity(tampered, feed7310.bot_id)), "activity-event-shape");
  assert.equal(reason(() => d.activityUrl("../../v1/grok-bots")), "unsafe-bot-id");
});

test("only the two declared GET routes are allowed; CSP equals the runtime derivation", () => {
  const allowed = (url, method) => descriptor.operations.some((o) => clientEndpointAllowsRequest(o.endpoint, url, method));
  assert.ok(allowed(d.assignmentsUrl(), "GET"));
  assert.ok(allowed(d.activityUrl("business-8569-x"), "GET"));
  assert.equal(allowed(d.assignmentsUrl(), "POST"), false);
  assert.equal(allowed(`${d.botsOrigin}/v1/grok-bots`, "POST"), false);
  assert.equal(allowed(`${d.botsOrigin}/v1/other`, "GET"), false);
  assert.equal(allowed(`${d.assignmentsUrl()}?x=1`, "GET"), false);
  assert.equal(allowed("https://evil.example/v1/grok-bots/businesses", "GET"), false);
  assert.ok(descriptor.operations.every((o) => o.consent === "each-operation"));

  const outDir = mkdtempSync(path.join(tmpdir(), "tauri-bot-"));
  const out = path.join(outDir, "dist");
  const botDefaultOverride = path.join(here, `.build/test-bot-default-${process.pid}.override.conf.json`);
  const stubDir = mkdtempSync(path.join(tmpdir(), "tauri-bot-stub-"));
  const stubOut = path.join(stubDir, "dist");
  const stubOverride = path.join(here, `.build/test-bot-stub-${process.pid}.override.conf.json`);
  try {
    execFileSync(process.execPath, [path.join(here, "scripts/build.mjs")], {
      env: { ...process.env, TAURI_DIST: out, TAURI_OVERRIDE_CONF: botDefaultOverride },
      stdio: "pipe",
    });
    const derived = clientRuntimeConnectSrc(descriptor, requestedCapabilities(descriptor), [], ["https://tauri.localhost"]);
    assert.equal(derived, `connect-src ${d.botsOrigin}`);
    // One document (KOTOBA-159): the bot page is a section of index.html.
    const html = readFileSync(path.join(out, "index.html"), "utf8");
    assert.match(html, /connect-src 'self' https:\/\/bots\.itonami\.cloud ipc: http:\/\/ipc\.localhost;/u);
    assert.match(html, /<section data-page="\/bot\.html"[^>]* hidden>/u);
    assert.equal(existsSync(path.join(out, "bot.html")), false);
    assert.match(readFileSync(path.join(out, "index.html"), "utf8"), /<a href="\/bot\.html">bot<\/a>/u);
    assert.deepEqual(json(path.relative(here, path.join(out, "bot-profile.json"))), profile);
    const release = JSON.parse(readFileSync(path.join(out, "release.json"), "utf8"));
    for (const f of ["bot.js", "bot-domain.js", "bot-profile.json", "spa.js"]) assert.ok(release.files[f], f);

    // Build-time override: MANABI_BOTS_ORIGIN points the bundle at a local stub;
    // the committed default stays production (checked above + by import below).
    assert.equal(d.botsOrigin, "https://bots.itonami.cloud");
    execFileSync(process.execPath, [path.join(here, "scripts/build.mjs")],
      { env: { ...process.env, TAURI_DIST: stubOut, TAURI_OVERRIDE_CONF: stubOverride, MANABI_BOTS_ORIGIN: "https://127.0.0.1:18089" }, stdio: "pipe" });
    const stubDomain = readFileSync(path.join(stubOut, "bot-domain.js"), "utf8");
    assert.match(stubDomain, /export const botsOrigin = "https:\/\/127\.0\.0\.1:18089";/u);
    const stubHtml = readFileSync(path.join(stubOut, "index.html"), "utf8");
    assert.match(stubHtml, /connect-src 'self' https:\/\/127\.0\.0\.1:18089 ipc: http:\/\/ipc\.localhost;/u);
    assert.match(stubHtml, /接続先: https:\/\/127\.0\.0\.1:18089/u);
    assert.doesNotMatch(stubHtml, /bots\.itonami\.cloud/u);
    const stubDesc = JSON.parse(readFileSync(path.join(stubOut, "descriptor.json"), "utf8"));
    assert.ok(stubDesc.operations.every((o) => o.endpoint.origin === "https://127.0.0.1:18089"));
    const stubNativeConf = JSON.parse(readFileSync(stubOverride, "utf8"));
    assert.match(stubNativeConf.app.security.csp, /connect-src 'self' https:\/\/127\.0\.0\.1:18089 ipc: http:\/\/ipc\.localhost;/u);
  } finally {
    rmSync(botDefaultOverride, { force: true });
    rmSync(stubOverride, { force: true });
  }
});

test("ZB12-011: health checkpoint-stale exact 2x intervalMs boundary and negative/future timestamps", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const interval = 3_600_000;
  const okEvent = [{ at: now - 1000, error: null }];
  const makeRunning = (cp) => d.assignment(launchedList({ status: "running", last_checkpoint_at: cp, interval_ms: interval }));

  // Exact 2x intervalMs boundaries
  assert.equal(d.health(makeRunning(now), okEvent, now).verdict, "healthy", "elapsed === 0");
  assert.equal(d.health(makeRunning(now - (2 * interval - 1)), okEvent, now).verdict, "healthy", "elapsed === 2*interval - 1");
  assert.equal(d.health(makeRunning(now - 2 * interval), okEvent, now).verdict, "healthy", "elapsed === 2*interval");
  const over = d.health(makeRunning(now - (2 * interval + 1)), okEvent, now);
  assert.equal(over.verdict, "unhealthy", "elapsed === 2*interval + 1");
  assert.deepEqual(over.reasons, ["checkpoint-stale"]);

  // assignment() refuses negative and non-integer timestamps
  for (const badCp of [-1, -3_600_000, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.equal(reason(() => d.assignment(launchedList({ last_checkpoint_at: badCp }))), "assignment-bot-shape", String(badCp));
  }

  // health() fails closed on negative, future (negative elapsed), or non-finite timestamps
  const base = makeRunning(now - 60_000);
  for (const [label, a, t] of [
    ["negative checkpoint", { ...base, lastCheckpointAt: -1 }, now],
    ["negative nowMs", base, -1],
    ["both negative small diff", { ...base, lastCheckpointAt: -100 }, -50],
    ["future checkpoint (+1ms)", { ...base, lastCheckpointAt: now + 1 }, now],
    ["far-future checkpoint", { ...base, lastCheckpointAt: Number.MAX_SAFE_INTEGER }, now],
    ["NaN nowMs", base, Number.NaN],
    ["Infinity nowMs", base, Number.POSITIVE_INFINITY],
    ["zero intervalMs", { ...base, intervalMs: 0 }, now],
    ["negative intervalMs", { ...base, intervalMs: -1000 }, now],
  ]) {
    const h = d.health(a, okEvent, t);
    assert.equal(h.verdict, "unhealthy", label);
    assert.ok(h.reasons.includes("checkpoint-stale"), `${label}: ${JSON.stringify(h.reasons)}`);
  }
});

test("ZB12-012: bot-domain rejects >128-char, dot-segment, unicode, and confusable-origin bot IDs", () => {
  const allowed = (url, method = "GET") => descriptor.operations.some((o) => clientEndpointAllowsRequest(o.endpoint, url, method));
  const maxValid = "a".repeat(128);
  assert.equal(d.safeId(maxValid), true);
  assert.equal(d.activityUrl(maxValid), `${d.botsOrigin}${d.activityPrefix}${maxValid}/activity`);
  assert.equal(allowed(d.activityUrl(maxValid)), true);

  const rejectedIds = [
    ["empty", ""],
    ["129 chars", "a".repeat(129)],
    ["200 chars", "b".repeat(200)],
    ["single dot", "."],
    ["double dot", ".."],
    ["dot prefix", ".hidden"],
    ["embedded double dot", "bot..1"],
    ["trailing double dot", "bot.."],
    ["path traversal", "../businesses"],
    ["nested traversal", "bot-1/../../businesses"],
    ["dot segment slash", "./bot-1"],
    ["percent encoded dot", "%2e%2e"],
    ["percent encoded slash", "bot%2f1"],
    ["backslash", "bot\\1"],
    ["unicode Japanese", "ボット-1"],
    ["unicode Cyrillic homoglyph", "b\u043et-1"],
    ["unicode fullwidth", "\uff42\uff4f\uff54"],
    ["zero-width space", "bot\u200b1"],
    ["RTL override", "bot\u202e1"],
    ["combining mark", "bot\u0301"],
    ["emoji", "bot🔥"],
    ["nul byte", "bot\0id"],
    ["whitespace", "bot 1"],
    ["query injection", "bot-1?x=1"],
    ["fragment injection", "bot-1#frag"],
    ["proto pollution __proto__", "__proto__"],
    ["proto pollution constructor", "constructor"],
    ["proto pollution prototype", "prototype"],
  ];
  for (const [label, id] of rejectedIds) {
    assert.equal(d.safeId(id), false, `safeId(${label})`);
    assert.equal(reason(() => d.activityUrl(id)), "unsafe-bot-id", `activityUrl(${label})`);
    assert.equal(reason(() => d.activity(feed7310, id)), "unsafe-bot-id", `activity(${label})`);
    assert.equal(reason(() => d.assignment(launchedList({ bot_id: id }))), "assignment-bot-shape", `assignment(${label})`);
  }

  // Route-level checks: >128-char, extra path segments, and confusable origins are rejected by the descriptor endpoint
  for (const [label, url] of [
    ["129-char bot_id", `${d.botsOrigin}${d.activityPrefix}${"a".repeat(129)}/activity`],
    ["200-char bot_id", `${d.botsOrigin}${d.activityPrefix}${"a".repeat(200)}/activity`],
    ["wrong suffix under prefix", `${d.botsOrigin}${d.activityPrefix}business-8569-x/other`],
    ["extra nested segment", `${d.botsOrigin}${d.activityPrefix}a/b/activity`],
    ["dot-leading bot_id", `${d.botsOrigin}${d.activityPrefix}.hidden/activity`],
    ["unicode bot_id", `${d.botsOrigin}${d.activityPrefix}ボット/activity`],
    ["Cyrillic confusable origin", "https://b\u043ets.itonami.cloud/v1/grok-bots/businesses"],
    ["suffix spoof origin", "https://bots.itonami.cloud.evil.example/v1/grok-bots/businesses"],
    ["prefix spoof origin", "https://evil-bots.itonami.cloud/v1/grok-bots/businesses"],
    ["userinfo spoof origin", "https://bots.itonami.cloud@evil.example/v1/grok-bots/businesses"],
    ["credentials on real origin", "https://user:pass@bots.itonami.cloud/v1/grok-bots/businesses"],
    ["scheme downgrade", "http://bots.itonami.cloud/v1/grok-bots/businesses"],
    ["port confusion", "https://bots.itonami.cloud:8443/v1/grok-bots/businesses"],
  ]) {
    assert.equal(allowed(url, "GET"), false, `endpoint must reject ${label}`);
  }
});

test("ZB12-013: maxResponseBytes streaming byte-cap and maxEvents/500-row bounds", async () => {
  // Exact maxResponseBytes boundary (262144 accepted, 262145 rejected)
  const makeJsonOfBytes = (targetBytes) => {
    const prefix = '{"v":"';
    const suffix = '"}';
    return prefix + "a".repeat(targetBytes - prefix.length - suffix.length) + suffix;
  };
  const exactPayload = makeJsonOfBytes(d.maxResponseBytes);
  assert.equal(Buffer.byteLength(exactPayload, "utf8"), d.maxResponseBytes);
  const exactRes = new Response(exactPayload, { status: 200, headers: { "content-length": String(d.maxResponseBytes) } });
  assert.equal((await d.readBoundedJson(exactRes)).v.length, d.maxResponseBytes - 8);

  const overPayload = makeJsonOfBytes(d.maxResponseBytes + 1);
  assert.equal(Buffer.byteLength(overPayload, "utf8"), d.maxResponseBytes + 1);
  await assert.rejects(() => d.readBoundedJson(new Response(overPayload, { status: 200 })), /response too large/u);

  // Multi-byte UTF-8: text.length < maxResponseBytes (100,000 chars), but UTF-8 byteLength = 300,008 > 262,144
  const multiBytePayload = JSON.stringify({ v: "あ".repeat(100_000) });
  assert.ok(multiBytePayload.length < d.maxResponseBytes);
  assert.ok(Buffer.byteLength(multiBytePayload, "utf8") > d.maxResponseBytes);
  await assert.rejects(() => d.readBoundedJson(new Response(multiBytePayload, { status: 200 })), /response too large/u);
  // Also test fallback path (no response.body stream) with multi-byte UTF-8
  await assert.rejects(() => d.readBoundedJson({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: null,
    text: async () => multiBytePayload,
  }), /response too large/u);

  // Declared Content-Length > maxResponseBytes or negative rejects before reading body
  let cancelledDeclared = false;
  await assert.rejects(() => d.readBoundedJson({
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(d.maxResponseBytes + 1) }),
    body: { cancel: async () => { cancelledDeclared = true; }, getReader: () => { throw new Error("must not read"); } },
  }), /response too large/u);
  assert.equal(cancelledDeclared, true);

  await assert.rejects(() => d.readBoundedJson({
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": "-1" }),
    body: { cancel: async () => {}, getReader: () => { throw new Error("must not read"); } },
  }), /response too large/u);

  // Chunked stream with spoofed small Content-Length cancels immediately once byte cap is crossed
  let pulls = 0;
  let cancelledStream = false;
  const chunk = new Uint8Array(100_000).fill(97);
  const hugeStream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelledStream = true;
    },
  });
  await assert.rejects(() => d.readBoundedJson({
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": "10" }),
    body: hugeStream,
  }), /response too large/u);
  assert.equal(cancelledStream, true);
  assert.ok(pulls <= 4, `expected early abort, got ${pulls} pulls`);

  // Non-OK status fails closed
  await assert.rejects(() => d.readBoundedJson(new Response("{}", { status: 500 })), /HTTP 500/u);

  // maxEvents (20) newest-first selection & 500-item feed cap
  const baseEvent = clone(feed7310.data[0]);
  const makeFeed = (count) => ({
    ...clone(feed7310),
    data: Array.from({ length: count }, (_, i) => ({
      ...clone(baseEvent),
      activity_id: `act-${i}`,
      occurred_at: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
    })),
  });
  assert.equal(d.activity(makeFeed(19), feed7310.bot_id).length, 19);
  assert.equal(d.activity(makeFeed(20), feed7310.bot_id).length, 20);
  const from500 = d.activity(makeFeed(500), feed7310.bot_id);
  assert.equal(from500.length, d.maxEvents);
  assert.equal(from500[0].id, "act-499");
  assert.equal(from500[19].id, "act-480");
  assert.equal(reason(() => d.activity(makeFeed(501), feed7310.bot_id)), "activity-feed-shape");

  // Tampered event past index maxEvents must still fail closed
  const badLate = makeFeed(30);
  badLate.data[25].integrity.digest = "not-a-sha256";
  assert.equal(reason(() => d.activity(badLate, feed7310.bot_id)), "activity-event-shape");

  // Assignment list 500-row cap
  const row = clone(businesses.data[0]);
  assert.equal(d.assignment({ object: "list", data: Array.from({ length: 500 }, () => clone(row)) }).state, "not-launched");
  assert.equal(reason(() => d.assignment({ object: "list", data: Array.from({ length: 501 }, () => clone(row)) })), "assignment-list-shape");
});
