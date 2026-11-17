# Manabi Cert Prep — Tauri v3 host

Runs the static `public/` bundle as a Tauri 3.0.0-alpha.6 (Wry) app. The Worker (`src/app.ts`) and the
existing static hosting are unchanged; this directory is a second host.

- `npm run build` copies `../public` to `dist/`, adds the pinned consent broker (`runtime.js`), the host
  adapter (`host.js`) and the descriptor, and writes a per-page CSP derived from the descriptor.
- The descriptor declares **no external operation**: the current W0/W1 offer needs none. The CSP is
  `connect-src 'self'`, so the WebView cannot reach another origin, and `host.js` rejects any cross-origin
  `fetch` before it leaves the page. Links to other origins are not followed.
- Study history stays in the WebView's `localStorage` (`manabi-cert-prep:sessions:v1`), as in the web build.
- To add an operation (for example the deferred R1 inference or encrypted sync), declare it in
  `src/descriptor.mjs` with `consent: "each-operation"`; the build derives the CSP from it. Do not add a
  second consent path.
- `vendor/` is a pinned copy of the canonical `kotoba-client-runtime.js` and consent CSS
  (`kotoba-lang/kotoba` `lib/kotoba.wasmWebcomponent/src`, revision in `vendor/PINS.json`); the build fails
  if a digest drifts. Update by re-pinning, never by editing.
- `npm test` runs the node tests (descriptor validity, CSP derivation, fail-closed build, host refusal).
  `cd src-tauri && cargo check --locked` needs `npm run build` first.

Not done here: signed release, store publication, an installed-app run on a device, license resolution.
