// parley.tw — progressive enhancement only. Without this file the page is complete:
// the Mac download is the default CTA, the transcript is shown in full, and every
// section is visible. No dependencies.
(() => {
  "use strict";

  const root = document.documentElement;
  const pageLang = root.dataset.lang === "en" ? "en" : "zh";
  let data = {};
  try {
    data = JSON.parse(document.getElementById("page-data")?.textContent || "{}");
  } catch {
    data = {};
  }
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

  /* ---------- Storage (may throw in private windows or with blocked site data) ---------- */
  const store = {
    get(key) {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch { /* not persisted; fine */ }
    },
  };

  /* ---------- OS-aware download buttons ---------- */
  const LINKS = {
    mac: "https://api.parley.tw/download?platform=macos",
    windows: "https://api.parley.tw/download?platform=windows",
    ios: "https://apps.apple.com/app/id6795031201",
    android: "https://play.google.com/store/apps/details?id=com.pathors.parley",
  };

  function detectOS() {
    const ua = navigator.userAgent || "";
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    // iPadOS reports itself as a Mac; touch points give it away.
    if (/iPhone|iPad|iPod/.test(ua) || (/Mac/.test(platform) && navigator.maxTouchPoints > 1)) return "ios";
    if (/Android/i.test(ua)) return "android";
    if (/Win/i.test(platform) || /Windows/.test(ua)) return "windows";
    return "mac";
  }

  function setupDownloads(os) {
    const heroCta = {
      mac: { href: LINKS.mac, label: data.ctaMac, icon: "mac" },
      windows: { href: LINKS.windows, label: data.ctaWindows, icon: "windows" },
      ios: { href: LINKS.ios, label: data.ctaAppStore, icon: "ios" },
      android: { href: LINKS.android, label: data.ctaAndroid, icon: "android" },
    }[os];
    const primary = document.getElementById("cta-primary");
    const secondary = document.getElementById("cta-secondary");
    if (primary && heroCta && heroCta.label) {
      primary.href = heroCta.href;
      primary.dataset.os = heroCta.icon;
      const label = primary.querySelector(".cta-label");
      if (label) label.textContent = heroCta.label;
    }
    if (secondary && (os === "ios" || os === "android") && data.ctaDesktop) {
      // Phone visitors already hold the phone; offer the desktop apps instead.
      secondary.href = "#download";
      secondary.textContent = data.ctaDesktop;
    }

    const row = document.getElementById("dl-row");
    if (!row) return;
    const order = {
      mac: ["mac", "windows", "ios", "android", "source"],
      windows: ["windows", "mac", "ios", "android", "source"],
      ios: ["ios", "mac", "windows", "android", "source"],
      android: ["android", "windows", "mac", "ios", "source"],
    }[os];
    const items = new Map([...row.children].map((el) => [el.dataset.os, el]));
    order.forEach((key) => {
      const el = items.get(key);
      if (el) row.appendChild(el);
    });
    // The first entry becomes the filled button, unless it is the Play badge,
    // which must stay Google's unmodified artwork.
    items.forEach((el, key) => {
      if (key === "android") return;
      const first = key === order[0];
      el.classList.toggle("b1", first);
      el.classList.toggle("b2", !first);
    });
  }

  /* ---------- Language suggestion (no redirect; a dismissible bar) ---------- */
  function setupLangBar() {
    const bar = document.getElementById("langbar");
    if (!bar) return;
    const KEY = "parley.langbar.dismissed";
    if (store.get(KEY) === "1") return;
    const prefs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""];
    const prefersZh = /^zh\b/i.test(prefs[0] || "");
    const mismatch = pageLang === "zh" ? !prefersZh : prefersZh;
    if (!mismatch) return;
    bar.hidden = false;
    bar.querySelector(".langbar__close")?.addEventListener("click", () => {
      bar.hidden = true;
      store.set(KEY, "1");
    });
  }

  /* ---------- Nav: hairline once scrolled, and the small-screen menu ---------- */
  function setupNav() {
    const nav = document.getElementById("nav");
    if (!nav) return;
    const onScroll = () => nav.classList.toggle("is-scrolled", window.scrollY > 8);
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });

    const button = nav.querySelector(".nav__menu");
    const close = () => {
      nav.classList.remove("is-open");
      button?.setAttribute("aria-expanded", "false");
    };
    button?.addEventListener("click", () => {
      const open = nav.classList.toggle("is-open");
      button.setAttribute("aria-expanded", String(open));
    });
    nav.querySelectorAll(".nav__links a").forEach((a) => a.addEventListener("click", close));
    addEventListener("keydown", (e) => {
      if (e.key === "Escape" && nav.classList.contains("is-open")) {
        close();
        button?.focus();
      }
    });
  }

  /* ---------- Copy button for the MCP command ---------- */
  function setupCopy() {
    document.querySelectorAll(".code__copy").forEach((btn) => {
      const original = btn.textContent;
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(btn.dataset.copy || "");
          btn.textContent = btn.dataset.done || original;
          btn.classList.add("is-done");
          setTimeout(() => {
            btn.textContent = original;
            btn.classList.remove("is-done");
          }, 1600);
        } catch {
          /* clipboard unavailable: the command is on screen to select by hand */
        }
      });
    });
  }

  /* ---------- 160ms fade-in on scroll (no movement) ---------- */
  function setupFades() {
    const els = document.querySelectorAll(".fade");
    const showAll = () => els.forEach((el) => el.classList.add("in"));
    if (reduceMotion.matches || !("IntersectionObserver" in window)) return showAll();
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: "0px 0px -6% 0px" },
    );
    els.forEach((el) => io.observe(el));
  }

  /* ---------- Hero: live transcript + waveform ----------
     One sample per 85ms, measured from synthesized speech of the exact two lines
     on screen (website/tools/hero-rms). A run of zeros is the silence between the
     speakers, so the text only advances while someone is talking, and the
     waveform is a dotted centreline when nobody is. */
  function setupHero() {
    const RMS = Array.isArray(data.rms) ? data.rms : [];
    const lines = document.getElementById("lines");
    const canvas = document.getElementById("wave");
    const clock = document.getElementById("clock");
    if (!RMS.length || !lines || !canvas || !canvas.getContext) return;
    const ctx = canvas.getContext("2d");
    const HOP = 85;
    const H = 34;
    const BAR = 3;
    const STEP = 5; // 3px bar + 2px gap
    const texts = [data.line1 || "", data.line2 || ""];
    const who = [data.speakerA || "A", data.speakerB || "B"];

    // Turn boundaries = runs of true silence in the data.
    const turns = [];
    {
      let start = 0;
      let i = 0;
      while (i < RMS.length) {
        if (RMS[i] === 0) {
          let j = i;
          while (j < RMS.length && RMS[j] === 0) j++;
          if (j - i >= 6) {
            turns.push([start, i]);
            start = j;
          }
          i = j;
        } else i++;
      }
      if (start < RMS.length) turns.push([start, RMS.length]);
    }

    let color = "20, 105, 212";
    const readColor = () => {
      const m = getComputedStyle(canvas).color.match(/\d+(\.\d+)?/g);
      if (m && m.length >= 3) color = `${m[0]}, ${m[1]}, ${m[2]}`;
    };

    let hist = [];
    function size() {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }
    function draw() {
      const w = canvas.width / (window.devicePixelRatio || 1);
      const mid = H / 2;
      ctx.clearRect(0, 0, w, H);
      const n = Math.floor(w / STEP);
      const recent = hist.slice(-n);
      const off = n - recent.length;
      for (let k = 0; k < n; k++) {
        const v = k < off ? 0 : recent[k - off];
        const x = w - (n - k) * STEP;
        const fresh = k >= n - 6; // newest six bars at full strength
        ctx.fillStyle = `rgba(${color}, ${fresh ? 0.9 : 0.35})`;
        ctx.beginPath();
        if (v < 0.05) {
          ctx.arc(x + BAR / 2, mid, 1.1, 0, Math.PI * 2); // silence: a dotted centreline
        } else {
          const bh = Math.max(3, v * (H - 4));
          if (ctx.roundRect) ctx.roundRect(x, mid - bh / 2, BAR, bh, 1.5);
          else ctx.rect(x, mid - bh / 2, BAR, bh);
        }
        ctx.fill();
      }
    }

    const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    function makeTurn(label) {
      const el = document.createElement("div");
      el.className = "turn";
      el.innerHTML =
        '<div class="who on"><span class="nm"></span><span class="ts"></span></div>' +
        '<div class="txt"><span class="set"></span><span class="tail"></span></div>';
      el.querySelector(".nm").textContent = label;
      lines.appendChild(el);
      while (lines.children.length > 3) lines.removeChild(lines.firstChild);
      return el;
    }

    readColor();
    let timer = null;
    let visible = true;

    function showStatic() {
      // Reduced motion: the full transcript (already in the HTML) and the whole
      // waveform as its last frame.
      clearInterval(timer);
      timer = null;
      hist = RMS.slice();
      size();
    }

    function start() {
      lines.innerHTML = "";
      hist = [];
      let tick = 0;
      let secs = 18 * 60 + 47;
      let els = [];
      const total = RMS.length + 14; // a short pause before it loops
      const settleLag = pageLang === "zh" ? 6 : 18; // characters still "unsettled"
      timer = setInterval(() => {
        if (!visible || document.hidden) return;
        const i = tick % total;
        if (i === 0 && tick > 0) {
          lines.innerHTML = "";
          els = [];
        }
        hist.push(i < RMS.length ? RMS[i] : 0);
        if (hist.length > 400) hist.shift();
        if (tick % 12 === 0 && clock) clock.textContent = fmt(secs++);
        turns.forEach(([a, b], t) => {
          if (i === a) {
            els[t] = makeTurn("…"); // speaker not decided yet
            els[t].querySelector(".ts").textContent = fmt(12 + t * 15);
            lines.querySelectorAll(".who").forEach((w) => w.classList.remove("on"));
            els[t].querySelector(".who").classList.add("on");
          }
          const el = els[t];
          if (!el || i < a || i > b + 4) return;
          const text = texts[t] || "";
          const p = Math.min(1, (i - a) / Math.max(1, b - a));
          const n = Math.round(text.length * p);
          const settled = Math.max(0, n - settleLag);
          el.querySelector(".set").textContent = i > b ? text : text.slice(0, settled);
          el.querySelector(".tail").textContent = i > b ? "" : text.slice(settled, n);
          if (i - a === 10) el.querySelector(".nm").textContent = who[t] || ""; // resolves after ~0.85s
        });
        draw();
        tick++;
      }, HOP);
    }

    let started = false;
    function run() {
      started = true;
      clearInterval(timer);
      timer = null;
      if (reduceMotion.matches) showStatic();
      else {
        size();
        start();
      }
    }

    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => {
        visible = entries.some((e) => e.isIntersecting);
        // Below the fold (phones), the full transcript stays in place until the
        // demo scrolls into view, then it starts live from the first word.
        if (visible && !started) run();
      }).observe(canvas);
    } else {
      run();
    }
    let resizeRaf = 0;
    addEventListener("resize", () => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(size);
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
      readColor();
      draw();
    });
    reduceMotion.addEventListener?.("change", () => {
      if (reduceMotion.matches) {
        // Put the full transcript back before freezing.
        lines.innerHTML = "";
        texts.forEach((text, t) => {
          const el = makeTurn(who[t]);
          el.querySelector(".ts").textContent = fmt(12 + t * 15);
          el.querySelector(".who").classList.toggle("on", t === texts.length - 1);
          el.querySelector(".set").textContent = text;
        });
      }
      if (started) run();
    });
    if (reduceMotion.matches) run();
    else size();
  }

  setupLangBar();
  setupNav();
  setupDownloads(detectOS());
  setupCopy();
  setupFades();
  setupHero();
})();
