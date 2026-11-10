/* Pusoy Dos — arcade effects: square sparks, impact rings, confetti,
 * screen shake, flashes and floating score text.
 * One canvas sits over the whole page; it only animates while something is on it.
 * Everything here is decoration: if the visitor prefers reduced motion it stays quiet. */
(function (root) {
  'use strict';
  var P = (root.Pusoy = root.Pusoy || {});
  var cv = null, ctx = null, W = 0, H = 0, parts = [], running = false, last = 0;
  var calm = false;
  var MAX = 700;

  function init(canvas) {
    cv = canvas; ctx = cv.getContext('2d');
    try {
      var mq = root.matchMedia('(prefers-reduced-motion: reduce)');
      calm = mq.matches;
      if (mq.addEventListener) mq.addEventListener('change', function (e) { calm = e.matches; });
    } catch (e) { /* old browser: assume motion is fine */ }
    resize();
    root.addEventListener('resize', resize);
  }
  function resize() {
    if (!cv) return;
    var dpr = Math.min(2, root.devicePixelRatio || 1);
    W = root.innerWidth; H = root.innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function kick() {
    if (running || !ctx) return;
    running = true; last = performance.now();
    requestAnimationFrame(frame);
  }
  function frame(t) {
    try { draw(t); }
    catch (e) { parts = []; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); resize(); }   // never leave sparks frozen on screen
    if (parts.length) requestAnimationFrame(frame); else { running = false; ctx.clearRect(0, 0, W, H); }
  }
  function draw(t) {
    var dt = Math.max(0, Math.min(0.05, (t - last) / 1000)); last = t;   // the first frame can report a time before kick()
    ctx.clearRect(0, 0, W, H);
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.life -= dt;
      if (p.life <= 0 || p.y > H + 40) { parts.splice(i, 1); continue; }
      var k = p.life / p.max;
      if (p.kind === 'ring') {
        p.r += p.vr * dt; p.vr *= 1 - 2.2 * dt;
        ctx.globalAlpha = k; ctx.strokeStyle = p.color; ctx.lineWidth = 2 + p.w * k;
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1, p.r), 0, 6.2832); ctx.stroke();
        continue;
      }
      p.vy += p.g * dt;
      var d = 1 - p.drag * dt; p.vx *= d; p.vy *= d;
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.spin * dt;
      ctx.globalAlpha = Math.min(1, k * 2.2);
      ctx.fillStyle = p.color;
      if (p.kind === 'dia') {                              // a little diamond, tumbling
        var h = p.size * (0.5 + 0.5 * Math.min(1, k * 2)), wd = h * 0.68 * (0.35 + 0.65 * Math.abs(Math.cos(p.rot * 1.7)));
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(Math.sin(p.rot) * 0.5);
        ctx.beginPath(); ctx.moveTo(0, -h); ctx.lineTo(wd, 0); ctx.lineTo(0, h); ctx.lineTo(-wd, 0); ctx.closePath(); ctx.fill();
        ctx.restore();
      } else if (p.kind === 'conf') {
        var w = p.size * Math.abs(Math.cos(p.rot * 2.3)) + 1;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillRect(-w / 2, -p.size * 0.35, w, p.size * 0.7);
        ctx.restore();
      } else {
        var s = p.size * (0.4 + 0.6 * k);                 // chunky pixels that shrink as they die
        ctx.fillRect(Math.round(p.x - s / 2), Math.round(p.y - s / 2), Math.ceil(s), Math.ceil(s));
      }
    }
    ctx.globalAlpha = 1;
  }
  function add(p) { if (parts.length < MAX) parts.push(p); }
  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

  /* A pop of square sparks. o: { colors, count, speed, life, size, gravity, up } */
  function burst(x, y, o) {
    if (calm || !ctx) return;
    o = o || {};
    var n = o.count || 14, sp = o.speed || 260, colors = o.colors || ['#F7F1E3'];
    for (var i = 0; i < n; i++) {
      var a = Math.random() * 6.2832, v = sp * (0.35 + Math.random() * 0.85);
      add({ kind: 'sq', x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (o.up || 0),
        g: o.gravity === undefined ? 520 : o.gravity, drag: 1.6, rot: 0, spin: 0,
        size: (o.size || 7) * (0.6 + Math.random() * 0.8), color: pick(colors),
        life: (o.life || 0.6) * (0.6 + Math.random() * 0.7), max: o.life || 0.6 });
    }
    kick();
  }
  function ring(x, y, color, power) {
    if (calm || !ctx) return;
    add({ kind: 'ring', x: x, y: y, r: 8, vr: 240 + (power || 0) * 200, w: 4 + (power || 0) * 2, color: color || '#F7F1E3', life: 0.42, max: 0.42 });
    kick();
  }
  /* Confetti cannons from both bottom corners plus a shower from the top. */
  function confetti(colors, amount) {
    if (calm || !ctx) return;
    colors = colors || ['#EF6257', '#4DA6E0', '#F5A742', '#5FC592', '#A58AE6', '#F7F1E3'];
    var n = amount || 150, i;
    for (i = 0; i < n; i++) {
      var left = i % 2 === 0, a = (left ? -1.05 : -2.09) + (Math.random() - 0.5) * 0.7, v = 620 + Math.random() * 620;
      add({ kind: 'conf', x: left ? -10 : W + 10, y: H * 0.82, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 780, drag: 0.9,
        rot: Math.random() * 6, spin: (Math.random() - 0.5) * 12, size: 8 + Math.random() * 8, color: pick(colors),
        life: 2.2 + Math.random() * 1.4, max: 3 });
    }
    for (i = 0; i < n / 2; i++) {
      add({ kind: 'conf', x: Math.random() * W, y: -20 - Math.random() * 200, vx: (Math.random() - 0.5) * 120, vy: 120 + Math.random() * 200, g: 260, drag: 0.4,
        rot: Math.random() * 6, spin: (Math.random() - 0.5) * 10, size: 7 + Math.random() * 7, color: pick(colors),
        life: 2.6 + Math.random() * 1.6, max: 3.4 });
    }
    kick();
  }

  /* The 2 of diamonds: diamonds blast out of the pile, then more drift down from above. */
  function diamonds(x, y, colors, count) {
    if (calm || !ctx) return;
    colors = colors || ['#D8473E', '#F5A742', '#F7F1E3'];
    var n = count || 60, i;
    for (i = 0; i < n; i++) {
      var a = Math.random() * 6.2832, v = 260 + Math.random() * 620;
      add({ kind: 'dia', x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 160, g: 620, drag: 1.1,
        rot: Math.random() * 6, spin: (Math.random() - 0.5) * 9, size: 7 + Math.random() * 9, color: pick(colors),
        life: 1.1 + Math.random() * 0.9, max: 1.6 });
    }
    for (i = 0; i < n * 0.7; i++) {
      add({ kind: 'dia', x: Math.random() * W, y: -20 - Math.random() * 260, vx: (Math.random() - 0.5) * 60, vy: 160 + Math.random() * 220, g: 180, drag: 0.3,
        rot: Math.random() * 6, spin: (Math.random() - 0.5) * 6, size: 6 + Math.random() * 8, color: pick(colors),
        life: 2.2 + Math.random() * 1.4, max: 3 });
    }
    kick();
  }
  /* A spinning sunburst behind the pile. `host` is the playfield; x/y are pixels inside it. */
  function rays(host, x, y) {
    if (calm || !host) return;
    var el = document.createElement('div');
    el.className = 'rays';
    el.style.setProperty('--x', x + 'px'); el.style.setProperty('--y', y + 'px');
    host.appendChild(el);
    setTimeout(function () { el.remove(); }, 2100);
  }
  /* Re-run a one-shot CSS animation class on an element. */
  function kickClass(el, cls) {
    if (!el) return;
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
  }

  /* Rattle an element. level 1..3 */
  function shake(el, level) {
    if (calm || !el || !level) return;
    el.classList.remove('shake1', 'shake2', 'shake3');
    void el.offsetWidth;
    el.classList.add('shake' + Math.max(1, Math.min(3, level)));
  }
  function flash(el, color) {
    if (calm || !el || !el.animate) return;
    el.style.background = color || '#fff';
    el.animate([{ opacity: 0.28 }, { opacity: 0 }], { duration: 260, easing: 'ease-out' });
  }
  /* Text that pops up and drifts away, e.g. "+12" or "LAST CARD!". */
  function floatText(x, y, text, color, big) {
    var el = document.createElement('div');
    el.className = 'floaty' + (big ? ' big' : '');
    el.textContent = text;
    el.style.left = x + 'px'; el.style.top = y + 'px';
    if (color) el.style.color = color;
    document.body.appendChild(el);
    var half = el.offsetWidth / 2 + 6;                       // keep it on screen near the edges
    el.style.left = Math.max(half, Math.min(root.innerWidth - half, x)) + 'px';
    setTimeout(function () { el.remove(); }, calm ? 900 : 1300);
  }
  function center(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  P.FX = {
    init: init, burst: burst, ring: ring, confetti: confetti, shake: shake, flash: flash,
    diamonds: diamonds, rays: rays, kickClass: kickClass,
    floatText: floatText, center: center, isCalm: function () { return calm; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
