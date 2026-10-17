/* map.js — the page behind every MAPS DLC scene.

   One scene is one camera move over real geography (Natural Earth borders), drawn
   on canvas through an orthographic projection. That one projection covers the
   whole range: at a small scale it IS the globe, at a large one a state fills the
   frame, so a single continuous move can go from the planet to a county line.

   Same contract as every Frontier scene: window.renderFrame(t) draws frame t from
   t alone — no timers, no CSS animation, no Math.random (rnd() is seeded).

   Globals set by maps.py before this file: SCENE, PAL, W, H.

   Shots: region (a country, state, sea or desert lights up and lifts off the map),
   pin (a city: the pin drops, rings ripple out), route (a line draws from place to
   place with a plane or a ship on its head), multi (several places, one by one).
*/
"use strict";

/* ── deterministic helpers ─────────────────────────────────────────────── */
const cl = (x, a, b) => Math.max(a, Math.min(b, x));
const seg = (t, s, d) => cl((t - s) / Math.max(1e-4, d), 0, 1);
const lerp = (a, b, p) => a + (b - a) * p;
const eOut = p => 1 - Math.pow(1 - p, 3);
const eIn = p => p * p * p;
const eInOut = p => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
const eSine = p => -(Math.cos(Math.PI * p) - 1) / 2;
const eBack = p => { const c = 1.45; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };
const eBounce = p => {                                   /* a pin landing */
  const n = 7.5625, d = 2.75;
  if (p < 1 / d) return n * p * p;
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375;
  return n * (p -= 2.625 / d) * p + 0.984375;
};
let _s = (SCENE.seed || 7) >>> 0;
const rnd = () => { _s = (_s * 1664525 + 1013904223) % 4294967296; return _s / 4294967296; };
const R_KM = 6371.0088;
const D = SCENE.duration || 7;
const HIT = cl(SCENE.hit == null ? 1.4 : SCENE.hit, 0.5, Math.max(0.5, D - 3.0));
const upper = s => String(s || "").toLocaleUpperCase(SCENE.lang || undefined);

/* ── data: three levels of detail, decoded once ───────────────────────── */
function feats(topo, name) {
  return topo && topo.objects && topo.objects[name] ? topojson.feature(topo, topo.objects[name]).features : [];
}
const LAND = new Set(SCENE.land || []);          // countries drawn at full strength
const A1OF = new Set(SCENE.admin1_of || []);     // countries whose state lines are drawn
const LV = {};
for (const name of ["lo", "mid", "hi"]) {
  const topo = SCENE.geo[name];
  const countries = feats(topo, "countries"), admin1 = feats(topo, "admin1");
  const byId = new Map();
  for (const f of countries.concat(admin1)) byId.set(f.id, f);
  const obj = topo && topo.objects;
  const prefixOf = id => String(id).split("-")[0];
  /* A group (Scotland, the Soviet Union) is its members merged into one outline, so
     the borders between them disappear — they read as the one place the voice named. */
  for (const [cid, spec] of Object.entries(SCENE.composites || {})) {
    const o = obj && obj[spec.obj];
    if (!o) continue;
    const want = new Set(spec.ids), geoms = o.geometries.filter(g => want.has(g.id));
    if (geoms.length) byId.set(cid, { type: "Feature", id: cid, geometry: topojson.merge(topo, geoms) });
  }
  LV[name] = {
    topo, byId, countries,
    /* state lines only inside the countries that asked for them, each drawn once */
    a1mesh: obj && obj.admin1 ? topojson.mesh(topo, obj.admin1,
      (a, b) => a !== b && A1OF.has(prefixOf(a.id)) && A1OF.has(prefixOf(b.id))) : null,
  };
}
/* A close view only carries detail for what is near the place; anything further out
   comes from the next level down, so the edges of a close-up are never empty. */
for (const [fine, coarse] of [["mid", "lo"], ["hi", "mid"]]) {
  const have = new Set(LV[fine].countries.map(f => f.id));
  LV[fine].all = LV[fine].countries.concat((LV[coarse].all || LV[coarse].countries).filter(f => !have.has(f.id)));
}
LV.lo.all = LV.lo.countries;
for (const name of ["lo", "mid", "hi"]) {
  LV[name].land = LV[name].all.filter(f => LAND.has(f.id));
  LV[name].others = LV[name].all.filter(f => !LAND.has(f.id));
}
/* seas, deserts, mountain ranges: one level of detail each */
const EXTRA = new Map();
for (const [key, obj] of [["water", "water"], ["regions", "regions"]]) {
  const topo = SCENE.geo[key];
  for (const f of feats(topo, obj)) EXTRA.set(f.id, f);
  for (const [cid, spec] of Object.entries(SCENE.composites || {})) {
    if (spec.obj !== obj || !topo) continue;
    const want = new Set(spec.ids), geoms = topo.objects[obj].geometries.filter(g => want.has(g.id));
    if (geoms.length) EXTRA.set(cid, { type: "Feature", id: cid, geometry: topojson.merge(topo, geoms) });
  }
}
function lodFor(k) {
  const pxkm = k / R_KM;
  if (pxkm > 0.24 && LV.hi.topo) return LV.hi;
  if ((pxkm > 0.055 || !LV.lo.topo) && LV.mid.topo) return LV.mid;
  return LV.lo.topo ? LV.lo : LV.hi;
}
function feature(id, k) {
  /* the most detailed copy the current zoom deserves, falling back to any copy */
  return lodFor(k).byId.get(id) || LV.hi.byId.get(id) || LV.mid.byId.get(id) || LV.lo.byId.get(id) || EXTRA.get(id) || null;
}

/* ── projection: orthographic globe + a gentle table-top tilt ─────────── */
const ortho = d3.geoOrthographic().clipAngle(90).precision(0.55);
let TILT = 0;
const TCX = W * 0.5, TCY = H * 0.54, PERSP = 2400;
function tiltXY(x, y) {
  if (!TILT) return [x, y];
  const a = TILT * Math.PI / 180, dy = y - TCY;
  const s = PERSP / (PERSP - dy * Math.sin(a));
  return [TCX + (x - TCX) * s, TCY + dy * Math.cos(a) * s];
}
/* d3.geoPath takes anything with a stream(): project, clip, then tilt the plane.
   A tilt is a projective map, so the straight segments between points stay straight. */
const tproj = {
  stream: s => ortho.stream({
    point(x, y) { const p = tiltXY(x, y); s.point(p[0], p[1]); },
    sphere() { s.sphere(); }, lineStart() { s.lineStart(); }, lineEnd() { s.lineEnd(); },
    polygonStart() { s.polygonStart(); }, polygonEnd() { s.polygonEnd(); },
  }),
};
function screen(lonlat) {
  const r = ortho.rotate(), c = [-r[0], -r[1]];
  if (d3.geoDistance(c, lonlat) > Math.PI / 2 - 0.01) return null;     // far side of the globe
  const p = ortho(lonlat);
  return p ? tiltXY(p[0], p[1]) : null;
}
function applyCam(c) {
  ortho.rotate([-c.lon, -c.lat, 0]).scale(c.k).translate([c.x, c.y]);
  TILT = c.tilt || 0;
}

