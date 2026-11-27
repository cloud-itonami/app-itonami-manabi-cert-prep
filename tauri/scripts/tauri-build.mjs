// Thin wrapper for native Tauri builds (TAURI-CSP-02).
// Ensures:
//   1. MANABI_BOTS_ORIGIN overrides are strictly validated and NEVER allowed on
//      release or signing builds (desktop/android builds without --debug fail).
//   2. `scripts/build.mjs` runs first to generate dist/ and, when overridden,
//      `.build/tauri.override.conf.json` (or removes any stale override when unset).
//   3. For overridden debug builds, `--config .build/tauri.override.conf.json` is
//      passed to the Tauri CLI so the native asset-protocol CSP matches HTML 100%.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOverrideConfPath, validateBotsOriginOverride } from "./bots-origin.mjs";

const here = fileURLToPath(new URL("../", import.meta.url));

const FORBIDDEN_OVERRIDE_FLAG_RE = /^(--release|--aab|--sign|--keystore(?:=|$)|--keystore-password(?:=|$)|--key-alias(?:=|$)|--key-password(?:=|$)|--bundles(?:=|$))$/u;

export function isReleaseOrSigningArgs(args) {
  if (args.some((arg) => FORBIDDEN_OVERRIDE_FLAG_RE.test(arg))) return true;
  const hasBuildSubcommand = args.includes("build");
  const hasDebugFlag = args.includes("--debug") || args.includes("-d");
  if (hasBuildSubcommand && !hasDebugFlag) return true;
  return false;
}

export function planTauriBuild(args, env = process.env) {
  const allowEmulatorHost = env.MANABI_BOTS_ALLOW_EMULATOR_HOST === "1";
  const overrideOrigin = validateBotsOriginOverride(env.MANABI_BOTS_ORIGIN, { allowEmulatorHost });
  const distDir = path.resolve(env.TAURI_DIST ?? path.join(here, "dist"));
  const baseConfPath = path.resolve(env.TAURI_CONF ?? path.join(here, "src-tauri/tauri.conf.json"));
  const resolvedOverride = resolveOverrideConfPath({
    tauriDir: here,
    distDir,
    baseConfPath,
    rawOverrideConf: env.TAURI_OVERRIDE_CONF,
  });
  const overrideConfigArg = resolvedOverride.cliArg;
  const overrideConfigPath = resolvedOverride.absPath;
  if (overrideOrigin) {
    if (isReleaseOrSigningArgs(args)) {
      throw new Error("MANABI_BOTS_ORIGIN override is forbidden for release/signing builds (pass --debug for local stub builds)");
    }
    if (args.some((arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config="))) {
      throw new Error("cannot combine MANABI_BOTS_ORIGIN with an explicit --config flag");
    }
  }
  const tauriArgs = overrideOrigin ? [...args, "--config", overrideConfigArg] : [...args];
  return { overrideOrigin, overrideConfigArg, overrideConfigPath, tauriArgs };
}

function resolveTauriBinary() {
  const localBin = path.join(here, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
  return existsSync(localBin) ? localBin : "tauri";
}

function main() {
  const args = process.argv.slice(2);
  let plan;
  try {
    plan = planTauriBuild(args, process.env);
  } catch (err) {
    console.error(`tauri build wrapper: ${err.message}`);
    process.exit(1);
  }

  // Run the static frontend build (writes or cleans the resolved override config and verifies parity).
  execFileSync(process.execPath, [path.join(here, "scripts/build.mjs")], {
    cwd: here,
    env: process.env,
    stdio: "inherit",
  });

  if (plan.overrideOrigin && !existsSync(plan.overrideConfigPath)) {
    console.error(`tauri build wrapper: expected override config was not generated: ${plan.overrideConfigPath}`);
    process.exit(1);
  }
  if (!plan.overrideOrigin && existsSync(plan.overrideConfigPath)) {
    console.error(`tauri build wrapper: stale override config still present on non-override build: ${plan.overrideConfigPath}`);
    process.exit(1);
  }

  if (process.env.TAURI_BUILD_DRY_RUN === "1") {
    console.log(JSON.stringify({
      overrideOrigin: plan.overrideOrigin,
      overrideConfig: plan.overrideOrigin ? plan.overrideConfigArg : null,
      overrideConfigPath: plan.overrideOrigin ? plan.overrideConfigPath : null,
      tauriArgs: plan.tauriArgs,
    }));
    return;
  }

  execFileSync(resolveTauriBinary(), plan.tauriArgs, {
    cwd: here,
    env: process.env,
    stdio: "inherit",
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
