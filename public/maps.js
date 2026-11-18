'use strict';

// Visual themes for each map. Layouts (platforms, portals, spawns) come from the
// server; a map's `theme` field picks one of these. Every draw function takes the
// canvas context so the same code renders the game and the lobby thumbnails.

// One color scheme per portal pair (pair 0 = portals 0/1, pair 1 = portals 2/3, …)
const PORTAL_COLORS = [
  { glow: '132, 94, 247', arm1: '#9775fa', arm2: '#e599f7', speck: '229, 153, 247', inner: 'rgba(208, 191, 255, 0.85)', rim: '#3b1d6e' },
  { glow: '21, 170, 191', arm1: '#22b8cf', arm2: '#96f2d7', speck: '150, 242, 215', inner: 'rgba(197, 246, 250, 0.85)', rim: '#0b4f5c' },
];

const THEMES = {
  meadow: {
    sky: ['#74c0fc', '#d0ebff'],
    sun: { color: '#fff3bf', r: 34, fx: 0.917, fy: 0.13 },
    clouds: 'rgba(255, 255, 255, 0.85)',
    platform: { body: '#a0672f', top: '#51cf66', ground: '#8d5a2b', groundTop: '#51cf66', groundEdge: '#40c057' },
    trap: { goo: '#7048e8', light: '#b197fc', bubble: '220, 210, 255' },
    scenery: drawMeadowHills,
  },
  night: {
    sky: ['#0b1533', '#2d3a6b'],
    stars: true,
    moon: { color: '#f1f3f5', r: 30, fx: 0.82, fy: 0.17 },
    clouds: 'rgba(170, 180, 220, 0.16)',
    platform: { body: '#4c566a', top: '#91a7ff', ground: '#2b3040', groundTop: '#5c6bc0', groundEdge: '#3b4a9a' },
    trap: { goo: '#7048e8', light: '#b197fc', bubble: '220, 210, 255' },
    scenery: drawNightHills,
  },
  canyon: {
    sky: ['#ff7b54', '#ffd8a8'],
    sun: { color: '#ffe066', r: 70, fx: 0.62, fy: 0.6, glow: true },
    clouds: 'rgba(255, 225, 210, 0.7)',
    platform: { body: '#c2703d', top: '#f0a35e', ground: '#a0522d', groundTop: '#e8913a', groundEdge: '#c46a24' },
    trap: { goo: '#7048e8', light: '#b197fc', bubble: '220, 210, 255' },
    scenery: drawMesas,
  },
  snow: {
    sky: ['#8fc1ec', '#eef6ff'],
    sun: { color: '#fffbe6', r: 30, fx: 0.18, fy: 0.14, glow: true },
    clouds: 'rgba(255, 255, 255, 0.8)',
    snowfall: true,
    platform: { body: '#6f97bb', top: '#ffffff', ground: '#5b82a6', groundTop: '#f8fbff', groundEdge: '#cfe2f3' },
    trap: { goo: '#5b7594', light: '#c5d6e8', bubble: '235, 243, 250' }, // slush
    scenery: drawSnowPeaks,
  },
  jungle: {
    sky: ['#2f7d4a', '#c8e9a0'],
    sun: { color: '#fff9c4', r: 40, fx: 0.72, fy: 0.12, glow: true },
    clouds: 'rgba(255, 255, 255, 0.3)',
    platform: { body: '#7c858f', top: '#69db7c', ground: '#5c3d1e', groundTop: '#37b24d', groundEdge: '#2f9e44' },
    trap: { goo: '#5e3b1c', light: '#a47148', bubble: '214, 170, 120' }, // mud
    scenery: drawJungle,
  },
};

function themeFor(map) {
  return THEMES[map?.theme] || THEMES.meadow;
}