/* ── framing ───────────────────────────────────────────────────────────── */
function boxCenter(b) {
  let [w, s, e, n] = b;
  if (e < w) e += 360;
  let lon = (w + e) / 2;
  if (lon > 180) lon -= 360;
  return [lon, (s + n) / 2];
}
function boxGeom(b) {
  let [w, s, e, n] = b;
  if (e < w) e += 360;
  const pts = [];
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) pts.push([w + (e - w) * i / 8, s + (n - s) * j / 8]);
  return { type: "MultiPoint", coordinates: pts };
}
const GLOBE_K = H * 0.40;
/* the camera that puts `box` (lon/lat) inside the screen rectangle `r` [x0,y0,x1,y1] */
function fit(box, r, centre) {
  const c = centre || boxCenter(box);
  const p = d3.geoOrthographic().clipAngle(90).rotate([-c[0], -c[1]]).scale(1).translate([0, 0]).precision(0);
  const b = d3.geoPath(p).bounds(boxGeom(box));
  const bw = Math.max(1e-5, b[1][0] - b[0][0]), bh = Math.max(1e-5, b[1][1] - b[0][1]);
  const k = Math.max(GLOBE_K, Math.min((r[2] - r[0]) / bw, (r[3] - r[1]) / bh));
  const mx = (b[0][0] + b[1][0]) / 2, my = (b[0][1] + b[1][1]) / 2;
  return { lon: c[0], lat: c[1], k, x: (r[0] + r[2]) / 2 - mx * k, y: (r[1] + r[3]) / 2 - my * k, bw: bw * k, bh: bh * k };
}
/* the same camera, moved so that lon/lat `p` lands on screen point [sx, sy] */
function aimAt(cam, p, sx, sy) {
  applyCam({ ...cam, tilt: 0 });
  const q = ortho(p);
  return { ...cam, x: cam.x + (sx - q[0]), y: cam.y + (sy - q[1]) };
}

/* Van Wijk & Nielsen's smooth zoom-and-pan, on the sphere: the path pulls out while
   it travels and pushes in as it arrives, the way a camera operator flies it. */
function fly(a, b) {
  const c0 = [a.lon, a.lat], c1 = [b.lon, b.lat];
  const d = d3.geoDistance(c0, c1), gi = d3.geoInterpolate(c0, c1);
  const w0 = W / a.k, w1 = W / b.k, rho = 1.25, rho2 = rho * rho, rho4 = rho2 * rho2;
  let at;
  if (d < 1e-6) {
    const S = Math.log(w1 / w0) / rho;
    at = t => ({ u: t, w: w0 * Math.exp(rho * t * S) });
  } else {
    const b0 = (w1 * w1 - w0 * w0 + rho4 * d * d) / (2 * w0 * rho2 * d);
    const b1 = (w1 * w1 - w0 * w0 - rho4 * d * d) / (2 * w1 * rho2 * d);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    const S = (r1 - r0) / rho;
    at = t => {
      const s = t * S, u = w0 / (rho2 * d) * (Math.cosh(r0) * Math.tanh(rho * s + r0) - Math.sinh(r0));
      return { u, w: w0 * Math.cosh(r0) / Math.cosh(rho * s + r0) };
    };
  }
  return t => {
    const v = at(t), u = cl(v.u, 0, 1), c = gi(u);
    return { lon: c[0], lat: c[1], k: Math.max(GLOBE_K, W / v.w), x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u),
             tilt: lerp(a.tilt || 0, b.tilt || 0, t) };
  };
}
const zoomAbout = (c, f) => ({ ...c, k: c.k * f });

/* ── canvases and textures ─────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const base = $("base"), lift = $("lift"), fx = $("fx");
for (const c of [base, lift, fx, $("ground")]) { c.width = W; c.height = H; }
const bctx = base.getContext("2d"), lctx = lift.getContext("2d"), fctx = fx.getContext("2d");
const bpath = d3.geoPath(tproj, bctx), lpath = d3.geoPath(tproj, lctx);

function noiseCanvas(size, alpha, grain) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d"), im = g.createImageData(size, size);
  for (let i = 0; i < im.data.length; i += 4) {
    const v = Math.floor(rnd() * 255);
    im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = Math.floor(alpha * 255 * (grain ? rnd() : 1));
  }
  g.putImageData(im, 0, 0);
  return c;
}
/* The texture on the highlighted shape. A crisp 6 px checker looked like dither and
   would swim under h264 while the shape floats, so this is soft grain with a faint
   diagonal weave: it reads as material without a pattern to alias. */
function weaveCanvas() {
  const S = 96, c = document.createElement("canvas"); c.width = c.height = S;
  const g = c.getContext("2d"), im = g.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const weave = ((x + y) % 8 < 4 ? 1 : -1) * 0.5 + ((x - y + 64) % 8 < 4 ? 1 : -1) * 0.5;
    const v = 128 + weave * 18 + (rnd() - 0.5) * 70;
    im.data[i] = im.data[i + 1] = im.data[i + 2] = cl(v, 0, 255);
    im.data[i + 3] = 34;
  }
  g.putImageData(im, 0, 0);
  return c;
}
const KIND = PAL.kind || "glow";                 /* glow: dark and lit · paper: an old atlas · flat: a clean infographic */
const WEAVE = bctx.createPattern(weaveCanvas(), "repeat");
const GRAIN = bctx.createPattern(noiseCanvas(256, KIND === "paper" ? 0.16 : 0.10, true), "repeat");

