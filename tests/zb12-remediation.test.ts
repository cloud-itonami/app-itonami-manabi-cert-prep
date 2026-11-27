// Zone B-12 remediation tests (ZB12-014, ZB12-002, ZB12-003, ZB12-015):
//   - ZB12-014: public/calm.js zero-innerHTML XSS safety + R2 personalMaterialImport boundary
//   - ZB12-003: sessions.v1 schema/version alignment between calm.js and tauri/src/descriptor.mjs
//   - ZB12-002: R1_ACTIVE_NSIDS provenance alignment and fail-closed /xrpc/ NSID enforcement
//   - ZB12-015: fail-closed R1 phase gate and MURAKUMO_LITELLM_GATEWAY_URL validation

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { stripCComments } from "./_helpers";
import { PWA_ROOT, readLexicon } from "./_lexicons";
import handler, { R1_UNLOCKED_PHASE_GATE, validateGatewayUrl } from "../src/app";

const CALM_JS_PATH = join(PWA_ROOT, "public", "calm.js");
const DESCRIPTOR_PATH = join(PWA_ROOT, "tauri", "src", "descriptor.mjs");
const WRANGLER_PATH = join(PWA_ROOT, "wrangler.jsonc");

interface MockElement {
  tagName: string;
  className: string;
  id: string;
  type: string;
  attributes: Record<string, string>;
  children: MockNode[];
  _textContent: string;
  textContent: string;
  innerHTML: string;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: MockNode): MockNode;
  replaceChildren(...nodes: MockNode[]): void;
  addEventListener(): void;
  remove(): void;
  focus(): void;
  showModal(): void;
  close(): void;
}

type MockNode = MockElement | { nodeType: 3; textContent: string };

function makeMockElement(tagName: string): MockElement {
  const el: MockElement = {
    tagName: tagName.toUpperCase(),
    className: "",
    id: "",
    type: "",
    attributes: {},
    children: [],
    _textContent: "",
    get textContent() {
      if (this.children.length === 0) return this._textContent;
      return this.children.map((c) => c.textContent).join("");
    },
    set textContent(v: string) {
      this._textContent = String(v);
      this.children = [];
    },
    get innerHTML(): string {
      return "";
    },
    set innerHTML(_v: string) {
      throw new Error("innerHTML assignment is forbidden in calm.js");
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = String(value);
    },
    getAttribute(name: string) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    },
    appendChild(child: MockNode) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...nodes: MockNode[]) {
      this.children = [...nodes];
      this._textContent = "";
    },
    addEventListener() {},
    remove() {},
    focus() {},
    showModal() {},
    close() {},
  };
  return el;
}

function loadCalmSandbox(initialStorage: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initialStorage));
  const localStorage = {
    getItem(k: string) {
      return store.has(k) ? store.get(k)! : null;
    },
    setItem(k: string, v: string) {
      store.set(k, String(v));
    },
    removeItem(k: string) {
      store.delete(k);
    },
  };
  const body = makeMockElement("body");
  const document = {
    body,
    activeElement: null,
    createElement: (tag: string) => makeMockElement(tag),
    createTextNode: (text: string) => ({ nodeType: 3 as const, textContent: String(text) }),
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const windowObj: Record<string, unknown> = { document, localStorage };
  const context = vm.createContext({
    window: windowObj,
    document,
    localStorage,
    Date,
    JSON,
    Set,
    Array,
    Object,
    Number,
    String,
  });
  const src = readFileSync(CALM_JS_PATH, "utf-8");
  vm.runInContext(src, context, { filename: "public/calm.js" });
  return {
    calm: windowObj.calm as {
      recordConceptTouched(certPathway: unknown, domain: unknown, conceptId: unknown): boolean;
      renderHistory(rootEl: MockElement): void;
      clearHistory(): void;
    },
    store,
    document,
    makeMockElement,
  };
}