// Deterministic pseudo-random in [0, 1) so star fields don't flicker between frames
function seeded(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const CLOUDS = [
  { x: 80, y: 70, s: 1 }, { x: 330, y: 40, s: 0.7 }, { x: 600, y: 95, s: 1.2 }, { x: 840, y: 55, s: 0.8 },
];

/** Screen-space backdrop: sky, sun/moon, stars and parallax clouds. */
function drawSkyLayer(g, theme, w, h, camX, camY, time) {
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, theme.sky[0]);
  sky.addColorStop(1, theme.sky[1]);
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);

  if (theme.stars) {
    for (let i = 0; i < 80; i++) {
      const x = (((seeded(i) * w * 1.4 - camX * 0.1) % w) + w) % w;
      const y = seeded(i + 100) * h * 0.8 - camY * 0.1;
      const size = 0.6 + seeded(i + 200) * 1.4;
      g.fillStyle = `rgba(255, 255, 240, ${0.35 + 0.65 * Math.abs(Math.sin(time * 1.3 + i))})`;
      fillEllipse(g, x, y, size, size);
    }
  }

  if (theme.sun) {
    const s = theme.sun;
    const x = w * s.fx;
    const y = h * s.fy - camY * 0.2;
    if (s.glow) {
      const glow = g.createRadialGradient(x, y, s.r * 0.6, x, y, s.r * 2.4);
      glow.addColorStop(0, 'rgba(255, 236, 153, 0.6)');
      glow.addColorStop(1, 'rgba(255, 236, 153, 0)');
      g.fillStyle = glow;
      fillEllipse(g, x, y, s.r * 2.4, s.r * 2.4);
    }
    g.fillStyle = s.color;
    fillEllipse(g, x, y, s.r, s.r);
  }

  if (theme.moon) {
    const m = theme.moon;
    const x = w * m.fx;
    const y = h * m.fy - camY * 0.2;
    const glow = g.createRadialGradient(x, y, m.r * 0.8, x, y, m.r * 2.2);
    glow.addColorStop(0, 'rgba(220, 228, 255, 0.35)');
    glow.addColorStop(1, 'rgba(220, 228, 255, 0)');
    g.fillStyle = glow;
    fillEllipse(g, x, y, m.r * 2.2, m.r * 2.2);
    g.fillStyle = m.color;
    fillEllipse(g, x, y, m.r, m.r);
    g.fillStyle = 'rgba(173, 181, 189, 0.55)';
    fillEllipse(g, x - 9, y - 6, 6, 6);
    fillEllipse(g, x + 8, y + 7, 4.5, 4.5);
    fillEllipse(g, x + 10, y - 10, 3, 3);
  }

  if (theme.snowfall) {
    g.fillStyle = 'rgba(255, 255, 255, 0.85)';
    for (let i = 0; i < 70; i++) {
      const speed = 18 + seeded(i + 300) * 30;
      const x = (((seeded(i) * w + Math.sin(time * 0.8 + i) * 18 - camX * 0.2) % w) + w) % w;
      const y = (((seeded(i + 50) * h + time * speed - camY * 0.2) % h) + h) % h;
      const size = 1 + seeded(i + 400) * 1.8;
      fillEllipse(g, x, y, size, size);
    }
  }

  if (theme.clouds) {
    g.fillStyle = theme.clouds;
    const span = w + 160;
    for (const c of CLOUDS) {
      const x = ((((c.x * (w / 960) + time * 8 * c.s - camX * 0.3) % span) + span) % span) - 80;
      const y = c.y - camY * 0.3;
      fillEllipse(g, x, y, 34 * c.s, 14 * c.s);
      fillEllipse(g, x + 22 * c.s, y - 8 * c.s, 22 * c.s, 14 * c.s);
      fillEllipse(g, x - 20 * c.s, y + 2, 20 * c.s, 10 * c.s);
    }
  }
}

// ---- World-space scenery behind the platforms ----
function drawMeadowHills(g, groundY) {
  for (const [x, rx, ry, color] of [
    [200, 280, 120, '#a9e34b'],
    [1150, 260, 110, '#a9e34b'],
    [720, 330, 135, '#94d82d'],
  ]) {
    g.fillStyle = color;
    fillEllipse(g, x, groundY + 20, rx, ry);
  }
}