/* smooth value noise, for paper stains: a few random cells, scaled up soft */
function blotches(cells, alpha, tint) {
  const c = document.createElement("canvas"); c.width = cells; c.height = Math.ceil(cells * H / W);
  const g = c.getContext("2d"), im = g.createImageData(c.width, c.height);
  for (let i = 0; i < im.data.length; i += 4) {
    im.data[i] = tint[0]; im.data[i + 1] = tint[1]; im.data[i + 2] = tint[2];
    im.data[i + 3] = Math.floor(Math.pow(rnd(), 2.2) * alpha * 255);
  }
  g.putImageData(im, 0, 0);
  return c;
}
function paintGround() {
  const g = $("ground").getContext("2d");
  const rg = g.createRadialGradient(W * 0.46, H * 0.42, 0, W * 0.5, H * 0.5, W * 0.75);
  rg.addColorStop(0, PAL.bg2); rg.addColorStop(1, PAL.bg);
  g.fillStyle = rg; g.fillRect(0, 0, W, H);
  if (KIND === "paper") {
    /* an old sheet: soft stains at three scales, fibres, a burnt edge */
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    for (const [cells, a] of [[9, 0.20], [26, 0.14], [80, 0.08]]) g.drawImage(blotches(cells, a, [120, 84, 40]), 0, 0, W, H);
    g.globalAlpha = 0.55; g.fillStyle = g.createPattern(noiseCanvas(256, 0.10, true), "repeat"); g.fillRect(0, 0, W, H);
    g.globalAlpha = 1;
    const v = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.72);
    v.addColorStop(0, "rgba(90,55,20,0)"); v.addColorStop(1, "rgba(90,55,20,0.42)");
    g.fillStyle = v; g.fillRect(0, 0, W, H);
    return;
  }
  g.globalAlpha = KIND === "flat" ? 0.18 : 0.5;
  g.fillStyle = g.createPattern(noiseCanvas(256, 0.06, false), "repeat"); g.fillRect(0, 0, W, H);
  g.globalAlpha = 1;
}

/* ── layers ────────────────────────────────────────────────────────────── */
/* a feature's size in radians (square root of its area on the sphere), measured once */
const _SIZE = new WeakMap();
function sizeSr(f) {
  let v = _SIZE.get(f);
  if (v === undefined) { v = Math.sqrt(Math.max(0, d3.geoArea(f))); _SIZE.set(f, v); }
  return v;
}
function landGradient(ctx) {
  const g = ctx.createLinearGradient(W * 0.1, 0, W * 0.9, H);
  g.addColorStop(0, PAL.landLight); g.addColorStop(0.55, PAL.land); g.addColorStop(1, PAL.landDark);
  return g;
}
function drawGlobeBackdrop(ctx, path, k) {
  const show = cl((H * 1.25 - k) / (H * 0.7), 0, 1);       // only while the whole planet is in view
  if (show <= 0) return;
  ctx.save();
  ctx.globalAlpha = show;
  ctx.beginPath(); path({ type: "Sphere" });
  ctx.fillStyle = PAL.ocean; ctx.fill();
  if (KIND === "glow") { ctx.shadowColor = PAL.glow; ctx.shadowBlur = 60; }
  ctx.strokeStyle = PAL.coast; ctx.lineWidth = KIND === "paper" ? 2.4 : 2; ctx.globalAlpha = show * (KIND === "glow" ? 0.5 : 0.8); ctx.stroke();
  ctx.restore();
}
function drawGraticule(ctx, path, k) {
  ctx.save();
  ctx.beginPath(); path(d3.geoGraticule().step(k > 2500 ? [5, 5] : [10, 10])());
  ctx.strokeStyle = PAL.grid; ctx.lineWidth = KIND === "paper" ? 1.2 : 1; ctx.stroke();
  ctx.restore();
}
function drawLand(ctx, path, k) {
  const L = lodFor(k);
  const drawn = SCENE.near || KIND !== "glow" ? L.others.concat(L.land) : L.land;
  if (KIND === "paper") {
    /* The engraver's water lines: thin rings following the coast out to sea. Each is
       a wide stroke with a slightly narrower one cut out of it; the land fill drawn
       next covers the inner half, so only the rings at sea remain. */
    ctx.save();
    /* only once the camera is close enough to read them, and never round specks —
       rings round every islet on a globe looked like dust on the lens */
    ctx.beginPath();
    if (k / R_KM > 0.09) for (const f of drawn) { if (sizeSr(f) * k > 40) path(f); }
    ctx.lineJoin = "round";
    const sc = cl(k / 2500, 0.55, 1.2);
    for (const [w, a] of [[44, 0.35], [30, 0.55], [17, 0.8]]) {
      ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = a;
      ctx.strokeStyle = PAL.waterLine; ctx.lineWidth = w * sc; ctx.stroke();
      ctx.globalCompositeOperation = "destination-out"; ctx.globalAlpha = 1;
      ctx.lineWidth = w * sc - 3; ctx.stroke();
    }
    ctx.restore();
  }
  /* Everything that is context. Near (a country among its neighbours): readable land.
     Far (a state inside its country): barely there, so the country floats. */
  ctx.save();
  ctx.beginPath(); for (const f of L.others) path(f);
  /* no shadow on the context: a blurred shadow under hundreds of outlines tripled the render time */
  ctx.fillStyle = SCENE.near ? PAL.landNear : PAL.landDim; ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = SCENE.near ? PAL.borderNear : PAL.borderDim; ctx.lineWidth = SCENE.near ? 1.3 : 1; ctx.stroke();
  ctx.restore();
  if (!L.land.length) return;
  /* the countries the story is about */
  ctx.save();
  ctx.beginPath(); for (const f of L.land) path(f);
  if (KIND === "glow") { ctx.shadowColor = PAL.glow; ctx.shadowBlur = 28; }
  else if (KIND === "flat") { ctx.shadowColor = "rgba(30,40,60,0.18)"; ctx.shadowBlur = 30; ctx.shadowOffsetY = 10; }
  ctx.fillStyle = landGradient(ctx); ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.clip();
  if (KIND !== "flat") { ctx.globalAlpha = KIND === "paper" ? 0.45 : 0.55; ctx.fillStyle = GRAIN; ctx.fillRect(0, 0, W, H); }
  /* a broad soft light across the land, so it reads as a surface and not a flat fill */
  const lg = ctx.createRadialGradient(W * 0.32, H * 0.2, 0, W * 0.32, H * 0.2, W * 0.8);
  lg.addColorStop(0, "rgba(255,255,255,0.10)"); lg.addColorStop(1, KIND === "glow" ? "rgba(0,0,0,0.18)" : "rgba(0,0,0,0.05)");
  ctx.globalAlpha = 1; ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H);
  ctx.restore();
  if (L.a1mesh) {
    ctx.save();
    ctx.beginPath(); path(L.a1mesh);
    if (KIND === "paper") ctx.setLineDash([7, 5]);
    ctx.strokeStyle = PAL.border; ctx.lineWidth = cl(k / 2600, 0.9, 2.2); ctx.stroke();
    ctx.restore();
  }
  /* the coast: a bright rim with a glow, an inked line, or a crisp edge */
  ctx.save();
  ctx.beginPath(); for (const f of L.land) path(f);
  if (KIND === "glow") { ctx.shadowColor = PAL.glow; ctx.shadowBlur = 14; }
  ctx.strokeStyle = PAL.coast; ctx.lineWidth = cl(k / 1500, KIND === "glow" ? 1.4 : 1.2, KIND === "glow" ? 3.2 : 2.4); ctx.stroke();
  ctx.restore();
}

