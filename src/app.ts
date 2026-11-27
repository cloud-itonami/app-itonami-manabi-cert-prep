// manabi-cert-prep.itonami.app — manabi cert_prep knowledge-domain study PWA
// Per ADR-2605264400 (sub-charter under ADR-2605261045 manabi master).
//
// R0 phase W0+W1 — static UI only, NO LLM. judah LiteLLM gateway wiring
// deferred to R1 (separate commit gated on Council Lv6+ ≥3 ratify).
//
// Constitutional invariants enforced at routing + content layer:
//   G3  — no streaks / no leaderboard / no badge / no XP / no FOMO
//         (tests/g3-no-addiction-ux-tokens.test.ts greps public/ for forbidden tokens)
//   G15 — no pass-rate KPI anywhere in UI / no `passRate` field exposed
//   G16 — no official past-question source; concept readers only at W0+W1
//   W1  — no XRPC call / no LLM API / no judah call from this worker yet
//         (tests/w1-no-llm-call-yet.test.ts enforces; flips to active wire at R1)

import type { ExportedHandler, Request as CFRequest, Response as CFResponse } from "@cloudflare/workers-types";

interface Env {
  // R1 phase gate — "locked" at R0; flips when Council Lv6+ ≥3 ratifies ADR-2605264400
  MANABI_CERT_PREP_R1_PHASE_GATE?: string;
  APP_NANOID?: string;
  APP_DISPLAY_NAME?: string;
  // Murakumo gateway (R1+; not invoked at W0/W1)
  MURAKUMO_LITELLM_GATEWAY_URL?: string;
  // CF Assets binding (static HTML/CSS/JS in ./public)
  ASSETS?: { fetch(req: CFRequest): Promise<CFResponse> };
}

const ACTOR_DID = "did:web:manabi-cert-prep.itonami.app";

// Fail-closed R1 phase gate value: only an explicit "ratified" value unlocks R1
// (Council Lv6+ >=3 ratification of ADR-2605264400). Any other value — including
// "locked", empty string, typos, or unset — remains locked.
export const R1_UNLOCKED_PHASE_GATE = "ratified";

// W0/W1 = scaffold; R1 active NSIDs land at R1 commit.
// Lexicon namespace stays com.etzhayyim.manabi.* per JUN-1410 (pinned to upstream
// etzhayyim/actor-manabi contracts in contracts/lexicons/provenance.json).
const R1_ACTIVE_NSIDS = new Set([
  "com.etzhayyim.manabi.certPrepSession",
  "com.etzhayyim.manabi.domainMasteryAttestation",
]);

const R2_GATED_NSIDS = new Set([
  "com.etzhayyim.manabi.personalMaterialImport",
]);

// ADR-2605215000: at W0/W1 (and until R1 amends the Worker-to-Murakumo transport),
// only the local Murakumo gateway on 127.0.0.1:4000 is permitted.
export function validateGatewayUrl(raw: string | undefined): { ok: true; url: string } | { ok: false; reason: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "missing-gateway-url" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid-gateway-url" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "gateway-url-has-credentials" };
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== "4000" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return { ok: false, reason: "disallowed-gateway-origin" };
  }
  return { ok: true, url: parsed.origin };
}

function effectiveR1PhaseGate(raw: string | undefined): string {
  return raw === R1_UNLOCKED_PHASE_GATE ? R1_UNLOCKED_PHASE_GATE : "locked";
}

function jsonResponse(body: unknown, status: number = 200): CFResponse {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  }) as unknown as CFResponse;
}

const handler: ExportedHandler<Env> = {
  async fetch(req: CFRequest, env: Env): Promise<CFResponse> {
    const url = new URL(req.url);

    // Public meta / health endpoints (no phase gate)
    if (url.pathname === "/health" || url.pathname === "/_app/meta") {
      return jsonResponse({
        ok: true,
        actor: ACTOR_DID,
        nanoid: env.APP_NANOID ?? "mncprp01",
        displayName: env.APP_DISPLAY_NAME ?? "manabi · cert prep",
        phaseGate: effectiveR1PhaseGate(env.MANABI_CERT_PREP_R1_PHASE_GATE),
        r1ActiveLexicons: Array.from(R1_ACTIVE_NSIDS),
        r2GatedLexicons: Array.from(R2_GATED_NSIDS),
        antiCredentialism: true,
        antiAddictionUx: true,
        w0w1ScaffoldNoLlm: true,
      });
    }

    // XRPC routes — fail closed on R2-gated NSIDs unconditionally, and on all
    // other routes unless MANABI_CERT_PREP_R1_PHASE_GATE === "ratified".
    if (url.pathname.startsWith("/xrpc/")) {
      const nsid = url.pathname.slice("/xrpc/".length);
      if (R2_GATED_NSIDS.has(nsid)) {
        return jsonResponse(
          {
            error: "ManabiCertPrepR2PhaseGateLocked",
            message:
              "personalMaterialImport is R2-gated (Tier-C internalOnly boundary per ADR-2605262400 / ADR-2605264400) and disabled at W0/W1/R1.",
            nsid,
            phaseGate: "r2-locked",
            adr: "2605264400",
          },
          503,
        );
      }

      const phase = effectiveR1PhaseGate(env.MANABI_CERT_PREP_R1_PHASE_GATE);
      if (phase !== R1_UNLOCKED_PHASE_GATE) {
        return jsonResponse(
          {
            error: "ManabiCertPrepR1PhaseGateLocked",
            message:
              "manabi cert_prep is in R0 scaffold (W0+W1). XRPC endpoints + LLM gateway activate at R1 — requires Council Lv6+ ≥3 ratify of ADR-2605264400.",
            phaseGate: phase,
            adr: "2605264400",
          },
          503,
        );
      }

      if (!R1_ACTIVE_NSIDS.has(nsid)) {
        return jsonResponse({ error: "UnknownXrpcNsid", nsid }, 404);
      }

      const gw = validateGatewayUrl(env.MURAKUMO_LITELLM_GATEWAY_URL);
      if (!gw.ok) {
        return jsonResponse(
          {
            error: "InvalidMurakumoGatewayUrl",
            reason: gw.reason,
            adr: "2605215000",
          },
          503,
        );
      }

      // R1+ branch (placeholder; real wire lands at R1 commit)
      return jsonResponse({ error: "NotImplementedAtW1", nsid }, 501);
    }

    // Static asset fallthrough — entry / domain selector / study readers / history / settings
    if (env.ASSETS) {
      return env.ASSETS.fetch(req);
    }

    return new Response("manabi · cert prep — not configured", { status: 500 }) as unknown as CFResponse;
  },
};

export default handler;