function drawNightHills(g, groundY) {
  for (const [x, rx, ry, color] of [
    [150, 300, 130, '#1d2650'],
    [1100, 320, 140, '#1d2650'],
    [640, 360, 110, '#232e5e'],
  ]) {
    g.fillStyle = color;
    fillEllipse(g, x, groundY + 20, rx, ry);
  }
  // Pine silhouettes
  g.fillStyle = '#121a3a';
  for (const [x, hgt] of [[90, 90], [130, 70], [470, 80], [840, 95], [880, 70], [1190, 85]]) {
    g.beginPath();
    g.moveTo(x - hgt * 0.28, groundY + 2);
    g.lineTo(x, groundY - hgt);
    g.lineTo(x + hgt * 0.28, groundY + 2);
    g.closePath();
    g.fill();
  }
}

function drawMesas(g, groundY) {
  const mesa = (x, w, h, inset, color) => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(x, groundY + 2);
    g.lineTo(x + inset, groundY - h);
    g.lineTo(x + w - inset, groundY - h);
    g.lineTo(x + w, groundY + 2);
    g.closePath();
    g.fill();
  };
  // Far layer, then near layer
  mesa(-40, 360, 230, 40, '#f4a26b');
  mesa(560, 300, 300, 30, '#f4a26b');
  mesa(980, 320, 200, 50, '#f4a26b');
  mesa(180, 260, 140, 30, '#d9622b');
  mesa(760, 220, 110, 25, '#d9622b');
  mesa(1100, 200, 160, 30, '#d9622b');
}

function drawSnowPeaks(g, groundY, width) {
  const peak = (cx, half, h, color, cap) => {
    const top = groundY - h;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(cx - half, groundY + 2);
    g.lineTo(cx, top);
    g.lineTo(cx + half, groundY + 2);
    g.closePath();
    g.fill();
    // Snow cap with a zig-zag hem
    const k = 0.32;
    g.fillStyle = cap;
    g.beginPath();
    g.moveTo(cx, top);
    g.lineTo(cx + half * k, top + h * k);
    for (let j = 1; j <= 4; j++) {
      g.lineTo(cx + half * k - (half * 2 * k * j) / 4, top + h * k + (j % 2 ? 12 : 0));
    }
    g.closePath();
    g.fill();
  };
  // Far range, then near range
  for (const [fx, half, h] of [[0.08, 330, 420], [0.42, 380, 520], [0.8, 360, 450]]) peak(width * fx, half, h, '#b3cbe3', '#f4f9ff');
  for (const [fx, half, h] of [[0.25, 280, 300], [0.62, 300, 340], [0.97, 260, 260]]) peak(width * fx, half, h, '#86a9cb', '#ffffff');
  // Snowy pines
  for (const fx of [0.04, 0.07, 0.33, 0.52, 0.71, 0.74, 0.93]) {
    const x = width * fx;
    const hgt = 80 + seeded(fx * 100) * 40;
    g.fillStyle = '#2f5d50';
    for (let tier = 0; tier < 3; tier++) {
      const ty = groundY - hgt + tier * hgt * 0.28;
      const half = hgt * (0.14 + tier * 0.07);
      g.beginPath();
      g.moveTo(x - half, ty + hgt * 0.36);
      g.lineTo(x, ty);
      g.lineTo(x + half, ty + hgt * 0.36);
      g.closePath();
      g.fill();
    }
    g.fillStyle = 'rgba(255, 255, 255, 0.9)';
    fillEllipse(g, x, groundY - hgt + 8, 5, 4);
  }
}

