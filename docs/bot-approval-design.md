# Per-operation approval of the education bot's actions — design (AWAI-3201)

Status: design, 2026-11-18. Nothing here is implemented. Tracking:
[AWAI-3201](https://linear.app/kotobalabs/issue/AWAI-3201), parent
[AWAI-3191](https://linear.app/kotobalabs/issue/AWAI-3191).

## Goal

The paired bot (`bot-profile:cloud-itonami-8569`, Community Learning Support, governor
`learner-safety-governor`) may propose actions that reach people or services outside the
device: sending a study plan, an attendance follow-up, scholarship guidance. A learner (or
guardian) sees each proposal in this app and approves or denies **that one action**. Denying
sends nothing. The approval goes from the browser straight to the bot plane through the canonical
operation broker; this app adds no consent logic of its own.

## What exists today (checked 2026-11-18)

| Part | State | Evidence |
|---|---|---|
| Canonical runtime `kotoba-client-runtime.js` and `kotoba.app.client-runtime.v1` | **Exists.** `kotoba-lang/kotoba` `lib/kotoba.wasmWebcomponent/src`. This app pins `5a49411` (`tauri/vendor/PINS.json`); upstream head is `ae0a75e` (adds a nearby-discovery peer profile, unrelated to HTTP writes). | `gh api` on the path; pin digests checked by the build |
| Write methods in the broker | Supported: `POST`/`PUT`/`PATCH`/`DELETE` routes, body bounded to 16 MiB and captured before consent, `credentials: "omit"`, no redirects for writes. | `kotoba-client-runtime.js` lines 45, 279–316 |
| What the trusted consent dialog shows | Service, operation, capability, endpoint origin, **method + path + query**, data categories, redirects. It does **not** show the request body or any app-supplied summary. | `createClientConsentHost`, lines ~790–806 |
| Public bot reads | `GET /v1/grok-bots/businesses` and `/bots/{id}/activity` on `https://bots.itonami.cloud`, no credentials (used by AWAI-3199). | `tauri/src/bot-domain.mjs` |
| Bot-plane write/approval route for end users | **None found.** The management surface (`/api/v1/grok-bots/bots`) needs the operator bearer `MURAKUMO_SERVICE_TOKEN`. In `network-awai/cloud-murakumo-api` `src/itonami_bot_runtime.js` (`6271516`), a proposal the governor does not commit is stored as `held`; nothing lets a person approve it. | `cloud-itonami/app-itonami-cloud-itonami-app` `bot_import.cljk`; `cloud-murakumo-api` |
| 8569 bot | Not launched; launch on hold (AWAI-3200). | AWAI-3199 fixtures |

## Design

### 1. The bot plane exposes held proposals and accepts a decision per proposal

Needed from the bot fleet (not this repo):

- `GET /v1/grok-bots/bots/{bot_id}/proposals` — public-by-design list of proposals in state
  `awaiting-person`, each with `proposal_id`, `kind` (closed set, see §4), a human-readable
  `summary`, the `recipient` category, `created_at`, `expires_at` and a sha256 `digest` over the
  canonical proposal. No learner personal data in this public list (see §5).
- `POST /v1/grok-bots/bots/{bot_id}/proposals/{proposal_id}/decision/{approve|deny}` — no query,
  empty body except the proof in §3. The ids and the decision are **in the path** so that the
  trusted dialog's `Action:` line shows exactly which proposal and which decision is sent.
- The plane executes an approved proposal once, only if its digest still matches, before
  `expires_at`, and only through the governed tool the governor already allowed. A denial or an
  expiry closes the proposal. Every decision is an append-only activity event.

### 2. The app declares the routes; the canonical broker does the rest

Added to `tauri/src/bot-domain.mjs` `operations` (only once §1 exists):

- `read-proposals`: `GET`, path-prefix `/v1/grok-bots/bots/`, data categories `request-ip`, `bot-id`.
- `decide-proposal`: `POST`, path-prefix `/v1/grok-bots/bots/`, data categories `request-ip`,
  `bot-id`, `proposal-id`, `learner-decision`. `consent: "each-operation"`.

The page builds the URL only from a `bot_id` and `proposal_id` it read and verified (same `safeId`
rules as AWAI-3199). `host.js` already routes any declared cross-origin request through
`broker.invoke`; each decision opens its own dialog; a denial in the dialog sends nothing.
Approval in the dialog is not persisted, minted or reused by app code.

### 3. Who is approving

`credentials: "omit"` is fixed by the runtime, and an end-user app must not carry the operator
token. The plane therefore needs a proof that the decision comes from the learner bound to that
bot, sent in the body. Candidates, to be chosen by the owner with the Awai identity work:
an Awai identity / Passkey (WebAuthn) assertion over `proposal_id + decision + digest`, or a
per-assignment key enrolled on the device. This is outside the client runtime and must not be
invented in this repo.

### 4. Closed set of actions

Only the offer of 8569 maps to actions: `study-plan.send`, `attendance.follow-up`,
`scholarship.guidance`. Anything else is not shown and cannot be approved. The set lives in the
bot plane's governor and is mirrored here for display only.

### 5. Learner data and minors

The public proposal list must not carry learner names, contact details or messages; it carries a
summary the governor writes with categories only. Whether learners can be minors (and therefore
need guardian approval and age-appropriate wording) is an owner decision that must precede launch
(AWAI-3200).

## Gaps found in the canonical runtime (no product-local workaround)

- **The trusted dialog cannot show what is being approved beyond method and path.** Putting ids
  in the path makes the dialog identify the proposal, but not its content. The page can show the
  summary, but page content is not trusted consent UI. Proposed canonical change: an optional,
  bounded, declared `summary` (or digest-bound scope, like the peer `Transfer scope:` line) that the
  dialog renders. Tracked in KOTOBA-960; this repo will not draw its own
  dialog.
- The app pins `5a49411`; re-pin to the head that carries any such change, through `PINS.json`.

## Blockers for implementing AWAI-3201

1. No end-user decision route on the bot plane (§1) — needs the bot-fleet owner. [AWAI-3270](https://linear.app/kotobalabs/issue/AWAI-3270).
2. No learner identity proof (§3) — needs the Awai identity decision.
3. 8569 not launched (AWAI-3200, on hold) — there are no proposals to approve yet.
4. Consent dialog cannot show the proposal content (canonical gap above). [KOTOBA-960](https://linear.app/kotobalabs/issue/KOTOBA-960).

Until these are resolved, the app keeps only the two read operations from AWAI-3199.

## Acceptance once unblocked

- Tests: approve and deny each send exactly one declared request only after a dialog decision;
  a dialog denial sends nothing; an undeclared method/path/query/origin is refused; a proposal whose
  digest, kind, bot id or expiry cannot be verified is not shown.
- Device evidence on AOSP emulator and hardware (AWAI-3202).