async function callWorker(path: string, env: Record<string, unknown> = {}) {
  const req = new Request(`https://manabi-cert-prep.itonami.app${path}`);
  const res = (await handler.fetch!(req as never, env as never, {} as never)) as unknown as Response;
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

describe("ZB12-014 — calm.js safe DOM rendering (no innerHTML) & R2 personalMaterialImport boundary", () => {
  it("public/calm.js contains no unsafe HTML sinks (comment-stripped)", () => {
    const code = stripCComments(readFileSync(CALM_JS_PATH, "utf-8"));
    expect(code).not.toMatch(/\.innerHTML\b/);
    expect(code).not.toMatch(/\.outerHTML\b/);
    expect(code).not.toMatch(/\binsertAdjacentHTML\b/);
    expect(code).not.toMatch(/\bdocument\.write\b/);
  });

  it("renderHistory renders XSS payloads strictly as textContent with zero innerHTML writes", () => {
    const xssDomain = '<img src=x onerror="alert(1)">';
    const xssConcept = '<script>alert("xss")</script>" onmouseover="alert(2)';
    const { calm, makeMockElement } = loadCalmSandbox({
      "manabi-cert-prep:sessions:v1": JSON.stringify({
        schema: "manabi-cert-prep.sessions.v1",
        version: 1,
        entries: [
          {
            kind: "concept_touched",
            certPathway: "cisa",
            domain: xssDomain,
            conceptId: xssConcept,
            tsUtc: "2026-11-28T00:00:00.000Z",
          },
        ],
      }),
    });
    const root = makeMockElement("div");
    calm.renderHistory(root);

    expect(root.children).toHaveLength(1);
    const ul = root.children[0] as MockElement;
    expect(ul.tagName).toBe("UL");
    expect(ul.children).toHaveLength(1);
    const li = ul.children[0] as MockElement;
    expect(li.tagName).toBe("LI");
    expect(li.children).toHaveLength(2);
    const domainDiv = li.children[0] as MockElement;
    const metaDiv = li.children[1] as MockElement;
    expect(domainDiv.tagName).toBe("DIV");
    expect(domainDiv.children).toHaveLength(0);
    expect(domainDiv.textContent).toBe(`CISA · ${xssDomain}`);
    expect(metaDiv.tagName).toBe("DIV");
    expect(metaDiv.children).toHaveLength(0);
    expect(metaDiv.textContent).toContain(`concept: ${xssConcept}`);
  });

  it("calm.js rejects tampered entries and R2 personalMaterialImport payloads in localStorage", () => {
    const { calm, makeMockElement } = loadCalmSandbox({
      "manabi-cert-prep:sessions:v1": JSON.stringify([
        null,
        "raw-string",
        // R2 personalMaterialImport smuggling attempt
        {
          kind: "personalMaterialImport",
          certPathway: "cisa",
          domain: "cisa-d1",
          conceptId: "imported-notes",
          tsUtc: "2026-11-28T00:00:00.000Z",
        },
        // Extra R2/material fields on otherwise valid shape
        {
          kind: "concept_touched",
          certPathway: "cisa",
          domain: "cisa-d1",
          conceptId: "notes",
          tsUtc: "2026-11-28T00:00:00.000Z",
          questionSource: "user-imported-personal-only",
          internalOnly: true,
        },
        // Unknown pathway (must not be silently coerced to CISSP)
        {
          kind: "concept_touched",
          certPathway: "<script>alert(1)</script>",
          domain: "d1",
          conceptId: "c1",
          tsUtc: "2026-11-28T00:00:00.000Z",
        },
        // Oversized domain (>128 chars)
        {
          kind: "concept_touched",
          certPathway: "cissp",
          domain: "d".repeat(129),
          conceptId: "c1",
          tsUtc: "2026-11-28T00:00:00.000Z",
        },
        // Invalid timestamp
        {
          kind: "concept_touched",
          certPathway: "cissp",
          domain: "cissp-d1",
          conceptId: "c1",
          tsUtc: "not-a-date",
        },
      ]),
    });
    const root = makeMockElement("div");
    calm.renderHistory(root);
    // Every tampered/R2 entry must be rejected -> empty state rendered safely
    expect(root.children).toHaveLength(1);
    const emptyP = root.children[0] as MockElement;
    expect(emptyP.tagName).toBe("P");
    expect(emptyP.textContent).toContain("まだ学習履歴はありません");
  });

  it("recordConceptTouched refuses invalid pathways, empty fields, and oversized payloads", () => {
    const { calm, store } = loadCalmSandbox();
    expect(calm.recordConceptTouched("unknown", "d1", "c1")).toBe(false);
    expect(calm.recordConceptTouched("cisa", "", "c1")).toBe(false);
    expect(calm.recordConceptTouched("cisa", "d1", "x".repeat(129))).toBe(false);
    expect(calm.recordConceptTouched("cissp", 123, "c1")).toBe(false);
    expect(store.size).toBe(0);

    expect(calm.recordConceptTouched("cissp", "cissp-d3", "fips-140-3")).toBe(true);
    const stored = JSON.parse(store.get("manabi-cert-prep:sessions:v1")!);
    expect(stored.schema).toBe("manabi-cert-prep.sessions.v1");
    expect(stored.version).toBe(1);
    expect(stored.entries).toHaveLength(1);
    expect(stored.entries[0].certPathway).toBe("cissp");
  });

  it("Worker refuses R2 personalMaterialImport unconditionally (even if R1 gate is ratified)", async () => {
    const whileLocked = await callWorker("/xrpc/com.etzhayyim.manabi.personalMaterialImport", {
      MANABI_CERT_PREP_R1_PHASE_GATE: "locked",
      MURAKUMO_LITELLM_GATEWAY_URL: "http://127.0.0.1:4000",
    });
    expect(whileLocked.status).toBe(503);
    expect(whileLocked.json?.error).toBe("ManabiCertPrepR2PhaseGateLocked");

    const whileR1Ratified = await callWorker("/xrpc/com.etzhayyim.manabi.personalMaterialImport", {
      MANABI_CERT_PREP_R1_PHASE_GATE: R1_UNLOCKED_PHASE_GATE,
      MURAKUMO_LITELLM_GATEWAY_URL: "http://127.0.0.1:4000",
    });
    expect(whileR1Ratified.status).toBe(503);
    expect(whileR1Ratified.json?.error).toBe("ManabiCertPrepR2PhaseGateLocked");
  });
});

describe("ZB12-003 — sessions.v1 schema alignment and versioned envelope validation", () => {
  it("calm.js local-state schema and version match tauri/src/descriptor.mjs", () => {
    const calmSrc = readFileSync(CALM_JS_PATH, "utf-8");
    const descSrc = readFileSync(DESCRIPTOR_PATH, "utf-8");
    const calmSchema = calmSrc.match(/LOCAL_STATE_SCHEMA\s*=\s*"([^"]+)"/)?.[1];
    const calmVersion = Number(calmSrc.match(/LOCAL_STATE_VERSION\s*=\s*(\d+)/)?.[1]);
    const descSchema = descSrc.match(/"schema":\s*"(manabi-cert-prep\.sessions\.v1)"/)?.[1];
    const descVersion = Number(descSrc.match(/"version":\s*(\d+)/)?.[1]);
    expect(calmSchema).toBe("manabi-cert-prep.sessions.v1");
    expect(descSchema).toBe(calmSchema);
    expect(calmVersion).toBe(1);
    expect(descVersion).toBe(calmVersion);
  });

  it("calm.js rejects mismatched schema/version envelopes and migrates legacy arrays", () => {
    for (const bad of [
      JSON.stringify({ schema: "other.sessions.v1", version: 1, entries: [] }),
      JSON.stringify({ schema: "manabi-cert-prep.sessions.v1", version: 2, entries: [] }),
      JSON.stringify({ schema: "manabi-cert-prep.sessions.v1", version: "1", entries: [] }),
      "{not-json",
    ]) {
      const { calm, makeMockElement } = loadCalmSandbox({ "manabi-cert-prep:sessions:v1": bad });
      const root = makeMockElement("div");
      calm.renderHistory(root);
      expect((root.children[0] as MockElement).tagName).toBe("P");
    }

    const legacy = [
      {
        kind: "concept_touched",
        certPathway: "cisa",
        domain: "cisa-d1",
        conceptId: "audit-evidence",
        tsUtc: "2026-11-28T00:00:00.000Z",
      },
    ];
    const { calm, store } = loadCalmSandbox({ "manabi-cert-prep:sessions:v1": JSON.stringify(legacy) });
    expect(calm.recordConceptTouched("cisa", "cisa-d2", "cobit")).toBe(true);
    const migrated = JSON.parse(store.get("manabi-cert-prep:sessions:v1")!);
    expect(migrated.schema).toBe("manabi-cert-prep.sessions.v1");
    expect(migrated.version).toBe(1);
    expect(migrated.entries).toHaveLength(2);
  });
});