function drawJungle(g, groundY, width) {
  // Stepped temple silhouette in the middle
  g.fillStyle = '#3e6b4c';
  const cx = width / 2;
  for (let step = 0; step < 6; step++) {
    const half = 420 - step * 62;
    const h = 70;
    g.fillRect(cx - half, groundY - (step + 1) * h, half * 2, h + 2);
  }
  g.fillStyle = '#2d5239';
  g.fillRect(cx - 40, groundY - 470, 80, 50); // shrine on top
  g.fillRect(cx - 34, groundY - 100, 68, 100); // doorway
  // Big tree trunks at the edges with leafy crowns
  for (const [x, w] of [[50, 70], [width - 120, 70], [width * 0.3, 40], [width * 0.7, 40]]) {
    g.fillStyle = '#4a3423';
    g.fillRect(x, groundY - 520, w, 522);
    g.fillStyle = '#2b6e3f';
    fillEllipse(g, x + w / 2, groundY - 540, w * 2.2, 70);
    fillEllipse(g, x + w / 2 - w, groundY - 500, w * 1.4, 50);
    fillEllipse(g, x + w / 2 + w, groundY - 505, w * 1.4, 50);
  }
  // Hanging vines from the canopy
  g.strokeStyle = '#2f9e44';
  g.lineWidth = 3;
  g.lineCap = 'round';
  for (let i = 0; i < 14; i++) {
    const x = ((i + 0.5) * width) / 14 + (seeded(i) - 0.5) * 60;
    const len = 120 + seeded(i + 20) * 220;
    g.beginPath();
    g.moveTo(x, 0);
    g.quadraticCurveTo(x + (seeded(i + 40) - 0.5) * 50, len / 2, x, len);
    g.stroke();
    g.fillStyle = '#51cf66';
    for (let k = 1; k <= 3; k++) fillEllipse(g, x + (k % 2 ? 5 : -5), (len * k) / 4, 6, 3);
  }
}

function drawScenery(g, theme, platforms) {
  const ground = platforms.find((pl) => pl.ground);
  theme.scenery?.(g, ground?.y ?? 0, ground?.w ?? 0);
}

function drawPlatformsThemed(g, theme, platforms) {
  const c = theme.platform;
  for (const pl of platforms) {
    if (pl.ground) {
      g.fillStyle = c.ground;
      g.fillRect(pl.x, pl.y, pl.w, pl.h);
      g.fillStyle = c.groundTop;
      g.fillRect(pl.x, pl.y, pl.w, 10);
      g.fillStyle = c.groundEdge;
      g.fillRect(pl.x, pl.y + 8, pl.w, 3);
    } else {
      g.fillStyle = 'rgba(0, 0, 0, 0.15)';
      roundRectPath(g, pl.x + 3, pl.y + 5, pl.w, pl.h, 6);
      g.fill();
      g.fillStyle = c.body;
      roundRectPath(g, pl.x, pl.y, pl.w, pl.h, 6);
      g.fill();
      g.fillStyle = c.top;
      roundRectPath(g, pl.x, pl.y, pl.w, 7, 4);
      g.fill();
      if (pl.move) {
        // Metal studs mark platforms that move
        g.fillStyle = 'rgba(255, 255, 255, 0.75)';
        for (const sx of [pl.x + 8, pl.x + pl.w - 8]) fillEllipse(g, sx, pl.y + 11, 2.5, 2.5);
      }
    }
  }
}

/**
 * Jump pads: a spring with a red cap and pulsing up-arrows.
 * `launchedAt[i]` (performance.now() ms) makes pad i pop up briefly.
 */
