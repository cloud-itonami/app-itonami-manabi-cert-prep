// KOTOBA-159: the app runs as a sandboxed guest under restricted-wasm-v1, where
// window.confirm / alert / prompt do not ask and return a default. The app uses its
// own confirmation screen instead, so no public/ script may call a native dialog.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripCComments } from "./_helpers";

const PUBLIC_DIR = join(import.meta.dirname ?? __dirname, "..", "public");
const jsFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? jsFiles(p) : e.endsWith(".js") ? [p] : [];
  });

describe("no native dialogs (KOTOBA-159)", () => {
  it("public/ scripts call no confirm, alert or prompt", () => {
    for (const f of jsFiles(PUBLIC_DIR)) {
      const code = stripCComments(readFileSync(f, "utf8"));
      expect(code, f).not.toMatch(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/);
    }
  });

  it("the history clear asks with the app's own confirmation", () => {
    const code = readFileSync(join(PUBLIC_DIR, "calm.js"), "utf8");
    expect(code).toContain('role", "alertdialog"');
    expect(code).toContain('"aria-modal", "true"');
    expect(code).toContain("showModal()");
    expect(code).toContain("この端末に保存された学習履歴を全て削除します。よろしいですか?");
    expect(code).toContain('"削除する"');
    expect(code).toContain('"やめる"');
  });
});