describe("ZB12-002 — R1_ACTIVE_NSIDS provenance alignment and XRPC NSID enforcement", () => {
  it("R1_ACTIVE_NSIDS advertised by /_app/meta match the vendored lexicon contract IDs", async () => {
    const meta = await callWorker("/_app/meta");
    expect(meta.status).toBe(200);
    const expectedIds = [
      readLexicon("certPrepSession").id,
      readLexicon("domainMasteryAttestation").id,
    ];
    expect(meta.json?.r1ActiveLexicons).toEqual(expectedIds);
  });

  it("Worker rejects undeclared XRPC NSIDs with 404 when R1 gate is ratified", async () => {
    const validEnv = {
      MANABI_CERT_PREP_R1_PHASE_GATE: R1_UNLOCKED_PHASE_GATE,
      MURAKUMO_LITELLM_GATEWAY_URL: "http://127.0.0.1:4000",
    };
    const unknown = await callWorker("/xrpc/com.etzhayyim.manabi.nonExistent", validEnv);
    expect(unknown.status).toBe(404);
    expect(unknown.json?.error).toBe("UnknownXrpcNsid");

    const declared = await callWorker("/xrpc/com.etzhayyim.manabi.certPrepSession", validEnv);
    expect(declared.status).toBe(501);
    expect(declared.json?.error).toBe("NotImplementedAtW1");
  });
});