function drawPads(g, pads, time, launchedAt = []) {
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  pads.forEach((pad, i) => {
    const since = (now - (launchedAt[i] ?? -1e9)) / 1000;
    const pop = since < 0.35 ? Math.sin((since / 0.35) * Math.PI) : 0; // 0 -> 1 -> 0
    const { x, y, w } = pad;
    const capY = y - 13 - pop * 10;

    // Up-arrows hinting what it does
    g.lineWidth = 2.5;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (let k = 0; k < 2; k++) {
      const a = 0.2 + 0.35 * Math.max(0, Math.sin(time * 5 - k * 1.2));
      const cy = capY - 9 - k * 9;
      g.strokeStyle = `rgba(255, 255, 255, ${a})`;
      g.beginPath();
      g.moveTo(x + w / 2 - 7, cy + 4);
      g.lineTo(x + w / 2, cy - 2);
      g.lineTo(x + w / 2 + 7, cy + 4);
      g.stroke();
    }

    // Spring coil from the base up to the cap
    g.strokeStyle = '#adb5bd';
    g.lineWidth = 2.5;
    g.beginPath();
    const bottom = y - 5;
    const top = capY + 5;
    const turns = 6;
    for (let k = 0; k <= turns; k++) {
      const yy = bottom + ((top - bottom) * k) / turns;
      const xx = x + w / 2 + (k % 2 ? 9 : -9);
      if (k === 0) g.moveTo(x + w / 2, yy);
      else g.lineTo(k === turns ? x + w / 2 : xx, yy);
    }
    g.stroke();

    // Base plate and cap
    g.fillStyle = '#495057';
    roundRectPath(g, x, y - 5, w, 5, 2);
    g.fill();
    g.fillStyle = '#ff6b6b';
    roundRectPath(g, x - 2, capY, w + 4, 6, 3);
    g.fill();
    g.fillStyle = 'rgba(255, 255, 255, 0.55)';
    g.fillRect(x + 2, capY + 1, w - 4, 1.5);
  });
}

/** A little snail centred on (x, y), scaled by s — the "slowed" icon. */
function drawSnail(g, x, y, s = 1) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  // Body and eye stalks
  g.fillStyle = '#ffc078';
  roundRectPath(g, -11, 2, 24, 6, 3);
  g.fill();
  fillEllipse(g, 10, 2, 4, 4);
  g.strokeStyle = '#ffc078';
  g.lineWidth = 1.6;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(9, 0);
  g.lineTo(8, -7);
  g.moveTo(11, 0);
  g.lineTo(13, -7);
  g.stroke();
  g.fillStyle = '#343a40';
  fillEllipse(g, 8, -7, 1.3, 1.3);
  fillEllipse(g, 13, -7, 1.3, 1.3);
  // Shell with a spiral
  g.fillStyle = '#e8590c';
  fillEllipse(g, -2, -1, 8, 8);
  g.strokeStyle = '#ffe8cc';
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(-2, -1, 5, -Math.PI / 2, Math.PI * 1.2);
  g.stroke();
  g.beginPath();
  g.arc(-2, -1, 2, Math.PI, Math.PI * 2.6);
  g.stroke();
  g.restore();
}

/**
 * Sticky traps (mud, slush…): a lumpy puddle on the platform top with bubbles
 * and a snail warning. `splashAt[i]` (performance.now() ms) splashes trap i.
 */
function drawTraps(g, theme, traps, time, splashAt = []) {
  const c = theme.trap;
  if (!c) return;
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  traps.forEach((trap, i) => {
    const { x, y, w } = trap;
    const lumps = Math.max(3, Math.round(w / 22));
    g.fillStyle = c.goo;
    roundRectPath(g, x, y - 3, w, 10, 4);
    g.fill();
    for (let k = 0; k < lumps; k++) {
      const lx = x + ((k + 0.5) * w) / lumps;
      fillEllipse(g, lx, y - 2 + Math.sin(time * 2 + k * 1.7 + i) * 0.8, (w / lumps) * 0.7, 5);
    }
    // Drips over the front edge
    for (const f of [0.22, 0.58, 0.85]) {
      const len = 4 + Math.sin(time * 1.5 + f * 10 + i) * 2;
      fillEllipse(g, x + w * f, y + 7 + len / 2, 2.5, 2 + len / 2);
    }
    g.fillStyle = c.light;
    for (let k = 0; k < lumps; k += 2) fillEllipse(g, x + ((k + 0.35) * w) / lumps, y - 4, 4, 1.4);
    // Bubbles rising and popping
    g.lineWidth = 1.5;
    for (let k = 0; k < 3; k++) {
      const ph = (time * 0.7 + k * 0.33 + i * 0.21) % 1;
      g.strokeStyle = `rgba(${c.bubble}, ${0.9 * (1 - ph)})`;
      g.beginPath();
      g.arc(x + w * (0.2 + 0.3 * k), y - 5 - ph * 7, 1.5 + ph * 2.5, 0, Math.PI * 2);
      g.stroke();
    }
    drawSnail(g, x + w - 13, y - 10, 0.6);
    // Splash when someone steps in
    const since = (now - (splashAt[i] ?? -1e9)) / 1000;
    if (since < 0.45) {
      const k = since / 0.45;
      g.fillStyle = c.goo;
      for (let d = 0; d < 6; d++) {
        const a = Math.PI * (0.15 + (0.7 * d) / 5);
        const r = 10 + k * 26;
        fillEllipse(g, x + w / 2 + Math.cos(a) * r * 1.4, y - 4 - Math.sin(a) * r + k * k * 20, 3.5 * (1 - k) + 1, 3.5 * (1 - k) + 1);
      }
    }
  });
}

