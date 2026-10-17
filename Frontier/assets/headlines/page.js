/* page.js — the page behind every HEADLINES DLC scene.

   A real article, photographed around its headline, shown as a browser window in dark
   space: it rises in tilted, the camera pushes in on the headline, a yellow marker
   sweeps across it line by line, the rest of the page sinks back, and the source is
   credited in the corner.

   The window (browser bar + the page) is ONE picture, so moving and scaling it never
   re-rasterises type — the crawl that makes live DOM text shimmer when it drifts. The
   only live text is the source credit, and that never moves.

   Same contract as every Frontier scene: window.renderFrame(t) draws frame t from t
   alone. Globals set by headlines.py: SCENE, PAL, W, H.
*/
"use strict";

const cl = (x, a, b) => Math.max(a, Math.min(b, x));
const seg = (t, s, d) => cl((t - s) / Math.max(1e-4, d), 0, 1);
const lerp = (a, b, p) => a + (b - a) * p;
const eOut = p => 1 - Math.pow(1 - p, 3);
const eInOut = p => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
const eSine = p => -(Math.cos(Math.PI * p) - 1) / 2;
const $ = id => document.getElementById(id);
const D = SCENE.duration || 6.5;
/* three ways onto the page, so two headlines in one video never move the same way:
   "window" — a browser window rises in tilted and the camera pushes in on the headline;
   "paper"  — the article printed on paper slides onto a dark desk, the camera glides along the
              headline and a red pen underlines it;
   "scan"   — the page lies flat and still, a bright scan line runs down to the headline, then the
              camera moves straight in and the marker sweeps it. */
const V = ["window", "paper", "scan"].includes(SCENE.variant) ? SCENE.variant : "window";
const HIT = cl(SCENE.hit == null ? 1.3 : SCENE.hit, 0.6, Math.max(0.6, D - 2.6));

/* ── geometry: image pixels -> the window's own CSS pixels ─────────────── */
const BASE_W = 1480;
const K = BASE_W / SCENE.img_w, WIN_H = SCENE.img_h * K;
const LINES = (SCENE.lines || []).map(l => ({ x: l.x * K, y: l.y * K, w: l.w * K, h: l.h * K }));
const BOX = LINES.length
  ? LINES.reduce((b, l) => ({ x0: Math.min(b.x0, l.x), y0: Math.min(b.y0, l.y), x1: Math.max(b.x1, l.x + l.w), y1: Math.max(b.y1, l.y + l.h) }),
                 { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 })
  : { x0: BASE_W * 0.2, y0: WIN_H * 0.3, x1: BASE_W * 0.8, y1: WIN_H * 0.4 };
const OX = (BOX.x0 + BOX.x1) / 2, OY = (BOX.y0 + BOX.y1) / 2;      /* the camera looks at the headline */
const BW = BOX.x1 - BOX.x0, BH = BOX.y1 - BOX.y0;

const win = $("win"), shot = $("shot"), dof = $("dof"), dim = $("dim"), sheen = $("sheen"), bg = $("bg");
const ghostR = $("ghostR"), ghostC = $("ghostC");
win.style.width = BASE_W + "px"; win.style.height = WIN_H + "px";
win.style.transformOrigin = `${OX}px ${OY}px`;
if (V === "paper") {
  win.style.borderRadius = "3px";
  win.style.boxShadow = "0 40px 90px rgba(0,0,0,.6), 0 4px 10px rgba(0,0,0,.35)";
  $("stage").style.background = "radial-gradient(ellipse at 45% 40%, #3a2e24 0%, #1f1813 60%, #0e0b09 100%)";
  bg.style.display = "none";
  shot.style.filter = dof.style.filter = "sepia(.28) saturate(.85) contrast(1.04) brightness(.97)";   /* ink on paper, not a screen */
  dof.style.filter += " blur(7px)";
}
if (V === "scan") {
  win.style.borderRadius = "6px";
}
for (const im of [shot, dof, bg, ghostR, ghostC]) im.src = SCENE.image;
/* Depth of field: a blurred copy of the page with a hole where the headline is. The blur
   and the mask never change, so Chromium rasterises them once; only its opacity moves. */
