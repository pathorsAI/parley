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

  /* ---------- In the meeting: live transcript + waveform ----------
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

  /* ---------- Hero figure: where the conversation goes ----------
     The nodes are laid out by CSS; this draws the wires between them, flips the
     mode, and (own keys only) steps through a few real provider hosts so the
     "you choose" part is visible. Without JS the own-keys state stands on its own. */

  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  function curve(a, b, vertical) {
    if (vertical) {
      const my = (a.y + b.y) / 2;
      return `M${a.x},${a.y} C${a.x},${my} ${b.x},${my} ${b.x},${b.y}`;
    }
    const mx = (a.x + b.x) / 2;
    return `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
  }

  function setupRoute() {
    const fig = document.getElementById("route");
    const map = fig?.querySelector(".route__map");
    const svg = fig?.querySelector(".route__wires");
    if (!map || !svg) return;
    const node = (name) => map.querySelector(`[data-node="${name}"]`);
    const els = { dev: node("dev"), parley: node("parley"), stt: node("stt"), ai: node("ai") };
    if (Object.values(els).some((el) => !el)) return;
    const stacked = matchMedia("(max-width: 560px)");

    function box(el) {
      const m = map.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const l = r.left - m.left;
      const t = r.top - m.top;
      return { l, t, r: l + r.width, b: t + r.height, cx: l + r.width / 2, cy: t + r.height / 2 };
    }

    function draw() {
      const D = box(els.dev);
      const P = box(els.parley);
      const S = box(els.stt);
      const A = box(els.ai);
      // Narrow screens stack the nodes (see the 560px rule in styles.css): wires run downwards.
      const vertical = stacked.matches;
      const into = (B) => (vertical ? { x: B.cx, y: B.t } : { x: B.l, y: B.cy });
      const outOf = (B) => (vertical ? { x: B.cx, y: B.b } : { x: B.r, y: B.cy });
      const from = outOf(D);
      // Cloud edition: the recording goes to Parley, and that is the whole story.
      const legs =
        fig.dataset.mode === "cloud" ? [[from, into(P)]] : [[from, into(S)], [from, into(A)]];
      const nodes = [];
      for (const [a, b] of legs) {
        const d = curve(a, b, vertical);
        nodes.push(svgEl("path", { class: "w", d }), svgEl("path", { class: "f", d }));
      }
      const ends = new Map(legs.flat().map((p) => [`${p.x},${p.y}`, p]));
      for (const p of ends.values()) nodes.push(svgEl("circle", { cx: p.x, cy: p.y, r: 3 }));
      svg.replaceChildren(...nodes);
    }

    // The Parley node slides while the mode changes; keep the wires on it.
    let follow = 0;
    function track(ms) {
      cancelAnimationFrame(follow);
      const until = performance.now() + ms;
      const step = () => {
        draw();
        if (performance.now() < until) follow = requestAnimationFrame(step);
      };
      step();
    }

    const buttons = [...fig.querySelectorAll(".seg button")];
    buttons.forEach((btn) =>
      btn.addEventListener("click", () => {
        if (fig.dataset.mode === btn.dataset.mode) return;
        buttons.forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
        fig.dataset.mode = btn.dataset.mode;
        track(reduceMotion.matches ? 0 : 650);
      }),
    );

    if ("ResizeObserver" in globalThis) new ResizeObserver(() => draw()).observe(map);
    else addEventListener("resize", draw);
    stacked.addEventListener?.("change", draw);
    document.fonts?.ready.then(draw);
    draw();

    // Own keys: step through real hosts, one node at a time.
    const cycles = [...fig.querySelectorAll("[data-cycle]")].map((el) => {
      let hosts = [];
      try {
        hosts = JSON.parse(el.dataset.cycle);
      } catch {
        hosts = [];
      }
      return { el, hosts, i: 0, note: el.closest(".rt-node")?.querySelector(".rt-note[data-local-note]") };
    });
    if (reduceMotion.matches || !cycles.length) return;
    let inView = true;
    let hovering = false;
    if ("IntersectionObserver" in globalThis) {
      new IntersectionObserver((entries) => {
        inView = entries.some((e) => e.isIntersecting);
      }).observe(fig);
    }
    fig.addEventListener("pointerenter", () => { hovering = true; });
    fig.addEventListener("pointerleave", () => { hovering = false; });
    let turn = 0;
    setInterval(() => {
      if (!inView || hovering || document.hidden || fig.dataset.mode !== "byok") return;
      const c = cycles[turn++ % cycles.length];
      if (c.hosts.length < 2) return;
      c.i = (c.i + 1) % c.hosts.length;
      const host = c.hosts[c.i];
      c.el.classList.add("is-swap");
      setTimeout(() => {
        c.el.textContent = host;
        if (c.note?.dataset.localNote) {
          c.note.textContent = host === c.el.dataset.local ? c.note.dataset.localNote : c.note.dataset.direct;
        }
        c.el.classList.remove("is-swap");
        draw();
      }, 200);
    }, 2600);
  }

  /* ---------- Models: each setting steps through real providers ----------
     One row at a time, so the eye can follow it. The HTML is the first entry of
     each list, which is also what reduced motion and no-JS visitors see. */

  function setupPrefs() {
    const panel = document.querySelector(".prefs");
    if (!panel || reduceMotion.matches) return;
    const rows = [...panel.querySelectorAll(".prefs__v[data-cycle]")].map((el) => {
      let items = [];
      try {
        items = JSON.parse(el.dataset.cycle);
      } catch {
        items = [];
      }
      return { el, items, i: 0, logo: el.querySelector(".logo"), name: el.querySelector(".prefs__n"), tag: el.querySelector("em") };
    });
    if (!rows.length) return;
    let inView = false;
    if ("IntersectionObserver" in globalThis) {
      new IntersectionObserver((entries) => {
        inView = entries.some((e) => e.isIntersecting);
      }).observe(panel);
    } else inView = true;
    let turn = 0;
    setInterval(() => {
      if (!inView || document.hidden) return;
      const row = rows[turn++ % rows.length];
      if (row.items.length < 2) return;
      row.i = (row.i + 1) % row.items.length;
      const next = row.items[row.i];
      row.el.classList.add("is-swap");
      setTimeout(() => {
        if (row.name) row.name.textContent = next.n;
        if (row.logo) {
          row.logo.style.setProperty("--m", next.l ? `url('${next.l}')` : "none");
          row.logo.hidden = !next.l;
        }
        if (row.tag) row.tag.hidden = !next.t;
        row.el.classList.remove("is-swap");
      }, 200);
    }, 1800);
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

  setupNav();
  setupDownloads(detectOS());
  setupCopy();
  setupFades();
  setupRoute();
  setupPrefs();
  setupHero();
  setupDemos();
})();