/** A small winged boot centred on (x, y), scaled by s. */
function drawBoot(g, x, y, s = 1) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  // Wing
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(-4, -6);
  g.quadraticCurveTo(-15, -14, -14, -2);
  g.quadraticCurveTo(-10, -5, -6, 0);
  g.closePath();
  g.fill();
  // Shaft + foot
  g.fillStyle = '#ff922b';
  g.beginPath();
  g.moveTo(-5, -9);
  g.lineTo(2, -9);
  g.lineTo(2, 0);
  g.quadraticCurveTo(10, 0, 10, 5);
  g.lineTo(-6, 5);
  g.closePath();
  g.fill();
  // Sole + stripe
  g.fillStyle = '#fff';
  g.fillRect(-6, 5, 16, 2.5);
  g.strokeStyle = '#e8590c';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(-5, -5);
  g.lineTo(2, -5);
  g.stroke();
  g.restore();
}

/** A little ghost centred on (x, y), scaled by s — the invisibility cloak icon. */
function drawGhost(g, x, y, s = 1) {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.fillStyle = 'rgba(255, 255, 255, 0.95)';
  g.beginPath();
  g.arc(0, -2, 8, Math.PI, 0);
  g.lineTo(8, 8);
  for (let k = 0; k < 3; k++) {
    const x1 = 8 - ((k + 0.5) * 16) / 3;
    const x2 = 8 - ((k + 1) * 16) / 3;
    g.quadraticCurveTo(x1, 12, x2, 8); // scalloped hem
  }
  g.closePath();
  g.fill();
  g.fillStyle = '#5f3dc4';
  fillEllipse(g, -3, -2, 1.6, 2.2);
  fillEllipse(g, 3, -2, 1.6, 2.2);
  g.restore();
}

