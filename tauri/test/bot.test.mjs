import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
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

  const out = path.join(mkdtempSync(path.join(tmpdir(), "tauri-bot-")), "dist");
  execFileSync(process.execPath, [path.join(here, "scripts/build.mjs")], { env: { ...process.env, TAURI_DIST: out }, stdio: "pipe" });
  const derived = clientRuntimeConnectSrc(descriptor, requestedCapabilities(descriptor), [], ["https://tauri.localhost"]);
  assert.equal(derived, `connect-src ${d.botsOrigin}`);
  for (const page of ["index.html", "bot.html"]) {
    const html = readFileSync(path.join(out, page), "utf8");
    assert.match(html, /connect-src 'self' https:\/\/bots\.itonami\.cloud ipc: http:\/\/ipc\.localhost;/u, page);
  }
  assert.match(readFileSync(path.join(out, "index.html"), "utf8"), /<a href="\/bot\.html">bot<\/a>/u);
  assert.deepEqual(json(path.relative(here, path.join(out, "bot-profile.json"))), profile);
  const release = JSON.parse(readFileSync(path.join(out, "release.json"), "utf8"));
  for (const f of ["bot.html", "bot.js", "bot-domain.js", "bot-profile.json"]) assert.ok(release.files[f], f);
});
