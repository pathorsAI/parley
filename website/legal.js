// Language toggle for the bilingual legal pages (/support/, /privacy/, /account-deletion/).
// Each page carries both languages in the DOM: <article lang="zh-Hant-TW" data-lang="zh"> and
// <article lang="en" data-lang="en">, plus footer navs marked the same way. Without this script
// both are shown (zh first) and the header switcher is a plain in-page link to #en.
// Choice order: ?lang=zh|en → saved choice → #zh/#en → navigator.language (zh* → zh, else en).
(function () {
  "use strict";

  const KEY = "parley.lang";
  const HTML_LANG = { zh: "zh-Hant-TW", en: "en" };
  const SWITCH_LABEL = { zh: "English", en: "中文" };
  const HOME = { zh: "../", en: "../en/" };

  function normalize(value) {
    if (!value) return null;
    value = String(value).toLowerCase();
    if (value === "zh" || value.startsWith("zh-")) return "zh";
    if (value === "en" || value.startsWith("en-")) return "en";
    return null;
  }

  // Storage throws in private windows and with blocked site data. Reading then
  // counts as "nothing saved", and a failed write is reported so callers know the
  // choice lives only in the URL.
  function readSaved() {
    try {
      return normalize(globalThis.localStorage.getItem(KEY));
    } catch {
      return null;
    }
  }

  function save(lang) {
    try {
      globalThis.localStorage.setItem(KEY, lang);
      return true;
    } catch {
      return false;
    }
  }

  function readQuery() {
    try {
      return normalize(new URLSearchParams(globalThis.location.search).get("lang"));
    } catch {
      return null; // very old browser without URLSearchParams: no query choice
    }
  }

  function initial() {
    const fromQuery = readQuery();
    if (fromQuery) return fromQuery;
    const saved = readSaved();
    if (saved) return saved;
    const fromHash = normalize(globalThis.location.hash.slice(1));
    if (fromHash) return fromHash;
    const nav = navigator.languages?.[0] || navigator.language || "";
    return String(nav).toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  function apply(lang) {
    const other = lang === "zh" ? "en" : "zh";
    for (const block of document.querySelectorAll("[data-lang]")) {
      if (block.dataset.lang === lang) block.removeAttribute("hidden");
      else block.setAttribute("hidden", "");
    }

    const root = document.documentElement;
    root.setAttribute("lang", HTML_LANG[lang]);
    root.dataset.langActive = lang;

    const article = document.querySelector('article[data-lang="' + lang + '"]');
    if (article) {
      const title = article.dataset.title;
      if (title) document.title = title;
      const description = article.dataset.description;
      const meta = document.querySelector('meta[name="description"]');
      if (description && meta) meta.setAttribute("content", description);
    }

    const home = document.querySelector("[data-home]");
    if (home) home.setAttribute("href", HOME[lang]);

    const toggle = document.querySelector("[data-lang-switch]");
    if (toggle) {
      toggle.textContent = SWITCH_LABEL[lang];
      toggle.setAttribute("lang", HTML_LANG[other]);
      toggle.setAttribute("hreflang", HTML_LANG[other]);
      toggle.setAttribute("href", "?lang=" + other);
    }
  }

  // Returns whether the address bar now carries the choice. It cannot on file://
  // or in an old browser; the visible switch still works either way.
  function setUrl(lang) {
    try {
      const url = new URL(globalThis.location.href);
      url.searchParams.set("lang", lang);
      if (url.hash === "#zh" || url.hash === "#en") url.hash = "";
      globalThis.history.replaceState(null, "", url.pathname + url.search + url.hash);
      return true;
    } catch {
      return false;
    }
  }

  let current = initial();
  apply(current);

  const toggle = document.querySelector("[data-lang-switch]");
  if (toggle) {
    toggle.addEventListener("click", function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      current = current === "zh" ? "en" : "zh";
      save(current);
      setUrl(current);
      apply(current);
      globalThis.scrollTo(0, 0);
    });
  }
})();