/** Floating power-up pickup: speed boots (gold) or invisibility cloak (purple). */
function drawPowerupPickup(g, pu, time) {
  const x = pu.x;
  const y = pu.y + Math.sin(time * 3) * 4;
  const cloak = pu.kind === 'cloak';
  const rgb = cloak ? '177, 151, 252' : '255, 224, 102';
  const glow = g.createRadialGradient(x, y, 4, x, y, 30);
  glow.addColorStop(0, `rgba(${rgb}, 0.8)`);
  glow.addColorStop(1, `rgba(${rgb}, 0)`);
  g.fillStyle = glow;
  fillEllipse(g, x, y, 30, 30);
  g.fillStyle = 'rgba(255, 255, 255, 0.25)';
  g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(x, y, 16, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  if (cloak) drawGhost(g, x, y + Math.sin(time * 5) * 1.5, 1);
  else drawBoot(g, x + 2, y, 1);
  g.fillStyle = '#fff';
  for (let k = 0; k < 3; k++) {
    const a = time * 2 + k * 2.094;
    drawStar(g, x + Math.cos(a) * 23, y + Math.sin(a) * 23, 2.5 + Math.sin(time * 6 + k));
  }
}

/** Faint dashed track showing where each moving platform travels. */
function drawRails(g, platforms) {
  g.save();
  g.setLineDash([6, 8]);
  g.lineCap = 'round';
  for (const pl of platforms) {
    if (!pl.move) continue;
    const x1 = pl.x + pl.w / 2;
    const y1 = pl.y + pl.h / 2;
    const x2 = x1 + pl.move.dx;
    const y2 = y1 + pl.move.dy;
    g.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
    g.fillStyle = 'rgba(255, 255, 255, 0.45)';
    fillEllipse(g, x1, y1, 4, 4);
    fillEllipse(g, x2, y2, 4, 4);
  }
  g.restore();
}

/** Black-hole portals. `flash` (0–1) draws a bright ring after someone teleports. */
function drawPortalsThemed(g, portals, time, flash = 0) {
  portals.forEach((pt, i) => {
    const col = PORTAL_COLORS[(i >> 1) % PORTAL_COLORS.length];
    const r = pt.r;
    const spin = i % 2 ? -1 : 1;
    g.save();
    g.translate(pt.x, pt.y);

    const glow = g.createRadialGradient(0, 0, r * 0.5, 0, 0, r * 2);
    glow.addColorStop(0, `rgba(${col.glow}, 0.55)`);
    glow.addColorStop(1, `rgba(${col.glow}, 0)`);
    g.fillStyle = glow;
    g.beginPath();
    g.arc(0, 0, r * 2, 0, Math.PI * 2);
    g.fill();

    // Specks spiralling in
    for (let k = 0; k < 8; k++) {
      const ph = (time * 0.7 + k / 8) % 1;
      const rad = r * (1.9 - 1.2 * ph);
      const a = k * 0.785 + spin * ph * 5;
      g.fillStyle = `rgba(${col.speck}, ${ph * 0.9})`;
      fillEllipse(g, Math.cos(a) * rad, Math.sin(a) * rad, 2, 2);
    }

    // Swirling accretion arms
    g.lineCap = 'round';
    for (let k = 0; k < 3; k++) {
      const a0 = spin * time * 2.5 + k * 2.094;
      g.strokeStyle = k % 2 ? col.arm2 : col.arm1;
      g.lineWidth = 3;
      g.beginPath();
      g.arc(0, 0, r * 0.95, a0, a0 + 1.6);
      g.stroke();
      const a1 = -spin * time * 3.2 + k * 2.094;
      g.strokeStyle = col.inner;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(0, 0, r * 0.8, a1, a1 + 1.2);
      g.stroke();
    }

    // Event horizon
    const core = g.createRadialGradient(0, 0, 0, 0, 0, r * 0.7);
    core.addColorStop(0, '#000');
    core.addColorStop(0.75, '#0b0518');
    core.addColorStop(1, col.rim);
    g.fillStyle = core;
    g.beginPath();
    g.arc(0, 0, r * 0.7, 0, Math.PI * 2);
    g.fill();

    if (flash > 0) {
      g.strokeStyle = `rgba(255, 255, 255, ${flash})`;
      g.lineWidth = 4;
      g.beginPath();
      g.arc(0, 0, r * (1.8 - 0.8 * flash), 0, Math.PI * 2);
      g.stroke();
    }
    g.restore();
  });
}

/** Render a whole map (no players) scaled into a w×h canvas — used for lobby previews. */
function drawMapPreview(g, map, world, w, h) {
  const theme = themeFor(map);
  const s = Math.min(w / world.width, h / world.height);
  g.save();
  g.scale(s, s);
  drawSkyLayer(g, theme, world.width, world.height, 0, 0, 1.2);
  drawScenery(g, theme, map.platforms);
  drawRails(g, map.platforms);
  drawPlatformsThemed(g, theme, map.platforms);
  drawPads(g, map.pads || [], 0.4);
  drawTraps(g, theme, map.traps || [], 0.4);
  drawPortalsThemed(g, map.portals, 0.4);
  g.restore();
}
