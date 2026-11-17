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

## Android

`src-tauri/gen/android` is the generated Tauri Android project (package `cloud.itonami.manabi_cert_prep`,
minSdk 35). It uses the same `dist/`, descriptor, CSP and broker as the desktop host; no Android permission
or plugin is added. Android needs SDK 35+, NDK 27.0.12077973 and JDK 21, with `ANDROID_HOME`, `NDK_HOME` and
`JAVA_HOME` set:

```sh
npm run build:android        # arm64 debug APK
npm run build:android:x86    # x86_64 debug APK (emulator)
```

The APK is a debug test artifact, not a signed or OTA release, and it is not enrolled in Itonami Store.
Tracking: AWAI-3196 (this unit), parent AWAI-3191 (education bot profile + Awai app on Awai Android).

Not done here: signed release, store publication, an installed-app run on a device, the bot profile and its
status view, license resolution.
