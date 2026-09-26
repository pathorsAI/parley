// Language toggle for the bilingual legal pages (/support/, /privacy/, /account-deletion/).
// Each page carries both languages in the DOM: <article lang="zh-Hant-TW" data-lang="zh"> and
// <article lang="en" data-lang="en">, plus footer navs marked the same way. Without this script
// both are shown (zh first) and the header switcher is a plain in-page link to #en.
// Choice order: ?lang=zh|en → saved choice → #zh/#en → navigator.language (zh* → zh, else en).
(function () {
  "use strict";

  var KEY = "parley.lang";
  var HTML_LANG = { zh: "zh-Hant-TW", en: "en" };
  var SWITCH_LABEL = { zh: "English", en: "中文" };
  var HOME = { zh: "../", en: "../en/" };

  function normalize(value) {
    if (!value) return null;
    value = String(value).toLowerCase();
    if (value === "zh" || value.indexOf("zh-") === 0) return "zh";
    if (value === "en" || value.indexOf("en-") === 0) return "en";
    return null;
  }

  function readSaved() {
    try {
      return normalize(window.localStorage.getItem(KEY));
    } catch (e) {
      return null;
    }
  }

  function save(lang) {
    try {
      window.localStorage.setItem(KEY, lang);
    } catch (e) {
      /* storage unavailable (private mode, blocked site data): the URL still carries the choice */
    }
  }

  function initial() {
    var fromQuery = null;
    try {
      fromQuery = normalize(new URLSearchParams(window.location.search).get("lang"));
    } catch (e) {
      /* very old browser: fall through */
    }
    if (fromQuery) return fromQuery;
    var saved = readSaved();
    if (saved) return saved;
    var fromHash = normalize(window.location.hash.slice(1));
    if (fromHash) return fromHash;
    var nav = (navigator.languages && navigator.languages[0]) || navigator.language || "";
    return String(nav).toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
  }

  function apply(lang) {
    var other = lang === "zh" ? "en" : "zh";
    var blocks = document.querySelectorAll("[data-lang]");
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].getAttribute("data-lang") === lang) blocks[i].removeAttribute("hidden");
      else blocks[i].setAttribute("hidden", "");
    }

    var root = document.documentElement;
    root.setAttribute("lang", HTML_LANG[lang]);
    root.setAttribute("data-lang-active", lang);

    var article = document.querySelector('article[data-lang="' + lang + '"]');
    if (article) {
      var title = article.getAttribute("data-title");
      if (title) document.title = title;
      var description = article.getAttribute("data-description");
      var meta = document.querySelector('meta[name="description"]');
      if (description && meta) meta.setAttribute("content", description);
    }

    var home = document.querySelector("[data-home]");
    if (home) home.setAttribute("href", HOME[lang]);

    var toggle = document.querySelector("[data-lang-switch]");
    if (toggle) {
      toggle.textContent = SWITCH_LABEL[lang];
      toggle.setAttribute("lang", HTML_LANG[other]);
      toggle.setAttribute("hreflang", HTML_LANG[other]);
      toggle.setAttribute("href", "?lang=" + other);
    }
  }

  function setUrl(lang) {
    try {
      var url = new URL(window.location.href);
      url.searchParams.set("lang", lang);
      if (url.hash === "#zh" || url.hash === "#en") url.hash = "";
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    } catch (e) {
      /* file:// or an old browser: the visible switch still works */
    }
  }

  var current = initial();
  apply(current);

  var toggle = document.querySelector("[data-lang-switch]");
  if (toggle) {
    toggle.addEventListener("click", function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      current = current === "zh" ? "en" : "zh";
      save(current);
      setUrl(current);
      apply(current);
      window.scrollTo(0, 0);
    });
  }
})();
