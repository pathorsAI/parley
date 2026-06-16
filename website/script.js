// Parley website — light progressive enhancement, no dependencies.

// Sticky nav state on scroll
const nav = document.getElementById("nav");
const onScroll = () => nav.classList.toggle("is-scrolled", window.scrollY > 8);
onScroll();
window.addEventListener("scroll", onScroll, { passive: true });

// Mobile menu
const burger = document.getElementById("burger");
burger?.addEventListener("click", () => {
  const open = nav.classList.toggle("is-open");
  burger.setAttribute("aria-expanded", String(open));
});
nav.querySelectorAll(".nav__links a").forEach((a) =>
  a.addEventListener("click", () => {
    nav.classList.remove("is-open");
    burger?.setAttribute("aria-expanded", "false");
  })
);

// Scroll reveal
const reveals = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
  );
  reveals.forEach((el) => io.observe(el));
} else {
  reveals.forEach((el) => el.classList.add("is-in"));
}

// Copy-to-clipboard for the install snippet
document.querySelectorAll(".copy").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const text = (btn.dataset.copy || "").replace(/&#10;/g, "\n");
    try {
      await navigator.clipboard.writeText(text);
      const original = btn.textContent;
      btn.textContent = "Copied";
      btn.classList.add("is-done");
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("is-done");
      }, 1600);
    } catch {
      /* clipboard unavailable — no-op */
    }
  });
});

/**
 * Auto-swap a media slot if a matching asset exists.
 * Drop a file at website/assets/<name>.{gif,png,jpg,webp,mp4} and it appears
 * automatically — no markup edits needed. Falls back to the placeholder hint.
 */
function hydrateMedia() {
  const slots = document.querySelectorAll("[data-media]");
  const exts = ["gif", "webp", "png", "jpg", "jpeg", "mp4"];
  slots.forEach((slot) => {
    const name = slot.dataset.media;
    // The hero slot lives inside .window; the figure itself may be the slot.
    const target = slot.classList.contains("media-slot")
      ? slot
      : slot.querySelector(".media-slot");
    if (!target) return;
    tryNext(target, name, exts, 0);
  });
}

function tryNext(target, name, exts, i) {
  if (i >= exts.length) return; // keep the placeholder
  const ext = exts[i];
  const url = `assets/${name}.${ext}`;
  if (ext === "mp4") {
    fetch(url, { method: "HEAD" })
      .then((r) => {
        if (r.ok) mountVideo(target, url);
        else tryNext(target, name, exts, i + 1);
      })
      .catch(() => tryNext(target, name, exts, i + 1));
    return;
  }
  const img = new Image();
  img.onload = () => mountImage(target, url, name);
  img.onerror = () => tryNext(target, name, exts, i + 1);
  img.src = url;
}

function mountImage(target, url, name) {
  const img = document.createElement("img");
  img.src = url;
  img.alt = `Parley — ${name.replace(/showcase-?/, "").replace(/-/g, " ")}`.trim();
  img.loading = "lazy";
  target.replaceChildren(img);
  target.style.border = "0";
}

function mountVideo(target, url) {
  const v = document.createElement("video");
  v.src = url;
  v.autoplay = true;
  v.loop = true;
  v.muted = true;
  v.playsInline = true;
  target.replaceChildren(v);
  target.style.border = "0";
}

hydrateMedia();