describe("ZB12-015 — fail-closed R1 phase gate and MURAKUMO_LITELLM_GATEWAY_URL validation", () => {
  it("any phase gate value other than explicit 'ratified' fails closed with 503", async () => {
    for (const gateValue of [undefined, "", "locked", "LOCKED", "lockd", "open", "unlocked", "true", "1", " ratified "]) {
      const env: Record<string, unknown> = { MURAKUMO_LITELLM_GATEWAY_URL: "http://127.0.0.1:4000" };
      if (gateValue !== undefined) env.MANABI_CERT_PREP_R1_PHASE_GATE = gateValue;
      const res = await callWorker("/xrpc/com.etzhayyim.manabi.certPrepSession", env);
      expect(res.status, `gate=${JSON.stringify(gateValue)}`).toBe(503);
      expect(res.json?.error, `gate=${JSON.stringify(gateValue)}`).toBe("ManabiCertPrepR1PhaseGateLocked");

      const meta = await callWorker("/_app/meta", env);
      expect(meta.json?.phaseGate, `meta gate=${JSON.stringify(gateValue)}`).toBe("locked");
    }
  });

  it("validateGatewayUrl accepts only http://127.0.0.1:4000 and refuses external, credentialed, or malformed URLs", () => {
    expect(validateGatewayUrl("http://127.0.0.1:4000")).toEqual({ ok: true, url: "http://127.0.0.1:4000" });
    expect(validateGatewayUrl("http://127.0.0.1:4000/")).toEqual({ ok: true, url: "http://127.0.0.1:4000" });

    for (const bad of [
      undefined,
      "",
      "   ",
      "not-a-url",
      "https://api.openai.com/v1",
      "https://api.anthropic.com/v1",
      "https://127.0.0.1:4000",
      "http://127.0.0.1:4001",
      "http://localhost:4000",
      "http://0.0.0.0:4000",
      "http://127.0.0.1:4000/v1/chat",
      "http://127.0.0.1:4000/?foo=bar",
      "http://127.0.0.1:4000/#frag",
      "http://user:pass@127.0.0.1:4000",
    ]) {
      expect(validateGatewayUrl(bad).ok, `bad=${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("Worker refuses ratified R1 XRPC call when MURAKUMO_LITELLM_GATEWAY_URL is missing or disallowed", async () => {
    for (const badGateway of [undefined, "https://api.openai.com/v1", "http://127.0.0.1:9999"]) {
      const env: Record<string, unknown> = { MANABI_CERT_PREP_R1_PHASE_GATE: R1_UNLOCKED_PHASE_GATE };
      if (badGateway !== undefined) env.MURAKUMO_LITELLM_GATEWAY_URL = badGateway;
      const res = await callWorker("/xrpc/com.etzhayyim.manabi.certPrepSession", env);
      expect(res.status).toBe(503);
      expect(res.json?.error).toBe("InvalidMurakumoGatewayUrl");
    }
  });

  it("wrangler.jsonc locks the R1 phase gate and sets a valid W0/W1 local gateway URL", () => {
    const raw = readFileSync(WRANGLER_PATH, "utf-8");
    const gate = raw.match(/"MANABI_CERT_PREP_R1_PHASE_GATE"\s*:\s*"([^"]*)"/)?.[1];
    const gw = raw.match(/"MURAKUMO_LITELLM_GATEWAY_URL"\s*:\s*"([^"]*)"/)?.[1];
    expect(gate).toBe("locked");
    expect(validateGatewayUrl(gw).ok).toBe(true);
  });
});
