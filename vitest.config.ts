// The web edition's tests. tauri/ has its own runner (node --test, `cd tauri && npm test`),
// so its test files are not collected here (they used to show up as failed suites).
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "tauri/**"] },
});
