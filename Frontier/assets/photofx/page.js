/* PHOTO FX — the two scenes it draws in Chromium.

   SCENE.type "spotlight": a real photograph. The camera pushes in on the subject while the rest of the
   picture darkens, loses its colour and blurs; the subject, cut out, stays sharp and grows a little.
   SCENE.type "objects": real things cut out of their photos, flying in over a blurred ground with a
   soft shadow under each — rise and settle, drop and wobble, slide in from a side, or pop.

   Every frame is a screenshot taken at time t, in any order: everything below is computed from t alone. */
(function () {
  const S = window.SCENE;
  const FW = 1920, FH = 1080;
  const cl = (x, a, b) => Math.max(a, Math.min(b, x));
  const seg = (t, s, d) => cl((t - s) / Math.max(1e-6, d), 0, 1);
  const lerp = (a, b, p) => a + (b - a) * p;
  const eOut = p => 1 - Math.pow(1 - p, 3);
  const eInOut = p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const eBack = p => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };
  // a damped spring from 0 to 1: f = how many swings a second, z = how quickly they die (0..1)
  function spring(t, f, z) {
    if (t <= 0) return 0;
    const w = 2 * Math.PI * f, wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
  }

  const root = document.getElementById('stage');
  const waits = [];
  function el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    (parent || root).appendChild(e);
    return e;
  }
  function pic(src, cls, parent, w, h) {
    const i = el('img', cls, parent);
    waits.push(new Promise(res => { i.onload = i.onerror = res; }));
    i.src = src;
    if (w) { i.style.width = w + 'px'; i.style.height = h + 'px'; }
    return i;
  }
  const show = (e, on) => { const v = on ? 'visible' : 'hidden'; if (e.style.visibility !== v) e.style.visibility = v; };
  let frame = () => {};

  if (S.type === 'spotlight') {
    // two cameras with the same move: the picture, then the vignette, then the subject above both —
    // so the darkening at the edges never touches the subject
    const cam = el('div', 'cam');
    const plate = pic(S.plate, 'layer', cam, S.cw, S.ch);
    const dim = pic(S.dim, 'layer', cam, S.cw, S.ch);
    const soft = pic(S.soft, 'layer', cam, S.cw, S.ch);
    const vig = el('div', 'vig');
    const cam2 = el('div', 'cam');
    let subj = null;
    if (S.subj) {
      subj = pic(S.subj, 'layer', cam2, S.cw, S.ch);
      subj.style.transformOrigin = `${S.anchor[0]}px ${S.anchor[1]}px`;
    }
    frame = t => {
      const D = S.duration, hit = S.hit;
      // a slow push from the first frame, then the real move toward the subject
      const move = eInOut(seg(t, 0.1, D - 0.1));
      const z = 1 + S.creep * seg(t, 0, D) + (S.zoom - 1 - S.creep) * move;
      const s = (FW / S.cw) * z;
      const pan = eInOut(seg(t, 0, D * 0.85));
      const hw = FW / (2 * s), hh = FH / (2 * s);
      const cx = cl(lerp(S.cw / 2, S.focus[0], pan), hw, S.cw - hw);
      const cy = cl(lerp(S.ch / 2, S.focus[1], pan), hh, S.ch - hh);
      cam.style.transform = cam2.style.transform =
        `translate(${FW / 2}px,${FH / 2}px) scale(${s}) translate(${-cx}px,${-cy}px)`;
      const d = eInOut(seg(t, hit - 0.35, 1.1));
      const f = eInOut(seg(t, hit + 0.45, 1.6));
      dim.style.opacity = d;
      soft.style.opacity = f;
      // a layer fully covered by an opaque one above it is not drawn at all (without a cutout the
      // darker layers carry an oval of light, so the sharp picture must stay underneath)
      show(plate, !S.opaque || d < 0.999);
      show(dim, d > 0.001 && f < 0.999);
      show(soft, f > 0.001);
      if (subj) subj.style.transform = `scale(${lerp(1, S.pop, eOut(seg(t, hit - 0.2, 2.4)))})`;
      vig.style.opacity = S.vignette * d;
    };
  }

  if (S.type === 'objects') {
    const ground = el('div', 'ground');
    const bg = pic(S.bg, 'bg', ground, FW, FH);
    const world = el('div', 'world');
    const rows = S.items.map((it, i) => ({
      it,
      sh: pic(it.shadow, 'thing', world, it.sw, it.sh),
      im: pic(it.src, 'thing', world, it.w, it.h),
      phase: 0.9 + i * 1.7,
    }));
    for (const r of rows) r.im.style.transformOrigin = r.it.enter === 'drop' ? '50% 100%' : '50% 50%';
    let label = null;
    if (S.label && S.label.text) {
      label = el('div', 'label', root);
      label.textContent = S.label.text;
      label.style.left = S.label.x + 'px';
      label.style.top = S.label.y + 'px';
    }

    // where a thing is `u` seconds after it starts to enter: {x, y, rot, sc, lift}; lift 0 = at rest
    function move(it, u, phase) {
      let x = it.x, y = it.y, rot = 0, sc = 1, lift = 0;
      if (it.enter === 'drop') {
        const fall = 0.4;
        if (u < fall) {
          const p = u / fall;
          y = lerp(-it.h * 0.75, it.y, p * p);
          rot = it.rot * (1 - 0.35 * p);
          lift = 1 - p * p;
        } else {
          const v = u - fall;
          const hop = Math.abs(Math.sin(v * 9.0)) * Math.exp(-v * 7.0);
          y = it.y - hop * it.h * 0.07;
          rot = it.rot * 0.65 * Math.exp(-v * 3.4) * Math.cos(v * 12.5);
          lift = hop * 0.35;
        }
      } else if (it.enter === 'pop') {
        const p = seg(u, 0, 0.5);
        sc = Math.max(0.001, eBack(p));
        rot = it.rot * (1 - eOut(p));
        lift = 1 - p;
      } else {
        const k = spring(u, 1.05, 0.6);
        const r = spring(u, 0.85, 0.45);
        if (it.enter === 'left' || it.enter === 'right') {
          const from = it.enter === 'left' ? -it.w * 0.7 : FW + it.w * 0.7;
          x = lerp(from, it.x, k);
          y = it.y + (1 - k) * it.h * 0.12;
        } else {
          y = lerp(FH + it.h * 0.65, it.y, k);
        }
        rot = it.rot * (1 - r);
        sc = lerp(0.9, 1, cl(k, 0, 1.3));
        lift = cl(1 - k, 0, 1);
      }
      // once it has settled, it keeps breathing a little
      const idle = seg(u, 0.9, 0.9);
      y += idle * it.h * 0.006 * Math.sin(u * 2 * Math.PI / 3.3 + phase);
      rot += idle * 0.6 * Math.sin(u * 2 * Math.PI / 4.4 + phase);
      return { x, y, rot, sc, lift };
    }

    frame = t => {
      const D = S.duration;
      bg.style.transform = `scale(${lerp(1.12, 1.02, eOut(seg(t, 0, D)))})`;
      world.style.transform = `scale(${lerp(1.0, 1.045, eInOut(seg(t, 0, D)))})`;
      for (const r of rows) {
        const it = r.it, u = t - it.at;
        const on = u > 0;
        show(r.im, on);
        show(r.sh, on);
        if (!on) continue;
        const m = move(it, u, r.phase);
        r.im.style.transform = `translate(${m.x - it.w / 2}px,${m.y - it.h / 2}px) rotate(${m.rot}deg) scale(${m.sc})`;
        const lift = cl(m.lift, 0, 1);
        const sx = m.x + it.dx * (1 + 1.5 * lift), sy = m.y + it.dy + lift * it.h * 0.25;
        r.sh.style.transform = `translate(${sx - it.sw / 2}px,${sy - it.sh / 2}px) rotate(${m.rot}deg) scale(${m.sc * (1 + 0.3 * lift)})`;
        r.sh.style.opacity = S.shadow * (1 - 0.75 * lift);
      }
      if (label) {
        const p = eOut(seg(t, S.label.at, 0.45));
        label.style.clipPath = `inset(0 ${100 - 100 * p}% 0 0)`;
        show(label, p > 0);
      }
    };
  }

  const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  Promise.all(waits.concat([fonts]))
    .then(() => Promise.all(Array.from(document.images).map(i => (i.decode ? i.decode().catch(() => null) : null))))
    .then(() => {
      window.renderFrame = t => frame(t);
      frame(0);
      window.__ready = true;
    });
})();
