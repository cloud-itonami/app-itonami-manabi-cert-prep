# Manabi Cert Prep — Tauri v3 host

Runs the static `public/` bundle as a Tauri 3.0.0-alpha.6 (Wry) app. The Worker (`src/app.ts`) and the
existing static hosting are unchanged; this directory is a second host.

- `npm run build` copies `../public` to `dist/`, adds the pinned consent broker (`runtime.js`), the host
  adapter (`host.js`) and the descriptor, and writes a per-page CSP derived from the descriptor.
- The descriptor declares **only the two public bot reads** below; the study pages use none. The CSP is
  `connect-src 'self' https://bots.itonami.cloud`, equal to what the runtime derives from the descriptor
  (checked in the tests). `host.js` rejects any other cross-origin `fetch` before it leaves the page, and
  sends a declared one only after its own approval dialog. Links to other origins are not followed.

## Paired education bot (AWAI-3199)

- **Profile**: [`../profiles/business-bot-profile.json`](../profiles/business-bot-profile.json) holds the
  unchanged `bot-profile:cloud-itonami-8569` entry (Community Learning Support, `education/support`, governor
  `learner-safety-governor`), copied from `com-junkawasaki/root`
  `90-docs/business/itonami-business-bot-profiles.json`; the revision is under `provenance`. Update it only
  from that registry. It is a design and provisioning record, not a launch.
- **Page**: the Tauri build adds `bot.html` (linked from the home page nav) with `src/bot-domain.mjs`. On a
  button press it reads `GET https://bots.itonami.cloud/v1/grok-bots/businesses` and, only for a bot id
  from that list, `GET /v1/grok-bots/bots/{bot_id}/activity`. Each read opens its own approval dialog;
  denying sends nothing; nothing refreshes in the background; there are no write operations.
- **Health is fail-closed**: `healthy` only when the status is `running`, a checkpoint exists and is younger
  than two intervals, the activity was read, and the newest event has no error. `running` with any gap is
  `unhealthy`; unread activity is `unknown`. Responses whose shape, bot id, time or sha256 digest cannot be
  checked are refused, not shown.
- **State on 2026-11-18** (`test/fixtures/businesses-20261118.json`): the 8569 bot is **not launched**. The
  public list has 5 other bots, all `held` or `paused`. Launching is out of scope (AWAI-3200, on hold).
- The app matches the list row by the registry id `cloud-itonami-8569`. Launched rows use ids such as
  `cloud-itonami-isic-7310`; if 8569 is launched under `cloud-itonami-isic-8569`, this page would show
  "not launched". Reconcile the id at launch time rather than guessing an alias here.
- Study history stays in the WebView's `localStorage` (`manabi-cert-prep:sessions:v1`), as in the web build.
- To add an operation (for example the deferred R1 inference or encrypted sync), declare it in
  `src/descriptor.mjs` with `consent: "each-operation"`; the build derives the CSP from it. Do not add a
  second consent path.
- `vendor/` is a pinned copy of the canonical `kotoba-client-runtime.js` and consent CSS
  (`kotoba-lang/kotoba` `lib/kotoba.wasmWebcomponent/src`, revision in `vendor/PINS.json`); the build fails
  if a digest drifts. Update by re-pinning, never by editing.
- `npm test` runs the node tests (descriptor validity, CSP derivation, fail-closed build, host refusal, and
  the bot domain on real captured fixtures with negative controls).
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

Design for per-operation approval of bot actions (not implemented, blocked): [`../docs/bot-approval-design.md`](../docs/bot-approval-design.md).

Not done here: signed release, store publication, an installed-app run on a device, bot launch, app-to-bot
write operations, license resolution.