/* the picked-out shape: lit, textured, glowing — optionally floated off the map */
function shapeBounds(path, f) {
  const b = path.bounds(f);
  const ok = [b[0][0], b[0][1], b[1][0], b[1][1]].every(Number.isFinite);   /* nothing visible: far side of the globe */
  return { ok, x0: b[0][0], y0: b[0][1], x1: b[1][0], y1: b[1][1], cx: (b[0][0] + b[1][0]) / 2, cy: (b[0][1] + b[1][1]) / 2 };
}
function drawHighlight(ctx, path, f, amt, glow, flat) {
  if (!f || amt <= 0 || !shapeBounds(path, f).ok) return;
  ctx.save();
  ctx.globalAlpha = amt;
  ctx.beginPath(); path(f);
  const bb = shapeBounds(path, f);
  if (flat) {
    /* a sea or a desert: tinted and outlined, not a solid piece of card */
    ctx.fillStyle = PAL.hiWash; ctx.fill();
    if (KIND === "paper") ctx.fillStyle = GRAIN, ctx.globalAlpha = amt * 0.5, ctx.fill(), ctx.globalAlpha = amt;
    ctx.shadowColor = PAL.hiGlow; ctx.shadowBlur = (KIND === "glow" ? 24 : 8) * glow;
    ctx.strokeStyle = KIND === "glow" ? PAL.hiLight : PAL.hi; ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();
    return;
  }
  ctx.shadowColor = PAL.hiGlow; ctx.shadowBlur = (KIND === "glow" ? 40 : 18) * glow;
  const g = ctx.createLinearGradient(bb.x0, bb.y0, bb.x1, bb.y1);
  g.addColorStop(0, PAL.hiLight); g.addColorStop(0.5, PAL.hi); g.addColorStop(1, PAL.hiDark);
  ctx.fillStyle = g; ctx.fill();
  ctx.shadowColor = "transparent";
  if (KIND !== "flat") {
    ctx.save(); ctx.clip();
    ctx.fillStyle = KIND === "paper" ? GRAIN : WEAVE;
    ctx.fillRect(bb.x0 - 4, bb.y0 - 4, bb.x1 - bb.x0 + 8, bb.y1 - bb.y0 + 8);
    ctx.restore();
  }
  ctx.strokeStyle = PAL.hiEdge; ctx.lineWidth = KIND === "paper" ? 2.6 : 2.2; ctx.globalAlpha = amt * 0.9; ctx.stroke();
  ctx.restore();
}
function drawSocket(ctx, path, f, amt) {
  if (!f || amt <= 0 || !shapeBounds(path, f).ok) return;
  ctx.save();
  ctx.beginPath(); path(f);
  ctx.globalAlpha = amt;
  const bb = shapeBounds(path, f);
  const g = ctx.createLinearGradient(bb.x0, bb.y0, bb.x1, bb.y1);
  g.addColorStop(0, PAL.socketLight || PAL.socket); g.addColorStop(1, PAL.socket);
  ctx.fillStyle = g; ctx.fill();
  ctx.clip();
  /* An inner shadow along the top-left edge sells the hole the shape came out of.
     Only the SHADOW may land: the outline itself is drawn far off-canvas and its
     shadow offset back into place, or a hard black rim draws round the hole. */
  /* A path keeps the transform it was BUILT under, so it is rebuilt after the
     translate — stroking the old one drew a black rim in place and threw the
     shadow ten thousand pixels away, the exact opposite. */
  const far = 10000;
  ctx.translate(-far, 0);
  ctx.beginPath(); path(f);
  ctx.shadowColor = KIND === "glow" ? "rgba(0,0,0,0.6)" : KIND === "paper" ? "rgba(60,38,16,0.45)" : "rgba(30,50,90,0.30)";
  ctx.shadowBlur = 22; ctx.shadowOffsetX = far + 7; ctx.shadowOffsetY = 10;
  ctx.lineWidth = 12; ctx.strokeStyle = "#000"; ctx.stroke();
  ctx.restore();
}