const mx = (OX / BASE_W * 100).toFixed(2), my = (OY / WIN_H * 100).toFixed(2);
const holeW = Math.max(BW * 0.75, 420), holeH = Math.max(BH * 1.6, 260);
dof.style.maskImage = dof.style.webkitMaskImage =
  `radial-gradient(${holeW}px ${holeH}px at ${mx}% ${my}%, transparent 55%, #000 100%)`;

/* the marker: one bar per line of the headline, under the ink (multiply) */
const bars = LINES.map((l, i) => {
  const b = document.createElement("div");
  b.className = "bar";
  const padX = Math.max(8, l.h * 0.14), top = l.y + l.h * 0.10, h = l.h * 0.84;
  Object.assign(b.style, { left: (l.x - padX) + "px", top: top + "px", width: (l.w + padX * 2) + "px", height: h + "px",
                           background: PAL.marker, transform: "scaleX(0)", borderRadius: (h * 0.18) + "px" });
  if (V === "paper") {
    /* a red pen line under the words instead of a highlighter */
    Object.assign(b.style, { top: (l.y + l.h * 0.86) + "px", height: Math.max(5, l.h * 0.1) + "px", background: "#C8321F",
                             mixBlendMode: "multiply", borderRadius: "6px", opacity: "0.92" });
  }
  if (SCENE.dark) {
    /* light type on a dark page: the bar lights the dark behind the letters instead of
       multiplying into them, and a solid stroke underlines the line */
    b.style.mixBlendMode = "screen";
    b.style.opacity = "0.62";
    const u = document.createElement("div");
    u.className = "bar";
    Object.assign(u.style, { left: (l.x - padX) + "px", top: (l.y + l.h * 0.9) + "px", width: (l.w + padX * 2) + "px",
                             height: Math.max(4, l.h * 0.09) + "px", background: PAL.marker, mixBlendMode: "normal",
                             transform: "scaleX(0)", borderRadius: "3px" });
    b.under = u;
    win.appendChild(u);
  }
  win.appendChild(b);
  return b;
});
win.appendChild(dof); win.appendChild(dim); win.appendChild(sheen);   /* above the marker, inside the window */
const pad = 26;
Object.assign(dim.style, { left: (BOX.x0 - pad) + "px", top: (BOX.y0 - pad * 0.8) + "px",
                           width: (BW + pad * 2) + "px", height: (BH + pad * 1.6) + "px" });

/* ── camera ────────────────────────────────────────────────────────────── */
/* the close-up: the headline about two thirds of the frame, the window's edge still in the
   shot so it reads as a page lying in space, not a screen recording */
const s1 = cl(Math.min(W * 0.64 / BW, H * 0.40 / BH), 0.9, 2.6);
const s0 = Math.min(W * 0.74 / BASE_W, H * 0.9 / Math.min(WIN_H, 1150));          /* the whole window */
/* where the headline sits on screen: first where it falls in a centred window, then centre stage */
const P0 = [W / 2 + (OX - BASE_W / 2) * s0, H * 0.52 + (OY - Math.min(WIN_H, 1150) * 0.46) * s0];
const P1 = [W / 2, H * 0.47];
const nLines = Math.max(1, LINES.length);
const SWEEP = 0.42, STAGGER = 0.3;
const MARK_END = HIT + (nLines - 1) * STAGGER + SWEEP;

