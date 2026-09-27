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
    // Chromium names the platform outright; elsewhere the user-agent string is all there is.
    const platform = navigator.userAgentData?.platform || "";
    const looksLikeMac = /Mac/i.test(platform) || /Macintosh/.test(ua);
    // iPadOS reports itself as a Mac; touch points give it away.
    if (/iPhone|iPad|iPod/.test(ua) || (looksLikeMac && navigator.maxTouchPoints > 1)) return "ios";
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
    if (primary && heroCta?.label) {
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
    const prefs = navigator.languages?.length ? navigator.languages : [navigator.language || ""];
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
  function showCopied(btn, original) {
    btn.textContent = btn.dataset.done || original;
    btn.classList.add("is-done");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("is-done");
    }, 1600);
  }

  function setupCopy() {
    document.querySelectorAll(".code__copy").forEach((btn) => {
      const original = btn.textContent;
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(btn.dataset.copy || "");
          showCopied(btn, original);
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
    if (reduceMotion.matches || !("IntersectionObserver" in globalThis)) return showAll();
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

  // Turn boundaries = runs of true silence (six or more zero samples) in the data.
  function findTurns(rms) {
    const turns = [];
    let start = 0;
    let i = 0;
    while (i < rms.length) {
      if (rms[i] === 0) {
        let j = i;
        while (j < rms.length && rms[j] === 0) j++;
        if (j - i >= 6) {
          turns.push([start, i]);
          start = j;
        }
        i = j;
      } else i++;
    }
    if (start < rms.length) turns.push([start, rms.length]);
    return turns;
  }

  function setupHero() {
    const RMS = Array.isArray(data.rms) ? data.rms : [];
    const lines = document.getElementById("lines");
    const canvas = document.getElementById("wave");
    const clock = document.getElementById("clock");
    if (!RMS.length || !lines || !canvas?.getContext) return;
    const ctx = canvas.getContext("2d");
    const HOP = 85;
    const H = 34;
    const BAR = 3;
    const STEP = 5; // 3px bar + 2px gap
    const texts = [data.line1 || "", data.line2 || ""];
    const who = [data.speakerA || "A", data.speakerB || "B"];
    const settleLag = pageLang === "zh" ? 6 : 18; // characters still "unsettled"
    const turns = findTurns(RMS);

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
      while (lines.children.length > 3) lines.firstChild.remove();
      return el;
    }

    // One frame of turn t at sample i: open it when its speech starts, then let
    // the text catch up with the audio, the last few characters still settling.
    let turnEls = [];
    function advanceTurn(t, i) {
      const [a, b] = turns[t];
      if (i === a) {
        turnEls[t] = makeTurn("…"); // speaker not decided yet
        turnEls[t].querySelector(".ts").textContent = fmt(12 + t * 15);
        lines.querySelectorAll(".who").forEach((w) => w.classList.remove("on"));
        turnEls[t].querySelector(".who").classList.add("on");
      }
      const el = turnEls[t];
      if (!el || i < a || i > b + 4) return;
      const text = texts[t] || "";
      const p = Math.min(1, (i - a) / Math.max(1, b - a));
      const n = Math.round(text.length * p);
      const settled = Math.max(0, n - settleLag);
      el.querySelector(".set").textContent = i > b ? text : text.slice(0, settled);
      el.querySelector(".tail").textContent = i > b ? "" : text.slice(settled, n);
      if (i - a === 10) el.querySelector(".nm").textContent = who[t] || ""; // resolves after ~0.85s
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
      turnEls = [];
      const total = RMS.length + 14; // a short pause before it loops
      timer = setInterval(() => {
        if (!visible || document.hidden) return;
        const i = tick % total;
        if (i === 0 && tick > 0) {
          lines.innerHTML = "";
          turnEls = [];
        }
        hist.push(i < RMS.length ? RMS[i] : 0);
        if (hist.length > 400) hist.shift();
        if (tick % 12 === 0 && clock) clock.textContent = fmt(secs++);
        for (const t of turns.keys()) advanceTurn(t, i);
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

    if ("IntersectionObserver" in globalThis) {
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

  /* ---------- Row demos: the AI chat and voice-typing polish ----------
     Each plays once, the first time it is mostly in view. The HTML is the final
     state, so without JS, without IntersectionObserver or with reduced motion the
     visitor simply sees the finished demo. */

  function onceInView(el, play) {
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        play(el);
      },
      { threshold: 0.35 },
    );
    io.observe(el);
  }

  // The answer's direct children: text runs are typed out, timestamp chips pop in whole.
  function blankParts(el) {
    const parts = [...el.childNodes].map((node) => ({
      node,
      text: node.nodeType === Node.TEXT_NODE ? node.textContent : null,
    }));
    showParts(parts, 0);
    return parts;
  }

  function showParts(parts, count) {
    let left = count;
    for (const part of parts) {
      if (part.text === null) {
        part.node.classList?.toggle("is-off", left < 1);
        left -= 1;
      } else {
        part.node.textContent = part.text.slice(0, Math.max(0, left));
        left -= part.text.length;
      }
    }
  }

  function typeParts(parts, duration) {
    const total = parts.reduce((n, part) => n + (part.text === null ? 1 : part.text.length), 0);
    const TICK = 30;
    const step = Math.max(1, Math.ceil(total / (duration / TICK)));
    let shown = 0;
    const timer = setInterval(() => {
      shown = Math.min(total, shown + step);
      showParts(parts, shown);
      if (shown >= total) clearInterval(timer);
    }, TICK);
  }

  function playChat(chat) {
    const answer = chat.querySelector(".chat__a");
    const parts = answer ? blankParts(answer) : [];
    chat.classList.replace("is-pending", "is-play");
    // Question at once, the tool call at 0.35s, the answer typed from 0.7s to 1.5s.
    setTimeout(() => typeParts(parts, 800), 700);
  }

  function playPolish(polish) {
    polish.classList.replace("is-pending", "is-play");
  }

  function setupDemos() {
    if (reduceMotion.matches || !("IntersectionObserver" in globalThis)) return;
    const demos = [
      [document.querySelector(".chat"), playChat],
      [document.querySelector(".polish"), playPolish],
    ];
    for (const [el, play] of demos) {
      if (!el) continue;
      el.classList.add("is-pending");
      onceInView(el, play);
    }
  }

  setupLangBar();
  setupNav();
  setupDownloads(detectOS());
  setupCopy();
  setupFades();
  setupHero();
  setupDemos();
})();
