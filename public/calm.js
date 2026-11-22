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
  // Keep the device-local cap small; this is W1 scratch storage, not authoritative
  const MAX_LOCAL_ENTRIES = 200;

  function loadSessions() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
      return [];
    }
  }

  function saveSessions(sessions) {
    try {
      const trimmed = sessions.slice(-MAX_LOCAL_ENTRIES);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch (_e) {
      // localStorage may be unavailable (private mode); fail silently per G3 (no nag UI)
    }
  }

  // recordConceptTouched(certPathway, domain, conceptId)
  //   certPathway: "cisa" | "cissp"
  //   domain: string (e.g. "cisa-d2" or "cissp-d3")
  //   conceptId: string (free-form section anchor)
  //
  // DELIBERATELY missing fields (G15 + G16 + G3):
  //   - no "score"
  //   - no "correct/incorrect"
  //   - no "time-on-question"
  //   - no "rank"
  //   - no "streak-day"
  function recordConceptTouched(certPathway, domain, conceptId) {
    const sessions = loadSessions();
    sessions.push({
      kind: "concept_touched",
      certPathway: certPathway,
      domain: domain,
      conceptId: conceptId,
      tsUtc: new Date().toISOString(),
    });
    saveSessions(sessions);
  }

  function renderHistory(rootEl) {
    if (!rootEl) return;
    const sessions = loadSessions();
    if (sessions.length === 0) {
      rootEl.innerHTML =
        '<p class="calm-list-meta">まだ学習履歴はありません。Domain を選び、概念を読むと、この一覧に記録されていきます。</p>';
      return;
    }
    // Reverse-chronological flat list — DELIBERATELY no chart, no progress bar
    const ul = document.createElement("ul");
    ul.className = "calm-list";
    const reversed = sessions.slice().reverse();
    for (const s of reversed) {
      const li = document.createElement("li");
      const t = new Date(s.tsUtc);
      const dateStr = t.toLocaleString();
      const certLabel = s.certPathway === "cisa" ? "CISA" : "CISSP";
      li.innerHTML =
        '<div class="calm-list-domain">' +
        escapeHtml(certLabel) +
        " · " +
        escapeHtml(s.domain) +
        "</div>" +
        '<div class="calm-list-meta">' +
        escapeHtml(dateStr) +
        " · concept: " +
        escapeHtml(s.conceptId) +
        "</div>";
      ul.appendChild(li);
    }
    rootEl.innerHTML = "";
    rootEl.appendChild(ul);
  }

  function clearHistory() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_e) {
      /* ignore */
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c
      );
    });
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
