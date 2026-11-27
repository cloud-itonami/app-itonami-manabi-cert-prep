// calm.js — minimal interactivity for manabi cert_prep W1 static UI
//
// Per ADR-2605264400 + ADR-2605261045 G3:
//   - NO auto-advance between concepts (every navigation is explicit user tap)
//   - NO streak counter (deliberately absent)
//   - NO leaderboard / no comparison-with-others (deliberately absent)
//   - NO push notification (deliberately absent)
//   - NO LLM call at W0/W1 (R1+ feature; flips gated on Council ratify)
//
// What this file DOES:
//   1. Record session entries to localStorage (owner-device-only at W1;
//      R1+ will replace with encrypted-envelope MST persistence per ADR-2605181100).
//   2. Render history list on /history.html from localStorage.
//   3. Mark concept-touched events when user clicks "次へ" between sections.

(function () {
  "use strict";

  const STORAGE_KEY = "manabi-cert-prep:sessions:v1";
  // Must stay aligned with tauri/src/descriptor.mjs local-state.{schema,version}.
  const LOCAL_STATE_SCHEMA = "manabi-cert-prep.sessions.v1";
  const LOCAL_STATE_VERSION = 1;
  // Keep the device-local cap small; this is W1 scratch storage, not authoritative
  const MAX_LOCAL_ENTRIES = 200;
  const MAX_FIELD_LEN = 128;
  const ALLOWED_PATHWAYS = new Set(["cisa", "cissp"]);
  const ALLOWED_ENTRY_KEYS = new Set(["kind", "certPathway", "domain", "conceptId", "tsUtc"]);

  function sanitizeSessionEntry(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const keys = Object.keys(entry);
    if (keys.length !== ALLOWED_ENTRY_KEYS.size || !keys.every(function (k) { return ALLOWED_ENTRY_KEYS.has(k); })) {
      return null;
    }
    if (entry.kind !== "concept_touched") return null;
    if (typeof entry.certPathway !== "string" || !ALLOWED_PATHWAYS.has(entry.certPathway)) return null;
    if (typeof entry.domain !== "string" || entry.domain.trim() === "" || entry.domain.length > MAX_FIELD_LEN) return null;
    if (typeof entry.conceptId !== "string" || entry.conceptId.trim() === "" || entry.conceptId.length > MAX_FIELD_LEN) return null;
    if (typeof entry.tsUtc !== "string" || entry.tsUtc.length > 64 || !Number.isFinite(Date.parse(entry.tsUtc))) return null;
    return {
      kind: "concept_touched",
      certPathway: entry.certPathway,
      domain: entry.domain,
      conceptId: entry.conceptId,
      tsUtc: entry.tsUtc,
    };
  }

  function loadSessions() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      let entries = null;
      if (Array.isArray(parsed)) {
        // Legacy W1 flat array format — migrate to validated entries.
        entries = parsed;
      } else if (parsed && typeof parsed === "object") {
        if (parsed.schema !== LOCAL_STATE_SCHEMA || parsed.version !== LOCAL_STATE_VERSION || !Array.isArray(parsed.entries)) {
          return [];
        }
        entries = parsed.entries;
      } else {
        return [];
      }
      const valid = [];
      for (const item of entries) {
        const clean = sanitizeSessionEntry(item);
        if (clean) valid.push(clean);
      }
      return valid.slice(-MAX_LOCAL_ENTRIES);
    } catch (_e) {
      return [];
    }
  }

  function saveSessions(sessions) {
    try {
      const valid = [];
      for (const item of sessions) {
        const clean = sanitizeSessionEntry(item);
        if (clean) valid.push(clean);
      }
      const trimmed = valid.slice(-MAX_LOCAL_ENTRIES);
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          schema: LOCAL_STATE_SCHEMA,
          version: LOCAL_STATE_VERSION,
          entries: trimmed,
        }),
      );
    } catch (_e) {
      // localStorage may be unavailable (private mode); fail silently per G3 (no nag UI)
    }
  }

  // recordConceptTouched(certPathway, domain, conceptId)
  //   certPathway: "cisa" | "cissp"
  //   domain: string (e.g. "cisa-d2" or "cissp-d3")
  //   conceptId: string (free-form section anchor)
  //
  // DELIBERATELY missing fields (G15 + G16 + G3) and R2 boundary (personalMaterialImport
  // is R2-gated and must never be stored in W1 localStorage):
  //   - no "score"
  //   - no "correct/incorrect"
  //   - no "time-on-question"
  //   - no "rank"
  //   - no "streak-day"
  //   - no personal-material import / user-imported-personal-only payload
  function recordConceptTouched(certPathway, domain, conceptId) {
    const candidate = sanitizeSessionEntry({
      kind: "concept_touched",
      certPathway: certPathway,
      domain: domain,
      conceptId: conceptId,
      tsUtc: new Date().toISOString(),
    });
    if (!candidate) return false;
    const sessions = loadSessions();
    sessions.push(candidate);
    saveSessions(sessions);
    return true;
  }

  function renderHistory(rootEl) {
    if (!rootEl) return;
    const sessions = loadSessions();
    if (sessions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "calm-list-meta";
      empty.textContent = "まだ学習履歴はありません。Domain を選び、概念を読むと、この一覧に記録されていきます。";
      rootEl.replaceChildren(empty);
      return;
    }
    // Reverse-chronological flat list — DELIBERATELY no chart, no progress bar.
    // All text is set via textContent only (no innerHTML).
    const ul = document.createElement("ul");
    ul.className = "calm-list";
    const reversed = sessions.slice().reverse();
    for (const s of reversed) {
      const li = document.createElement("li");
      const t = new Date(s.tsUtc);
      const dateStr = t.toLocaleString();
      const certLabel = s.certPathway === "cisa" ? "CISA" : "CISSP";
      const domainDiv = document.createElement("div");
      domainDiv.className = "calm-list-domain";
      domainDiv.textContent = certLabel + " · " + s.domain;
      const metaDiv = document.createElement("div");
      metaDiv.className = "calm-list-meta";
      metaDiv.textContent = dateStr + " · concept: " + s.conceptId;
      li.appendChild(domainDiv);
      li.appendChild(metaDiv);
      ul.appendChild(li);
    }
    rootEl.replaceChildren(ul);
  }

  function clearHistory() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_e) {
      /* ignore */
    }
  }

  // Wire concept-section "次へ" buttons on study pages
  function wireConceptButtons() {
    const buttons = document.querySelectorAll("button.calm-button[data-record-concept]");
    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        const cert = btn.getAttribute("data-cert-pathway") || "";
        const domain = btn.getAttribute("data-domain") || "";
        const concept = btn.getAttribute("data-record-concept") || "";
        if (cert && domain && concept) {
          recordConceptTouched(cert, domain, concept);
        }
        // No auto-advance; we just record. User scrolls or clicks the next link explicitly.
      });
    });
  }

  // Wire history page
  function wireHistoryPage() {
    const root = document.getElementById("history-root");
    if (root) {
      renderHistory(root);
    }
    const clearBtn = document.getElementById("history-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        openClearConfirm(clearBtn, function () {
          clearHistory();
          if (root) renderHistory(root);
        });
      });
    }
  }

  // The app's own confirmation instead of window.confirm(): a sandboxed app
  // (restricted-wasm-v1, KOTOBA-159) has no native dialogs, where confirm()
  // returns false without asking. Modal like confirm(): a <dialog> opened with
  // showModal() (not blocked by sandbox="allow-scripts"), so the rest of the page
  // is inert and aria-modal holds. Focus starts on "やめる" (the safe answer for a
  // destructive action), Tab stays inside, Escape cancels, and focus returns to
  // the button that opened it. Nothing is deleted until "削除する" is pressed.
  // Text is set with textContent only.
  const CLEAR_CONFIRM_TEXT = "この端末に保存された学習履歴を全て削除します。よろしいですか?";
  function openClearConfirm(clearBtn, onConfirm) {
    if (document.getElementById("history-clear-confirm")) return;
    const dialog = document.createElement("dialog");
    dialog.id = "history-clear-confirm";
    dialog.className = "calm-card calm-dialog";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "history-clear-confirm-text");
    const text = document.createElement("p");
    text.id = "history-clear-confirm-text";
    text.textContent = CLEAR_CONFIRM_TEXT;
    const actions = document.createElement("p");
    const yes = document.createElement("button");
    yes.type = "button";
    yes.id = "history-clear-yes";
    yes.className = "calm-button";
    yes.textContent = "削除する";
    const no = document.createElement("button");
    no.type = "button";
    no.id = "history-clear-no";
    no.className = "calm-button secondary";
    no.textContent = "やめる";
    actions.appendChild(yes);
    actions.appendChild(document.createTextNode(" "));
    actions.appendChild(no);
    dialog.appendChild(text);
    dialog.appendChild(actions);
    let confirmed = false;
    dialog.addEventListener("close", function () {
      dialog.remove();
      if (confirmed) onConfirm();
      clearBtn.focus();
    });
    // Escape: the browser fires "cancel" and closes; treat it as "やめる".
    dialog.addEventListener("cancel", function () { confirmed = false; });
    // Tab and Shift+Tab cycle between the two buttons only.
    dialog.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      e.preventDefault();
      (document.activeElement === yes ? no : yes).focus();
    });
    yes.addEventListener("click", function () { confirmed = true; dialog.close(); });
    no.addEventListener("click", function () { dialog.close(); });
    document.body.appendChild(dialog);
    dialog.showModal();
    no.focus();
  }

  document.addEventListener("DOMContentLoaded", function () {
    wireConceptButtons();
    wireHistoryPage();
  });

  // Expose minimal API on window for inline page use (no global state pollution otherwise)
  window.calm = {
    recordConceptTouched: recordConceptTouched,
    renderHistory: renderHistory,
    clearHistory: clearHistory,
  };

  // DELIBERATELY ABSENT (G3 + G15 enforcement, do not add without ADR amendment):
  //   - no recordCorrect / recordIncorrect / recordScore
  //   - no recordStreak / getCurrentStreak / getLongestStreak
  //   - no getRanking / getLeaderboard / getCohortPercentile
  //   - no schedulePushNotification / scheduleReminder
  //   - no recordPassRatePrediction / recordPassProbability
  //   - no LLM fetch / no judah call / no XRPC POST at W0/W1
})();
