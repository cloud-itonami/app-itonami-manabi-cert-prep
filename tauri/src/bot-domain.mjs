// Pure, fail-closed domain for the education bot paired with this app
// (bot-profile:cloud-itonami-8569, Community Learning Support). No I/O here:
// the page and the tests import it. Same rules as network-awai/app-itonami-rodo.

export const blueprintId = "cloud-itonami-8569";
export const botsOrigin = "https://bots.itonami.cloud";
export const assignmentsPath = "/v1/grok-bots/businesses";
export const activityPrefix = "/v1/grok-bots/bots/";
export const capability = "itonami-bot-read";
export const service = "itonami-grok-bots";
export const maxResponseBytes = 262144;
export const maxEvents = 20;

// Every request is its own operation and needs its own trusted user choice.
// The activity route is a bounded prefix; activityUrl builds the only shape the
// page sends, and only for a bot id read from the assignment list.
export const operations = [
  {
    capability, service, operation: "read-assignments", consent: "each-operation",
    "data-categories": ["request-ip"],
    endpoint: { origin: botsOrigin, routes: [{ method: "GET", path: assignmentsPath, "query-params": [] }] },
  },
  {
    capability, service, operation: "read-activity", consent: "each-operation",
    "data-categories": ["request-ip", "bot-id"],
    endpoint: { origin: botsOrigin, routes: [{ method: "GET", "path-prefix": activityPrefix, "query-params": [] }] },
  },
];

export class Refused extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
const refuse = (reason) => { throw new Refused(reason); };
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const match = (re, s) => typeof s === "string" && re.test(s);
const natInt = (x) => Number.isSafeInteger(x) && x >= 0;
const posInt = (x) => Number.isSafeInteger(x) && x > 0;
const shortText = (x, n) => typeof x === "string" && x.trim() !== "" && x.length <= n;

export const safeId = (x) => match(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u, x)
  && !["__proto__", "constructor", "prototype"].includes(x);

export const assignmentsUrl = () => botsOrigin + assignmentsPath;
export const activityUrl = (botId) => {
  if (!safeId(botId)) refuse("unsafe-bot-id");
  return `${botsOrigin}${activityPrefix}${botId}/activity`;
};

export const parseTime = (s) => {
  if (!match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/u, s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

// ---- bundled profile -------------------------------------------------------

export const profileProblems = (doc) => {
  const p = doc?.profile; const bp = p?.business_blueprint; const money = p?.money;
  const problems = [];
  if (doc?.schema !== "itonami.business-bot-profile.v1") problems.push("schema");
  if (!match(/^[0-9a-f]{40}$/u, doc?.provenance?.revision)) problems.push("provenance");
  if (p?.profile_id !== `bot-profile:${blueprintId}`) problems.push("profile-id");
  if (bp?.id !== blueprintId) problems.push("blueprint");
  if (!String(doc?.mission?.statement ?? "").includes("労働から解放")) problems.push("mission");
  if (p?.mission?.domain_family !== "education") problems.push("domain-family");
  if (!(Array.isArray(money?.allowed_services) && money.allowed_services.every((s) => ["murakumo", "kotobase"].includes(s)))) problems.push("allowed-services");
  if (p?.health_rule?.fail_closed !== true) problems.push("health-rule");
  return problems;
};

// ---- assignment list -------------------------------------------------------

// Absent blueprint => not launched. Any shape we cannot verify is refused,
// never shown as launched or healthy.
export const assignment = (body) => {
  const rows = body?.data;
  if (!(isObj(body) && body.object === "list" && Array.isArray(rows) && rows.length <= 500)) refuse("assignment-list-shape");
  const mine = rows.filter((r) => r?.business?.id === blueprintId);
  if (mine.length === 0) return { state: "not-launched", others: rows.length };
  if (mine.length > 1) refuse("assignment-duplicate");
  const { bot, position: pos } = mine[0];
  if (!(isObj(bot) && bot.configured === true && safeId(bot.bot_id) && shortText(bot.status, 40)
    && posInt(bot.interval_ms) && natInt(bot.tick_count)
    && (bot.last_checkpoint_at == null || natInt(bot.last_checkpoint_at)))) refuse("assignment-bot-shape");
  if (!(isObj(pos) && pos.bot_id === bot.bot_id && pos.transferable === false && pos.onchain_token === false
    && natInt(pos.credit_limit_micros) && natInt(pos.debt_micros))) refuse("assignment-position-shape");
  return {
    state: "launched", others: rows.length - 1, botId: bot.bot_id, status: bot.status, tickCount: bot.tick_count,
    intervalMs: bot.interval_ms, lastCheckpointAt: bot.last_checkpoint_at ?? null,
    creditLimitMicros: pos.credit_limit_micros, debtMicros: pos.debt_micros,
  };
};

// ---- activity feed ---------------------------------------------------------

const eventView = (botId, e) => {
  const at = parseTime(e?.occurred_at);
  const err = e?.event?.error;
  if (!(isObj(e) && e.schema === "itonami.bot-activity.v1" && e.bot_id === botId && shortText(e.activity_id, 200)
    && shortText(e.type, 80) && at !== null && e.integrity?.algorithm === "sha256"
    && match(/^[0-9a-f]{64}$/u, e.integrity?.digest) && (err == null || typeof err === "string"))) refuse("activity-event-shape");
  return {
    id: e.activity_id, type: e.type, occurredAt: e.occurred_at, at,
    error: typeof err === "string" && err.trim() !== "" ? err.slice(0, 300) : null, digest: e.integrity.digest,
  };
};

export const activity = (body, botId) => {
  if (!safeId(botId)) refuse("unsafe-bot-id");
  if (!(isObj(body) && body.schema === "itonami.bot-activity-feed.v1" && body.bot_id === botId
    && body.public_by_design === true && Array.isArray(body.data) && body.data.length <= 500)) refuse("activity-feed-shape");
  return body.data.map((e) => eventView(botId, e)).sort((a, b) => b.at - a.at).slice(0, maxEvents);
};

// ---- health ----------------------------------------------------------------

// Fail closed. `running` alone is never healthy: the checkpoint must be recent
// and the newest public event must carry no error. events === null means the
// feed has not been read, which is unknown rather than healthy.
export const health = (a, events, nowMs) => {
  if (a?.state !== "launched") return { verdict: "not-launched", reasons: ["bot-not-launched"] };
  const cp = a.lastCheckpointAt;
  const reasons = [];
  if (a.status !== "running") reasons.push(`status-${a.status}`);
  if (cp == null) reasons.push("no-checkpoint");
  else if (nowMs - cp > 2 * a.intervalMs) reasons.push("checkpoint-stale");
  if (events == null) reasons.push("activity-not-read");
  else if (events.length === 0) reasons.push("no-activity");
  else if (events[0].error) reasons.push("latest-event-error");
  const verdict = reasons.length === 0 ? "healthy"
    : reasons.length === 1 && reasons[0] === "activity-not-read" ? "unknown" : "unhealthy";
  return { verdict, reasons };
};
