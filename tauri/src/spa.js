// One-document router for the Tauri frontend (KOTOBA-159). scripts/build.mjs folds
// every page of the static bundle into index.html as <section data-page="/x.html">.
// This module shows one section at a time and keeps the address in the hash
// (#/domains.html, #/study/cisa.html#d3), so links, Back and anchors behave as they
// did across separate pages. It never navigates the document and never touches
// the network. The web edition (../public served by the Worker) is unchanged.

export const INDEX = "/index.html";

// "/", "" and "/index.html" are the start page; anything else must be a folded page.
export function normalizePage(pathname, pages) {
  const p = pathname === "/" || pathname === "" ? INDEX : pathname;
  return pages.has(p) ? p : null;
}

// A link's href -> { page, anchor } inside this document, or null to leave it alone
// (another origin, an unknown path, or a plain in-page "#anchor").
export function routeFromHref(href, base, pages) {
  if (typeof href !== "string" || href === "" || href.startsWith("#")) return null;
  let url;
  try { url = new URL(href, base); } catch { return null; }
  if (url.origin !== new URL(base).origin) return null;
  const page = normalizePage(url.pathname, pages);
  return page ? { page, anchor: decodeURIComponent(url.hash.slice(1)) } : null;
}

// "#/study/cisa.html#d3" -> { page: "/study/cisa.html", anchor: "d3" }. Empty or unknown -> the start page.
export function routeFromHash(hash, pages) {
  const raw = typeof hash === "string" ? hash.replace(/^#/, "") : "";
  const cut = raw.indexOf("#");
  const path = cut < 0 ? raw : raw.slice(0, cut);
  const anchor = cut < 0 ? "" : decodeURIComponent(raw.slice(cut + 1));
  const page = normalizePage(path, pages);
  return page ? { page, anchor } : { page: INDEX, anchor: "" };
}

export const hashFor = ({ page, anchor }) => `#${page}${anchor ? `#${encodeURIComponent(anchor)}` : ""}`;

// The build prefixes ids that more than one page used ("d1" -> "study-cisa--d1").
export const idKey = (page) => page.replace(/^\//, "").replace(/\.html$/, "").replace(/[^A-Za-z0-9_-]/g, "-");

function init(doc, win) {
  const sections = new Map([...doc.querySelectorAll("section[data-page]")].map((s) => [s.dataset.page, s]));
  if (!sections.has(INDEX)) return;
  const pages = new Set(sections.keys());
  const show = ({ page, anchor }) => {
    for (const [p, s] of sections) s.hidden = p !== page;
    const section = sections.get(page);
    doc.title = section.dataset.title || doc.title;
    // The history page re-reads the device-local list each time it is shown, as a fresh page load did.
    if (page === "/history.html" && win.calm?.renderHistory) win.calm.renderHistory(doc.getElementById("history-root"));
    const target = anchor && (doc.getElementById(`${idKey(page)}--${anchor}`) || section.querySelector(`[id="${CSS.escape(anchor)}"]`));
    if (target) target.scrollIntoView(); else win.scrollTo(0, 0);
  };
  doc.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target?.closest?.("a[href]");
    if (!anchor) return;
    const route = routeFromHref(anchor.getAttribute("href"), win.location.href, pages);
    if (!route) return;
    event.preventDefault();
    const next = hashFor(route);
    if (win.location.hash === next) show(route); else win.location.hash = next;
  });
  win.addEventListener("hashchange", () => show(routeFromHash(win.location.hash, pages)));
  show(routeFromHash(win.location.hash, pages));
}

if (typeof document !== "undefined" && typeof window !== "undefined") init(document, window);