/* ── film grain, drawn once and shaken per frame ───────────────────────── */
let _s = (SCENE.seed || 7) >>> 0;
const rnd = () => { _s = (_s * 1664525 + 1013904223) % 4294967296; return _s / 4294967296; };
(() => {
  const c = $("grain"), g = c.getContext("2d");
  c.width = 512; c.height = 512;
  const im = g.createImageData(512, 512);
  for (let i = 0; i < im.data.length; i += 4) { const v = rnd() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
  g.putImageData(im, 0, 0);
})();

const scanBar = document.createElement("div");
Object.assign(scanBar.style, { position: "absolute", left: "0", width: "100%", height: "140px", pointerEvents: "none",
  background: "linear-gradient(180deg, transparent, rgba(255,255,255,.0) 30%, rgba(255,246,200,.55) 50%, rgba(255,255,255,.0) 70%, transparent)",
  mixBlendMode: "screen", display: "none" });
win.appendChild(scanBar);

function frameAlt(t) {
  const fin = cl(t / 0.3, 0, 1), fout = cl((D - t) / 0.4, 0, 1);
  $("stage").style.opacity = Math.min(fin, fout).toFixed(3);
  let tf;
  if (V === "paper") {
    /* slides in from the lower right, turning flat; the camera glides along the headline */
    const slide = eOut(seg(t, 0.0, 0.9));
    const u = eInOut(seg(t, 0.5, Math.max(0.6, HIT - 0.2)));
    const s = s0 * Math.pow(s1 * 0.92 / s0, u) * (1 + 0.03 * eSine(seg(t, HIT, D - HIT)));
    const glide = lerp(BW * 0.18, -BW * 0.18, eInOut(seg(t, HIT - 0.3, D - HIT)));
    const px = lerp(P0[0] + 420, P1[0], u) + (1 - slide) * 520 + glide * s * 0.35;
    const py = lerp(P0[1] + 160, P1[1], u) + (1 - slide) * 360;
    const rz = lerp(-7, -3.2, u) + (1 - slide) * -6;
    tf = `translate(${(px - OX).toFixed(2)}px, ${(py - OY).toFixed(2)}px) perspective(2600px) rotateX(${lerp(24, 15, u).toFixed(3)}deg) ` +
         `rotateZ(${rz.toFixed(3)}deg) scale(${s.toFixed(4)})`;
    win.style.opacity = slide.toFixed(3);
    win.style.filter = "none";
    dof.style.opacity = (0.8 * eInOut(seg(t, HIT - 0.4, 0.9))).toFixed(3);
  } else {
    /* scan: flat and square to the camera; a scan line finds the headline, then a straight push in */
    const appear = eOut(seg(t, 0.0, 0.5));
    const u = eInOut(seg(t, HIT - 0.15, 1.0));
    const s = s0 * 0.96 * Math.pow(s1 / (s0 * 0.96), u) * (1 + 0.015 * eSine(seg(t, HIT + 0.9, D - HIT)));
    const px = lerp(W / 2 + (OX - BASE_W / 2) * s0 * 0.96, P1[0], u), py = lerp(H * 0.5 + (OY - Math.min(WIN_H, 1150) * 0.5) * s0 * 0.96, P1[1], u);
    tf = `translate(${(px - OX).toFixed(2)}px, ${(py - OY).toFixed(2)}px) scale(${s.toFixed(4)})`;
    win.style.opacity = appear.toFixed(3);
    win.style.filter = "none";
    const sc = seg(t, 0.25, Math.max(0.5, HIT - 0.4));
    scanBar.style.display = sc > 0 && sc < 1 ? "block" : "none";
    scanBar.style.top = (lerp(-140, OY - 70, eInOut(sc))).toFixed(1) + "px";
    dof.style.opacity = (0.95 * eInOut(seg(t, HIT + 0.2, 0.8))).toFixed(3);
  }
  win.style.transform = tf;
  for (const el of [ghostR, ghostC]) el.style.display = "none";
  const markAt = V === "scan" ? HIT + 0.9 : HIT;
  bars.forEach((b, i) => {
    const btf = `scaleX(${eOut(seg(t, markAt + i * STAGGER, V === "paper" ? SWEEP * 1.4 : SWEEP)).toFixed(4)})`;
    b.style.transform = btf;
    if (b.under) b.under.style.transform = btf;
  });
  const end = markAt + (nLines - 1) * STAGGER + SWEEP;
  dim.style.boxShadow = `0 0 0 6000px rgba(${PAL.dim}, ${((V === "paper" ? 0.25 : 0.42) * eOut(seg(t, end + 0.1, 0.7))).toFixed(3)})`;
  sheen.style.opacity = "0";
  bg.style.transform = `scale(${(1.18 + 0.06 * t / D).toFixed(4)})`;
  const f = Math.floor(t * 30);
  $("grain").style.transform = `translate(${-((f * 173) % 256)}px, ${-((f * 97) % 256)}px)`;
  $("credit").style.opacity = eOut(seg(t, end + 0.2, 0.6)).toFixed(3);
}

window.renderFrame = t => {
  if (V !== "window") { frameAlt(t); return; }
  const fin = cl(t / 0.3, 0, 1), fout = cl((D - t) / 0.4, 0, 1);
  $("stage").style.opacity = Math.min(fin, fout).toFixed(3);

  /* the window rises in, then the camera pushes in on the headline */
  const rise = eOut(seg(t, 0.0, 0.75));
  const u = eInOut(seg(t, 0.35, Math.max(0.6, HIT + 0.15 - 0.35)));
  let s = s0 * Math.pow(s1 / s0, u);
  s *= 1 + 0.022 * eSine(seg(t, HIT, D - HIT));                              /* never quite still */
  s *= 1 + 0.018 * Math.sin(Math.PI * seg(t, MARK_END - 0.05, 0.4));        /* a small punch as the marker lands */
  const px = lerp(P0[0], P1[0], u), py = lerp(P0[1], P1[1], u) + (1 - rise) * 190;
  const rx = lerp(12, 4.5, u) + (1 - rise) * 6, ry = lerp(-18, -7.5, u) + 2.2 * eSine(seg(t, HIT, D - HIT));
  const tf = `translate(${(px - OX).toFixed(2)}px, ${(py - OY).toFixed(2)}px) perspective(2200px) ` +
             `rotateX(${rx.toFixed(3)}deg) rotateY(${ry.toFixed(3)}deg) scale(${s.toFixed(4)})`;
  win.style.transform = tf;
  win.style.opacity = rise.toFixed(3);
  win.style.filter = rise < 1 ? `blur(${((1 - rise) * 10).toFixed(2)}px)` : "none";
  dof.style.opacity = (0.95 * eInOut(seg(t, HIT - 0.5, 0.9))).toFixed(3);

  /* the landing: for a few frames the picture splits into red and cyan and snaps back */
  const g = seg(t, 0.62, 0.22), glitch = g > 0 && g < 1 ? Math.sin(Math.PI * g) : 0;
  for (const [el, dir] of [[ghostR, 1], [ghostC, -1]]) {
    el.style.display = glitch ? "block" : "none";
    if (glitch) {
      el.style.transformOrigin = win.style.transformOrigin;
      el.style.width = win.style.width; el.style.height = win.style.height;
      el.style.transform = `translate(${dir * 14 * glitch}px, ${-dir * 3 * glitch}px) ` + tf;
      el.style.opacity = (0.55 * glitch).toFixed(3);
    }
  }

  bars.forEach((b, i) => {
    const tf = `scaleX(${eOut(seg(t, HIT + i * STAGGER, SWEEP)).toFixed(4)})`;
    b.style.transform = tf;
    if (b.under) b.under.style.transform = tf;
  });
  dim.style.boxShadow = `0 0 0 6000px rgba(${PAL.dim}, ${(0.42 * eOut(seg(t, MARK_END + 0.1, 0.7))).toFixed(3)})`;
  const sw = seg(t, 0.45, 1.15);
  sheen.style.opacity = sw > 0 && sw < 1 ? "1" : "0";
  sheen.style.transform = `translateX(${lerp(-60, 160, eInOut(sw)).toFixed(2)}%)`;

  bg.style.transform = `scale(${(1.18 + 0.06 * t / D).toFixed(4)})`;
  const f = Math.floor(t * 30);
  $("grain").style.transform = `translate(${-((f * 173) % 256)}px, ${-((f * 97) % 256)}px)`;
  $("credit").style.opacity = eOut(seg(t, MARK_END + 0.2, 0.6)).toFixed(3);
};

async function boot() {
  try { await document.fonts.ready; } catch (e) { /* fallback face */ }
  await Promise.all([shot, bg].map(im => im.decode ? im.decode().catch(() => null) : null));
  if (SCENE.credit) $("credit").textContent = SCENE.credit;
  window.renderFrame(0);
  window.__ready = true;
}
boot();
