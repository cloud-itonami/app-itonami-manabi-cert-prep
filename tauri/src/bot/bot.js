// Bot status page. Reads the bundled profile from the app origin and, only on a
// button press, the two public bot routes. host.js routes every cross-origin
// fetch through the shared consent broker: each read opens its own approval
// dialog and a denial sends nothing. Text is set with textContent only.
import * as d from "./bot-domain.js";

const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
const state = { assignment: null, events: null, busy: false };
const reasonText = {
  "bot-not-launched": "bot が未起動", "no-checkpoint": "checkpoint がない", "checkpoint-stale": "checkpoint が古い（間隔の 2 倍超）",
  "activity-not-read": "活動を未取得", "no-activity": "活動がない", "latest-event-error": "最新の活動がエラー",
};
const verdictText = { healthy: "健康", unhealthy: "不健康", unknown: "不明（活動を未取得）" };
const timeText = (ms) => (ms == null ? "なし" : new Intl.DateTimeFormat("ja", { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms)));

const boundedJson = async (response) => {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > d.maxResponseBytes) throw new Error("response too large");
  const text = await response.text();
  if (text.length > d.maxResponseBytes) throw new Error("response too large");
  return JSON.parse(text);
};

const notice = (s) => { $("notice").textContent = s; };

const renderHealth = () => {
  const box = $("health"); const a = state.assignment;
  box.replaceChildren();
  $("read-activity").hidden = a?.state !== "launched";
  if (!a) { box.append(el("p", "まだ取得していません。")); return; }
  if (a.state === "not-launched") {
    box.append(el("p", "この bot はまだ起動していません。"));
    box.append(el("p", `公開 assignment 一覧（${a.others} 件）にこの blueprint はありません。起動は運用者の確認が必要です。`, "calm-card-meta"));
    return;
  }
  const h = d.health(a, state.events, Date.now());
  const verdict = el("p", verdictText[h.verdict] ?? h.verdict); verdict.dataset.verdict = h.verdict; box.append(verdict);
  if (h.reasons.length) { const ul = el("ul"); for (const r of h.reasons) ul.append(el("li", reasonText[r] ?? r)); box.append(ul); }
  const dl = el("dl");
  for (const [k, v] of [["状態", a.status], ["実行回数", String(a.tickCount)], ["最新 checkpoint", timeText(a.lastCheckpointAt)],
    ["貸付枠 / 負債", `${a.creditLimitMicros} / ${a.debtMicros} micro-USDC`]]) dl.append(el("dt", k), el("dd", v));
  box.append(dl);
};

const renderEvents = () => {
  const card = $("events-card"); const list = $("events");
  card.hidden = state.events == null;
  list.replaceChildren();
  if (state.events == null) return;
  if (state.events.length === 0) { list.append(el("li", "活動はありません。")); return; }
  for (const e of state.events) {
    const li = el("li"); li.append(el("p", `${e.occurredAt} · ${e.type}`));
    if (e.error) li.append(el("p", e.error, "calm-notice"));
    li.append(el("p", `sha256 ${e.digest.slice(0, 16)}…`, "calm-card-meta"));
    list.append(li);
  }
};

const read = async (url, onBody) => {
  if (state.busy) return;
  state.busy = true; $("read-assignments").disabled = true; $("read-activity").disabled = true;
  try {
    onBody(await boundedJson(await fetch(url, { method: "GET" })));
    notice(`取得しました（${timeText(Date.now())}）。`);
  } catch (e) {
    notice(/not approved|denied/iu.test(String(e?.message)) ? "取得を中止しました。何も送信していません。" : `取得できません: ${e?.reason ?? e?.message}`);
  } finally {
    state.busy = false; $("read-assignments").disabled = false; $("read-activity").disabled = false;
    renderHealth(); renderEvents();
  }
};

const renderProfile = (doc) => {
  const p = doc.profile; const bp = p.business_blueprint; const m = p.money; const box = $("profile");
  box.append(el("p", bp.name, "calm-card-title"), el("p", `使命: ${doc.mission.statement}`));
  const dl = el("dl");
  for (const [k, v] of [["担当する領域", `${bp.domain} (ISIC ${bp.isic_rev5})`], ["統制", bp.governor],
    ["使えるお金", `${m.credit_bounds_micro_usdc.min}〜${m.credit_bounds_micro_usdc.max} micro-USDC の貸付枠のみ（譲渡不可・オンチェーン token なし）。使える先: ${m.allowed_services.join(", ")}`]]) dl.append(el("dt", k), el("dd", v));
  box.append(dl, el("p", bp.offer, "calm-card-meta"),
    el("p", `出典: ${doc.provenance.repository} ${doc.provenance.revision.slice(0, 12)}`, "calm-card-meta"));
};

const start = async () => {
  let doc;
  try { doc = await (await fetch("/bot-profile.json")).json(); } catch { doc = null; }
  if (!doc || d.profileProblems(doc).length) {
    $("profile").replaceChildren(el("p", "同梱の bot profile を確認できないため、表示を停止しました。"));
    $("read-assignments").hidden = true;
    return;
  }
  renderProfile(doc);
  $("read-assignments").addEventListener("click", () => read(d.assignmentsUrl(), (body) => { state.assignment = d.assignment(body); state.events = null; }));
  $("read-activity").addEventListener("click", () => {
    const botId = state.assignment?.botId;
    if (botId) read(d.activityUrl(botId), (body) => { state.events = d.activity(body, botId); });
  });
};

start();