/* ── pins, plates, rings ───────────────────────────────────────────────── */
function ripple(ctx, x, y, t0, t, color, count) {
  for (let i = 0; i < (count || 3); i++) {
    const p = ((t - t0) / 1.6 - i * 0.33);
    if (p <= 0) continue;
    const q = p % 1;
    ctx.save();
    ctx.globalAlpha = (KIND === "glow" ? 0.55 : 0.45) * (1 - q) * cl((t - t0) / 0.3, 0, 1);
    ctx.strokeStyle = color; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(x, y, 14 + q * 90, (14 + q * 90) * 0.62, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}
/* a marker that falls in and bounces, with its shadow on the map: a teardrop, or on
   an old paper map a push pin stuck through it */
function drawPin(ctx, x, y, p, color, scale) {
  if (p <= 0) return;
  const s = scale || 1, fall = (1 - eBounce(cl(p, 0, 1))) * -150 * s;
  ctx.save();
  ctx.globalAlpha = cl(p * 4, 0, 1);
  if (KIND === "paper") {
    const R = 17 * s, lean = 16 * s, hx = x + lean * 0.55, hy = y - 34 * s + fall;
    ctx.fillStyle = "rgba(40,25,10,0.35)";
    ctx.beginPath(); ctx.ellipse(x + 20 * s, y + 4 * s, R * (0.6 + 0.5 * eOut(p)), R * 0.4, 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#6f6a62"; ctx.lineWidth = 3 * s; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x, y + fall * 0.2); ctx.lineTo(hx, hy); ctx.stroke();
    const g = ctx.createRadialGradient(hx - R * 0.35, hy - R * 0.4, R * 0.1, hx, hy, R);
    g.addColorStop(0, PAL.pinLight || color); g.addColorStop(1, color);
    ctx.shadowColor = "rgba(40,25,10,0.45)"; ctx.shadowBlur = 8 * s; ctx.shadowOffsetY = 4 * s;
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(hx, hy, R, 0, Math.PI * 2); ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.beginPath(); ctx.arc(hx - R * 0.35, hy - R * 0.38, R * 0.26, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    return;
  }
  const R = 23 * s, stem = 40 * s, hy = y - stem - R + fall;
  /* ground shadow grows as the pin lands */
  ctx.fillStyle = KIND === "glow" ? "rgba(0,0,0,0.45)" : "rgba(20,30,50,0.22)";
  ctx.beginPath(); ctx.ellipse(x, y, R * (0.5 + 0.5 * eOut(p)), R * 0.28, 0, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = KIND === "glow" ? "rgba(0,0,0,0.5)" : "rgba(20,30,50,0.25)"; ctx.shadowBlur = 16 * s; ctx.shadowOffsetY = 8 * s;
  ctx.beginPath();
  ctx.moveTo(x, y + fall);
  ctx.bezierCurveTo(x - R * 0.35, y - stem * 0.45 + fall, x - R, hy + R * 0.75, x - R, hy);
  ctx.arc(x, hy, R, Math.PI, 0, false);
  ctx.bezierCurveTo(x + R, hy + R * 0.75, x + R * 0.35, y - stem * 0.45 + fall, x, y + fall);
  const g = ctx.createLinearGradient(x - R, hy - R, x + R, y + fall);
  g.addColorStop(0, PAL.pinLight || color); g.addColorStop(1, color);
  ctx.fillStyle = g; ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.fillStyle = "#ffffff";
  ctx.beginPath(); ctx.arc(x, hy, R * 0.38, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function dot(ctx, x, y, r, color, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  if (KIND === "glow") { ctx.shadowColor = color; ctx.shadowBlur = r * 3; }
  else { ctx.shadowColor = "rgba(0,0,0,0.3)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2; }
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = "transparent"; ctx.fillStyle = KIND === "paper" ? "#f3e6c8" : "#fff";
  ctx.beginPath(); ctx.arc(x, y, r * 0.45, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
/* a name plate beside a point; flips to the other side near the frame edge */
function plate(ctx, x, y, text, alpha, side) {
  if (alpha <= 0 || !text) return;
  ctx.save();
  ctx.font = `${PAL.weight} 30px ${PAL.font}`;
  try { ctx.letterSpacing = "1.5px"; } catch (e) { /* older canvas */ }
  const label = upper(text), w = ctx.measureText(label).width;
  const padX = 16, h = 50, gap = 22, pw = w + padX * 2 + 6;
  /* "center" sits ON an area's label point — beside it, a country's name lands on its neighbour */
  const centre = side === "center";
  let right = side !== "left";
  if (!centre && right && x + gap + pw > W - 40) right = false;
  if (!centre && !right && x - gap - pw < 40) right = true;
  const bx = centre ? cl(x - pw / 2, 30, W - 30 - pw) : right ? x + gap : x - gap - pw, by = y - h / 2;
  const reveal = eOut(cl(alpha, 0, 1));
  ctx.globalAlpha = cl(alpha * 1.5, 0, 1);
  const cw = pw * reveal, cx0 = centre ? bx + (pw - cw) / 2 : right ? bx : bx + pw - cw;
  ctx.beginPath(); ctx.rect(cx0, by - 4, cw, h + 8); ctx.clip();
  ctx.shadowColor = KIND === "glow" ? "rgba(0,0,0,0.45)" : "rgba(30,20,10,0.22)"; ctx.shadowBlur = 14; ctx.shadowOffsetY = 4;
  ctx.fillStyle = PAL.plate; ctx.beginPath(); ctx.roundRect(bx, by, pw, h, KIND === "paper" ? 2 : 6); ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.fillStyle = PAL.hi; ctx.fillRect(right || centre ? bx : bx + pw - 6, by, 6, h);
  ctx.fillStyle = PAL.plateInk || PAL.ink; ctx.textBaseline = "middle";
  ctx.fillText(label, bx + padX + (right || centre ? 6 : 0), y + 2);
  ctx.restore();
}
function routeLine(ctx, path, line, t) {
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath(); path(line);
  if (KIND === "paper") {
    /* red string pulled between the pins */
    ctx.shadowColor = "rgba(40,20,10,0.35)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 5;
    ctx.strokeStyle = PAL.route; ctx.lineWidth = 5; ctx.stroke();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 1.5; ctx.stroke();
  } else {
    if (KIND === "glow") { ctx.shadowColor = PAL.hiGlow; ctx.shadowBlur = 18; }
    ctx.strokeStyle = PAL.route; ctx.lineWidth = 6; ctx.stroke();
    ctx.shadowColor = "transparent";
    ctx.setLineDash([2, 16]); ctx.lineDashOffset = -t * 40;
    ctx.strokeStyle = KIND === "glow" ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.95)"; ctx.lineWidth = 3; ctx.stroke();
  }
  ctx.restore();
}

/* ── text ──────────────────────────────────────────────────────────────── */
const titleEl = $("title"), subEl = $("sub"), scrim = $("scrim");
/* measured, never guessed: the title shrinks until it fits its column */
function fitTitle(maxW, big, small) {
  let s = big;
  titleEl.style.whiteSpace = "nowrap";
  titleEl.style.fontSize = s + "px";
  while (s > small && titleEl.scrollWidth > maxW) { s -= 4; titleEl.style.fontSize = s + "px"; }
  if (titleEl.scrollWidth > maxW) { titleEl.style.whiteSpace = "normal"; titleEl.style.width = maxW + "px"; }
  return s;
}
/* Title and subtitle as one block. mode: "left" (beside a lifted shape, centred
   vertically), "bottom" (under a wide map, on a scrim) or "top". */
function placeText(mode, colW) {
  titleEl.textContent = upper(SCENE.title);
  subEl.textContent = SCENE.subtitle || "";
  titleEl.style.fontFamily = PAL.font; titleEl.style.fontWeight = PAL.weight;
  titleEl.style.color = PAL.ink; subEl.style.color = PAL.inkSoft;
  titleEl.style.textShadow = PAL.titleShadow || "none"; subEl.style.textShadow = PAL.subShadow || "none";
  subEl.style.fontFamily = PAL.subFont || PAL.font;
  const left = W * 0.065;
  titleEl.style.left = left + "px";
  const ts = fitTitle(colW, mode === "left" ? 150 : 118, 60);
  subEl.style.left = (left + 6) + "px";
  subEl.style.width = Math.max(colW, W * 0.5) + "px";
  subEl.style.fontSize = Math.round(mode === "left" ? cl(ts * 0.26, 30, 38) : cl(ts * 0.34, 34, 42)) + "px";
  const th = titleEl.getBoundingClientRect().height;
  const sh = SCENE.subtitle ? subEl.getBoundingClientRect().height + 6 : 0;
  const top = mode === "left" ? H * 0.47 - (th + sh) / 2 : mode === "top" ? H * 0.075 : H * 0.905 - (th + sh);
  titleEl.style.top = top + "px";
  subEl.style.top = (top + th + 6) + "px";
  const sc = PAL.scrim || "0,0,0";
  scrim.style.background = mode === "bottom"
    ? `linear-gradient(to top, rgba(${sc},.72) 0%, rgba(${sc},.35) 26%, transparent 42%)`
    : mode === "top" ? `linear-gradient(to bottom, rgba(${sc},.66) 0%, rgba(${sc},.3) 24%, transparent 40%)`
    : KIND === "glow" ? "none" : `linear-gradient(to right, rgba(${sc},.55) 0%, rgba(${sc},.25) 34%, transparent 50%)`;
  return { top, bottom: top + th + sh, right: left + Math.min(colW, titleEl.scrollWidth), mid: top + th / 2 };
}
function wipe(el, p) {
  el.style.opacity = p > 0 ? 1 : 0;
  el.style.clipPath = `inset(-30% ${((1 - p) * 100).toFixed(2)}% -30% -2%)`;
}
function textIn(t, at) {
  if (!SCENE.title) { titleEl.style.opacity = 0; subEl.style.opacity = 0; return; }
  wipe(titleEl, eOut(seg(t, at, 0.7)));
  wipe(subEl, SCENE.subtitle ? eOut(seg(t, at + 0.45, 0.8)) : 0);
  scrim.style.opacity = eOut(seg(t, at - 0.2, 0.6)).toFixed(3);
}

/* ── shots ─────────────────────────────────────────────────────────────── */
const SHOTS = {};

/* REGION — the reference move: the country, a push in, the place lights up, lifts
   off the map and the name writes itself on beside it. Seas and deserts light up
   in place instead of lifting. */
SHOTS.region = () => {
  const tg = SCENE.targets[0];
  const flat = tg.level === "water" || tg.level === "region";
  const liftOn = !flat && tg.lift !== false;
  const probe = fit(tg.frame, [0, 0, W * 0.3, H * 0.3]);
  const aspect = probe.bw / Math.max(1, probe.bh);
  const side = aspect < 1.35;
  const socketBox = !liftOn ? (side ? [W * 0.40, H * 0.12, W * 0.92, H * 0.88] : [W * 0.10, H * 0.08, W * 0.90, H * 0.66])
                            : (side ? [W * 0.20, H * 0.13, W * 0.54, H * 0.87] : [W * 0.17, H * 0.10, W * 0.83, H * 0.61]);
  const end = { ...fit(tg.frame, socketBox), tilt: side ? 10 : 8 };
  const start = SCENE.context && SCENE.context.frame
    ? { ...fit(SCENE.context.frame, [W * 0.08, H * 0.08, W * 0.92, H * 0.92]), tilt: 18 }
    : { ...zoomAbout(end, 0.35), tilt: 18 };
  const path0 = fly(start, end);
  const liftDX = side ? W * 0.30 : 0, liftDY = side ? -H * 0.02 : -H * 0.035;
  const flyA = 0.12, flyB = HIT + 0.1;
  const txt = placeText(side ? "left" : "bottom", side ? (liftOn ? W * 0.42 : W * 0.34) : W * 0.8);

  return t => {
    let cam = path0(eInOut(seg(t, flyA, flyB - flyA)));
    cam = zoomAbout(cam, 1 + 0.035 * eSine(seg(t, flyB, D - flyB)));   /* the camera never quite stops */
    applyCam(cam);
    const k = cam.k, f = feature(tg.id, k);
    const hiAmt = eOut(seg(t, HIT - 0.2, 0.45));
    const L = liftOn ? eBack(seg(t, HIT + 0.3, 0.75)) : 0, Lc = cl(L, 0, 1.2), L1 = cl(L, 0, 1);

    bctx.clearRect(0, 0, W, H);
    drawGlobeBackdrop(bctx, bpath, k);
    drawGraticule(bctx, bpath, k);
    drawLand(bctx, bpath, k);
    if (liftOn) {
      drawSocket(bctx, bpath, f, cl(L * 1.4, 0, 1));
      drawHighlight(bctx, bpath, f, hiAmt * (1 - cl(L * 1.6, 0, 1)), 1);
    } else {
      drawHighlight(bctx, bpath, f, hiAmt, 1 + 0.25 * Math.sin((t - HIT) * 2.2), flat);
    }
    base.style.filter = liftOn ? `blur(${(2.2 * L1).toFixed(2)}px) brightness(${(1 - (KIND === "glow" ? 0.18 : 0.06) * L1).toFixed(3)})` : "none";

    lctx.clearRect(0, 0, W, H);
    const bbL = f ? shapeBounds(bpath, f) : null;
    if (liftOn && f && L > 0.001 && bbL.ok) {
      const bb = bbL;
      const bob = Math.sin((t - HIT) * 1.3) * 3 * L1;
      lctx.save();
      lctx.translate(bb.cx + liftDX * Lc, bb.cy + liftDY * Lc + bob);
      const sc = 1 + 0.07 * Lc;
      lctx.scale(sc, sc);
      lctx.translate(-bb.cx, -bb.cy);
      /* the shadow it casts on the map below */
      lctx.save();
      lctx.beginPath(); lpath(f);
      lctx.shadowColor = PAL.liftShadow || "rgba(0,0,0,0.6)"; lctx.shadowBlur = 36 * L1;
      lctx.shadowOffsetX = -18 * Lc; lctx.shadowOffsetY = 26 * Lc;
      lctx.fillStyle = PAL.liftBody || "rgba(0,0,0,0.9)"; lctx.fill();
      lctx.restore();
      drawHighlight(lctx, lpath, f, 1, 1.25);
      /* a slow sheen crossing the raised shape */
      const sw = seg(t, HIT + 1.6, 1.1);
      if (sw > 0 && sw < 1) {
        lctx.save(); lctx.beginPath(); lpath(f); lctx.clip();
        const x = lerp(bb.x0 - 200, bb.x1 + 200, eInOut(sw));
        const g = lctx.createLinearGradient(x - 120, bb.y0, x + 120, bb.y1);
        g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.5, "rgba(255,255,255,0.22)"); g.addColorStop(1, "rgba(255,255,255,0)");
        lctx.fillStyle = g; lctx.fillRect(bb.x0 - 10, bb.y0 - 10, bb.x1 - bb.x0 + 20, bb.y1 - bb.y0 + 20);
        lctx.restore();
      }
      lctx.restore();
    }

    /* a soft disc breathes out behind the name as it lands */
    fctx.clearRect(0, 0, W, H);
    const rp = seg(t, HIT + 0.55, 1.5);
    if (rp > 0 && rp < 1 && f && side && liftOn) {
      fctx.save();
      fctx.globalAlpha = 0.30 * (1 - eIn(rp));
      fctx.fillStyle = PAL.ring;
      fctx.beginPath(); fctx.arc(W * 0.27, txt.mid, lerp(40, 230, eOut(rp)), 0, Math.PI * 2); fctx.fill();
      fctx.restore();
    }
    textIn(t, HIT + (liftOn ? 0.45 : 0.25));
  };
};

/* PIN — a city: the country, a push in, the pin drops on the word and rings
   ripple out while a line runs from the pin to its name. */
SHOTS.pin = () => {
  const tg = SCENE.targets[0], P = [tg.lon, tg.lat];
  const txt0 = { mode: "left", colW: W * 0.36 };
  const endBox = [W * 0.44, H * 0.12, W * 0.94, H * 0.88];
  let end = { ...fit(tg.frame, endBox), tilt: 12 };
  /* keep the pin itself comfortably inside the map side of the frame */
  applyCam(end);
  const q = ortho(P);
  const sx = cl(q[0], W * 0.52, W * 0.84), sy = cl(q[1], H * 0.30, H * 0.74);
  end = aimAt(end, P, sx, sy);
  const start = SCENE.context && SCENE.context.frame
    ? { ...fit(SCENE.context.frame, [W * 0.08, H * 0.08, W * 0.92, H * 0.92]), tilt: 20 }
    : { ...zoomAbout(end, 0.4), tilt: 20 };
  const path0 = fly(start, end);
  const flyA = 0.12, flyB = HIT;
  const txt = placeText(txt0.mode, txt0.colW);

  return t => {
    let cam = path0(eInOut(seg(t, flyA, flyB - flyA)));
    cam = zoomAbout(cam, 1 + 0.04 * eSine(seg(t, flyB, D - flyB)));
    applyCam(cam);
    const k = cam.k;
    bctx.clearRect(0, 0, W, H);
    drawGlobeBackdrop(bctx, bpath, k);
    drawGraticule(bctx, bpath, k);
    drawLand(bctx, bpath, k);
    if (tg.area) drawHighlight(bctx, bpath, feature(tg.area, k), 0.55 * eOut(seg(t, HIT - 0.1, 0.5)), 0.6, true);

    lctx.clearRect(0, 0, W, H);
    fctx.clearRect(0, 0, W, H);
    const p = screen(P);
    if (p) {
      ripple(lctx, p[0], p[1], HIT + 0.25, t, PAL.hiLight, 3);
      drawPin(lctx, p[0], p[1], seg(t, HIT - 0.15, 0.85), PAL.pin, 1.15);
      /* the leader: from the end of the name block to the foot of the pin */
      const lp = eInOut(seg(t, HIT + 0.55, 0.6));
      if (lp > 0 && SCENE.title) {
        const x0 = Math.min(txt.right + 40, p[0] - 60), y0 = txt.mid;
        const xm = lerp(x0, p[0] - 34, 0.55);
        fctx.save();
        fctx.strokeStyle = PAL.leader; fctx.lineWidth = 3; fctx.globalAlpha = 0.9;
        fctx.beginPath(); fctx.moveTo(x0, y0);
        const pts = [[x0, y0], [xm, y0], [p[0] - 30, p[1] - 30]];
        const l1 = Math.hypot(pts[1][0] - pts[0][0], 0), l2 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
        const L = (l1 + l2) * lp;
        if (L <= l1) fctx.lineTo(x0 + L, y0);
        else { const u = (L - l1) / l2; fctx.lineTo(xm, y0); fctx.lineTo(lerp(xm, pts[2][0], u), lerp(y0, pts[2][1], u)); }
        fctx.stroke();
        fctx.fillStyle = PAL.leader; fctx.beginPath(); fctx.arc(x0, y0, 5, 0, Math.PI * 2); fctx.fill();
        fctx.restore();
      }
    }
    textIn(t, HIT + 0.2);
  };
};

/* ROUTE — a journey. The line draws from stop to stop with a plane, a ship or a
   glowing head on it; the camera pulls out as the line grows; each stop names
   itself as the line reaches it. */
SHOTS.route = () => {
  const stops = SCENE.stops || [];
  const pts = stops.map(s => [s.lon, s.lat]);
  /* sample every leg along its great circle */
  const line = [], cum = [0];
  for (let i = 0; i < pts.length - 1; i++) {
    const gi = d3.geoInterpolate(pts[i], pts[i + 1]), dd = d3.geoDistance(pts[i], pts[i + 1]);
    const n = Math.max(2, Math.ceil(dd / 0.004));
    for (let j = (i ? 1 : 0); j <= n; j++) line.push(gi(j / n));
  }
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + d3.geoDistance(line[i - 1], line[i]));
  const total = cum[cum.length - 1] || 1e-6;
  const stopAt = pts.map(p => { let best = 0, bd = 9; line.forEach((q, i) => { const d = d3.geoDistance(p, q); if (d < bd) { bd = d; best = i; } }); return cum[best] / total; });
  const mode = SCENE.text_at === "top" ? "top" : "bottom";
  const txt = placeText(mode, W * 0.8);
  const mapBox = mode === "bottom" ? [W * 0.08, H * 0.08, W * 0.92, H * 0.70] : [W * 0.08, H * 0.30, W * 0.92, H * 0.92];
  const end = { ...fit(SCENE.frame, mapBox), tilt: 10 };
  const firstBox = SCENE.first_frame || SCENE.frame;
  const start = { ...fit(firstBox, [W * 0.2, H * 0.12, W * 0.8, H * 0.78]), tilt: 16 };
  /* A stop may carry `at`: the second its name is spoken. Then the line reaches each stop
     exactly then, leg by leg, instead of crossing the whole route at one speed. */
  const timed = stops.length > 1 && stops.every((st, i) => st.via || typeof st.at === "number");
  const DRAW0 = timed ? (stops[0].at != null ? stops[0].at + 0.25 : HIT) : HIT;
  const DRAW1 = timed ? stops[stops.length - 1].at : Math.min(D - 1.4, HIT + (SCENE.draw_s || cl(2.2 + total * 2.2, 2.4, 4.6)));
  const keys = timed ? stops.map((st, i) => ({ t: i === 0 ? DRAW0 : st.at, f: stopAt[i] })).filter((k, i) => !stops[i].via || i === 0) : null;
  function fracAt(t) {
    if (!timed) return eInOut(seg(t, DRAW0, DRAW1 - DRAW0));
    if (t <= keys[0].t) return 0;
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i].t) return lerp(keys[i - 1].f, keys[i].f, eInOut(seg(t, keys[i - 1].t, keys[i].t - keys[i - 1].t)));
    }
    return 1;
  }
  const path0 = fly(start, end);
  const icon = SCENE.icon ? { p: new Path2D(SCENE.icon.d), vb: (SCENE.icon.vb || "0 0 512 512").split(/\s+/).map(Number) } : null;

  function partial(frac) {
    const L = frac * total;
    let i = 1;
    while (i < cum.length && cum[i] < L) i++;
    const out = line.slice(0, i);
    if (i < line.length) {
      const u = (L - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
      out.push(d3.geoInterpolate(line[i - 1], line[i])(u));
    }
    return out;
  }

  return t => {
    const u = eInOut(seg(t, 0.1, DRAW1 - 0.1 + 0.4));
    let cam = path0(u);
    cam = zoomAbout(cam, 1 + 0.03 * eSine(seg(t, DRAW1, D - DRAW1)));
    applyCam(cam);
    const k = cam.k;
    bctx.clearRect(0, 0, W, H);
    drawGlobeBackdrop(bctx, bpath, k);
    drawGraticule(bctx, bpath, k);
    drawLand(bctx, bpath, k);

    lctx.clearRect(0, 0, W, H);
    const frac = fracAt(t);
    if (frac > 0) routeLine(lctx, lpath, { type: "LineString", coordinates: partial(frac) }, t);
    /* stops: a dot and a plate as the line arrives; the first one is there from the start */
    stops.forEach((s, i) => {
      const p = screen(pts[i]);
      if (!p) return;
      const arrive = timed && typeof s.at === "number" ? s.at - (i === 0 ? 0.15 : 0.05)
                   : i === 0 ? HIT - 0.4 : DRAW0 + (DRAW1 - DRAW0) * eInOut(stopAt[i]) - 0.05;
      const a = seg(t, arrive, 0.45);
      if (a <= 0 || s.via) return;
      ripple(lctx, p[0], p[1], arrive, t, PAL.hiLight, 2);
      dot(lctx, p[0], p[1], 11, PAL.pin, eOut(a));
      plate(lctx, p[0], p[1], s.name, seg(t, arrive + 0.15, 0.5), i === 0 && pts.length > 1 && pts[1][0] > pts[0][0] ? "left" : "right");
    });
    /* the head: a plane points where it flies; a ship or a walker only faces left or right */
    if (frac > 0 && frac < 1) {
      const cur = partial(frac), hd = cur[cur.length - 1], prev = cur[Math.max(0, cur.length - 4)];
      const a = screen(hd), b = screen(prev);
      if (a && b) {
        if (icon) {
          const ang = Math.atan2(a[1] - b[1], a[0] - b[0]), S = 64 / Math.max(icon.vb[2], icon.vb[3]);
          lctx.save();
          lctx.translate(a[0], a[1]);
          if (SCENE.icon_rotate) lctx.rotate(ang + (SCENE.icon_angle || 0) * Math.PI / 180);
          else if (a[0] < b[0]) lctx.scale(-1, 1);
          lctx.scale(S, S); lctx.translate(-icon.vb[2] / 2, -icon.vb[3] / 2);
          lctx.shadowColor = "rgba(0,0,0,0.6)"; lctx.shadowBlur = 10 / S;
          lctx.fillStyle = PAL.icon || "#ffffff"; lctx.fill(icon.p);
          lctx.restore();
        } else dot(lctx, a[0], a[1], 12, "#ffffff", 1);
      }
    }
    fctx.clearRect(0, 0, W, H);
    textIn(t, 0.35);
  };
};

/* MULTI — several places named in one breath: the map that holds them all, each
   lighting up in turn with its name beside it. */
SHOTS.multi = () => {
  const tgs = SCENE.targets || [];
  const mode = SCENE.title ? "bottom" : "none";
  const txt = mode === "none" ? null : placeText("bottom", W * 0.8);
  const box = mode === "none" ? [W * 0.08, H * 0.1, W * 0.92, H * 0.9] : [W * 0.08, H * 0.08, W * 0.92, H * 0.70];
  const step = tgs.length > 1 ? cl((D - HIT - 2.2) / tgs.length, 0.35, 0.9) : 0;
  const hits = tgs.map((tg, i) => tg.hit != null ? tg.hit : HIT + i * step);
  let camAt;
  if (SCENE.tour) {
    /* one view per place, flown between so each arrives as it is named */
    const cams = SCENE.frames.map(f => ({ ...fit(f, box), tilt: 10 }));
    const legs = cams.slice(1).map((c, i) => fly(cams[i], c));
    const first = fly({ ...zoomAbout(cams[0], 0.55), tilt: 18 }, cams[0]);
    camAt = t => {
      if (t < hits[0] || cams.length === 1) return first(eInOut(seg(t, 0.1, hits[0] - 0.1)));
      for (let i = legs.length - 1; i >= 0; i--) {
        const a = Math.max(hits[i] + 0.5, hits[i + 1] - 1.6), b = hits[i + 1] - 0.05;
        if (t >= a) return legs[i](eInOut(seg(t, a, b - a)));
      }
      return cams[0];
    };
  } else {
    const end = { ...fit(SCENE.frame, box), tilt: 10 };
    const path0 = fly({ ...zoomAbout(end, 0.72), tilt: 18 }, end);
    camAt = t => path0(eInOut(seg(t, 0.1, HIT + 0.2)));
  }

  return t => {
    let cam = camAt(t);
    cam = zoomAbout(cam, 1 + 0.03 * eSine(seg(t, HIT, D - HIT)));
    applyCam(cam);
    const k = cam.k;
    bctx.clearRect(0, 0, W, H);
    drawGlobeBackdrop(bctx, bpath, k);
    drawGraticule(bctx, bpath, k);
    drawLand(bctx, bpath, k);
    lctx.clearRect(0, 0, W, H);
    tgs.forEach((tg, i) => {
      const at = hits[i];
      const a = eOut(seg(t, at - 0.1, 0.45));
      if (tg.level === "point") {
        const p = screen([tg.lon, tg.lat]);
        if (p) { ripple(lctx, p[0], p[1], at, t, PAL.hiLight, 2); dot(lctx, p[0], p[1], 11, PAL.pin, a); }
      } else {
        drawHighlight(bctx, bpath, feature(tg.id, k), a, 0.8, tg.level === "water" || tg.level === "region");
      }
      const lp = screen(tg.label || [tg.lon, tg.lat]);
      if (lp) plate(lctx, lp[0], lp[1], tg.name, seg(t, at + 0.2, 0.5), tg.level === "point" ? "right" : "center");
    });
    fctx.clearRect(0, 0, W, H);
    if (txt) textIn(t, 0.4);
  };
};

/* ── drive ─────────────────────────────────────────────────────────────── */
async function boot() {
  try { await document.fonts.ready; } catch (e) { /* the fallback face still renders */ }
  paintGround();
  const frame = (SHOTS[SCENE.shot] || SHOTS.region)();
  window.__errors = [];
  window.renderFrame = t => {
    const fin = cl(t / 0.35, 0, 1), fout = cl((D - t) / 0.45, 0, 1);
    $("stage").style.opacity = Math.min(fin, fout).toFixed(3);
    /* A bug in one frame is reported, not fatal: maps.py prints what went wrong, and
       the video keeps the frames around it instead of losing the whole render. */
    try { frame(t); } catch (e) { if (window.__errors.length < 5) window.__errors.push(`t=${t.toFixed(2)}: ${e && e.stack || e}`); }
  };
  window.renderFrame(0);
  window.__ready = true;
}
boot().catch(e => { document.title = "ERR " + e; throw e; });
