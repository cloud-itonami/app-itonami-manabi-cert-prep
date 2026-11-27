// Shared validation and native-vs-HTML CSP parity helpers for Tauri builds (TAURI-CSP-02).
export const OVERRIDE_CONF_REL = ".build/tauri.override.conf.json";

const LOOPBACK_ORIGIN_RE = /^https:\/\/(127\.0\.0\.1|10\.0\.2\.2):([1-9]\d{0,4})$/u;

/**
 * Validate MANABI_BOTS_ORIGIN build-time override (dev/local stub only).
 * Returns null when unset/empty; throws Error on any disallowed origin.
 */
export function validateBotsOriginOverride(raw, { allowEmulatorHost = false } = {}) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") return null;
  if (trimmed.includes("@") || trimmed.includes("?") || trimmed.includes("#") || trimmed.includes("\\")) {
    throw new Error(`MANABI_BOTS_ORIGIN must be a bare https loopback origin without userinfo/path/query: ${trimmed}`);
  }
  const m = LOOPBACK_ORIGIN_RE.exec(trimmed);
  if (!m) {
    throw new Error(`MANABI_BOTS_ORIGIN must be https://127.0.0.1:<port>${allowEmulatorHost ? " or https://10.0.2.2:<port>" : ""}: ${trimmed}`);
  }
  const [, host, portStr] = m;
  if (host === "10.0.2.2" && !allowEmulatorHost) {
    throw new Error("MANABI_BOTS_ORIGIN=https://10.0.2.2:<port> requires MANABI_BOTS_ALLOW_EMULATOR_HOST=1");
  }
  const port = Number(portStr);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || port === 443) {
    throw new Error(`MANABI_BOTS_ORIGIN has invalid or default port: ${trimmed}`);
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`MANABI_BOTS_ORIGIN is not a valid URL: ${trimmed}`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== host
    || parsed.port !== portStr
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.origin !== trimmed
  ) {
    throw new Error(`MANABI_BOTS_ORIGIN must be a canonical https loopback origin: ${trimmed}`);
  }
  return parsed.origin;
}

export function parseCspDirectives(csp) {
  if (typeof csp !== "string" || csp.trim() === "") return null;
  const map = {};
  for (const part of csp.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const i = trimmed.indexOf(" ");
    const name = (i < 0 ? trimmed : trimmed.slice(0, i)).toLowerCase();
    const value = i < 0 ? "" : trimmed.slice(i + 1).trim();
    if (Object.hasOwn(map, name)) return null;
    map[name] = value;
  }
  return map;
}

/**
 * Derive the native Tauri HTTP-header CSP from the generated HTML <meta> CSP,
 * adding frame-ancestors 'none' (which <meta> CSP ignores per CSP3).
 */
export function buildNativeCspFromMeta(metaCsp) {
  const parts = metaCsp.split(";").map((part) => part.trim()).filter(Boolean);
  const out = [];
  let inserted = false;
  for (const part of parts) {
    out.push(part);
    if (part === "frame-src 'none'") {
      out.push("frame-ancestors 'none'");
      inserted = true;
    }
  }
  if (!inserted) out.push("frame-ancestors 'none'");
  return out.join("; ");
}

const CORE_PARITY_DIRECTIVES = [
  "default-src",
  "script-src",
  "img-src",
  "font-src",
  "connect-src",
  "object-src",
  "frame-src",
  "base-uri",
  "form-action",
];

/**
 * Assert 100% parity between the effective native Tauri CSP and the HTML <meta> CSP
 * plus the descriptor-derived connect-src directive. Returns an array of error strings.
 */
export function nativeCspParityProblems({ nativeCsp, metaCsp, expectedConnectSrc, strictStyleMatch = false }) {
  const problems = [];
  const nativeMap = parseCspDirectives(nativeCsp);
  if (!nativeMap) return ["native app.security.csp must be a non-empty valid CSP string"];
  const metaMap = parseCspDirectives(metaCsp);
  if (!metaMap) return ["HTML meta CSP must be a non-empty valid CSP string"];
  const expectedConnectValue = expectedConnectSrc.replace(/^connect-src\s+/u, "");
  if (metaMap["connect-src"] !== expectedConnectValue) {
    problems.push(`HTML meta connect-src (${metaMap["connect-src"] ?? "missing"}) disagrees with descriptor (${expectedConnectValue})`);
  }
  if (nativeMap["connect-src"] !== expectedConnectValue) {
    problems.push(`native connect-src (${nativeMap["connect-src"] ?? "missing"}) disagrees with descriptor (${expectedConnectValue})`);
  }
  for (const directive of CORE_PARITY_DIRECTIVES) {
    if (nativeMap[directive] !== metaMap[directive]) {
      problems.push(`native ${directive} (${nativeMap[directive] ?? "missing"}) !== HTML meta ${directive} (${metaMap[directive] ?? "missing"})`);
    }
  }
  if (nativeMap["frame-ancestors"] !== "'none'") {
    problems.push(`native frame-ancestors (${nativeMap["frame-ancestors"] ?? "missing"}) must be 'none'`);
  }
  if (strictStyleMatch) {
    if (nativeMap["style-src"] !== metaMap["style-src"]) {
      problems.push(`native style-src (${nativeMap["style-src"] ?? "missing"}) !== HTML meta style-src (${metaMap["style-src"] ?? "missing"})`);
    }
    if ((nativeMap["style-src-attr"] ?? "") !== (metaMap["style-src-attr"] ?? "")) {
      problems.push(`native style-src-attr (${nativeMap["style-src-attr"] ?? "missing"}) !== HTML meta style-src-attr (${metaMap["style-src-attr"] ?? "missing"})`);
    }
  } else if (!nativeMap["style-src"] || !nativeMap["style-src"].startsWith("'self'") || nativeMap["style-src"].includes("'unsafe-inline'")) {
    problems.push(`native style-src (${nativeMap["style-src"] ?? "missing"}) must start with 'self' without 'unsafe-inline'`);
  }
  return problems;
}
