'use strict';

// Cartoon characters. Each has its own color AND silhouette/face so they're
// easy to tell apart at a glance (and for colorblind players).
//
// Optional per-character drawing hooks, all given a geometry object `g`:
//   back(ctx, g)   – behind the body (ears, tufts…)
//   face(ctx, g)   – on the body, clipped to it (patches, stripes, muzzle…)
//   front(ctx, g)  – over the body, unclipped (floppy ears…)
// eyes: 'normal' | 'owl'; mouth: 'smile' | 'snout' | 'beak' | 'pig'
// lashes: true adds eyelashes; nose: color for 'snout' noses (default black)
const CHARACTERS = [
  {
    name: 'Panda', body: '#ffffff', dark: '#212529', light: '#e9ecef', feet: '#212529',
    back: roundEars('#212529', null), face: pandaPatches, mouth: 'snout', cheeks: false,
  },
  {
    name: 'Polar bear', body: '#eef5ff', dark: '#8299b3', light: '#ffffff',
    back: roundEars('#eef5ff', '#c5d3e3'), face: muzzle('#ffffff'), mouth: 'snout',
  },
  {
    name: 'Tiger', body: '#ff922b', dark: '#b4520a', light: '#fff4e6',
    back: roundEars('#ff922b', '#fff4e6'), face: tigerFace, mouth: 'snout',
  },
  {
    name: 'Owl', body: '#a47148', dark: '#5c3a1e', light: '#e9cfa9',
    back: tufts, face: owlBelly, eyes: 'owl', mouth: 'beak', cheeks: false, belly: false,
  },
  {
    name: 'Dog', body: '#e0a96d', dark: '#8a5a2b', light: '#fff1dc',
    face: dogFace, front: floppyEars, mouth: 'snout',
  },
  {
    name: 'Cat', body: '#b5bdc9', dark: '#5c677d', light: '#f1f3f5', nose: '#f06595',
    back: catEars, front: (ctx, g) => { whiskers(ctx, g); bow('#ff6b9e')(ctx, g); },
    mouth: 'snout', lashes: true,
  },
  {
    name: 'Bunny', body: '#eedcf5', dark: '#9c7bb0', light: '#ffffff', nose: '#f783ac',
    back: bunnyEars, front: flower, mouth: 'snout', lashes: true,
  },
  {
    name: 'Fox', body: '#f76707', dark: '#a33d00', light: '#fff4e6',
    back: foxEars, face: foxFace, mouth: 'snout', lashes: true,
  },
  {
    name: 'Pig', body: '#ffb3c6', dark: '#d6336c', light: '#ffe3ec',
    back: pigEars, front: bow('#845ef7'), mouth: 'pig', lashes: true,
  },
  {
    name: 'Penguin', body: '#2b3a55', dark: '#141c2b', light: '#ffffff', feet: '#ff922b',
    face: penguinFace, front: flippers, mouth: 'beak', belly: false, cheeks: false,
  },
];

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fillEllipse(ctx, x, y, rx, ry, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  ctx.fill();
}

function drawStar(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.45;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Feature hooks
// ---------------------------------------------------------------------------
function catEars(ctx, g) {
  for (const s of [-1, 1]) {
    const ex = s < 0 ? g.x + 3 : g.x + g.w - 3;
    ctx.fillStyle = g.c.body;
    ctx.beginPath();
    ctx.moveTo(ex, g.top + 10);
    ctx.lineTo(ex + s * 2, g.top - 9);
    ctx.lineTo(ex - s * 12, g.top + 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffa8c5';
    ctx.beginPath();
    ctx.moveTo(ex - s * 1, g.top + 6);
    ctx.lineTo(ex + s * 1, g.top - 4);
    ctx.lineTo(ex - s * 7, g.top + 3);
    ctx.closePath();
    ctx.fill();
  }
}

function roundEars(fill, inner) {
  return (ctx, g) => {
    for (const ex of [g.x + 6, g.x + g.w - 6]) {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(ex, g.top + 2, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (inner) {
        ctx.fillStyle = inner;
        fillEllipse(ctx, ex, g.top + 2, 3.2, 3.2);
      }
    }
  };
}

function tufts(ctx, g) {
  ctx.fillStyle = g.c.dark;
  for (const s of [-1, 1]) {
    const bx = s < 0 ? g.x + 4 : g.x + g.w - 4;
    ctx.beginPath();
    ctx.moveTo(bx - s * 2, g.top + 8);
    ctx.lineTo(bx - s * 3, g.top - 10);
    ctx.lineTo(bx + s * 1, g.top - 4);
    ctx.lineTo(bx + s * 4, g.top - 9);
    ctx.lineTo(bx + s * 9, g.top + 6);
    ctx.closePath();
    ctx.fill();
  }
}

function muzzle(color) {
  return (ctx, g) => {
    ctx.fillStyle = color;
    fillEllipse(ctx, g.ex, g.ey + 9, 8, 5.5);
  };
}

function pandaPatches(ctx, g) {
  ctx.fillStyle = '#212529';
  fillEllipse(ctx, g.ex - 6, g.ey + 0.5, 5.5, 7, 0.45);
  fillEllipse(ctx, g.ex + 6, g.ey + 0.5, 5.5, 7, -0.45);
}

function tigerFace(ctx, g) {
  ctx.strokeStyle = '#3b1f08';
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  // Forehead stripes
  for (const dx of [-5, 0, 5]) {
    ctx.moveTo(g.cx + dx, g.top - 1);
    ctx.lineTo(g.cx + dx * 0.8, g.top + (dx === 0 ? 5 : 3.5));
  }
  // Side stripes
  for (const dy of [12, 19]) {
    ctx.moveTo(g.x - 1, g.top + dy);
    ctx.lineTo(g.x + 6, g.top + dy + 1.5);
    ctx.moveTo(g.x + g.w + 1, g.top + dy);
    ctx.lineTo(g.x + g.w - 6, g.top + dy + 1.5);
  }
  ctx.stroke();
  muzzle('#fff4e6')(ctx, g);
}

function owlBelly(ctx, g) {
  ctx.fillStyle = g.c.light;
  fillEllipse(ctx, g.cx, g.top + g.bodyH * 0.8, g.w * 0.32, g.bodyH * 0.26);
  ctx.strokeStyle = g.c.body;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (const [dx, dy] of [[-4, 21], [4, 21], [0, 25]]) {
    ctx.moveTo(g.cx + dx - 2.5, g.top + dy);
    ctx.lineTo(g.cx + dx, g.top + dy + 2);
    ctx.lineTo(g.cx + dx + 2.5, g.top + dy);
  }
  ctx.stroke();
}

function dogFace(ctx, g) {
  // Patch over one eye
  ctx.fillStyle = '#a86b33';
  fillEllipse(ctx, g.ex + 6, g.ey - 1, 6.5, 7);
  muzzle('#fff1dc')(ctx, g);
}

function floppyEars(ctx, g) {
  ctx.fillStyle = '#8a5a2b';
  const flap = Math.sin(g.t * 10) * (g.running ? 0.15 : 0.03);
  fillEllipse(ctx, g.x + 1, g.top + 11, 5, 11, 0.25 + flap);
  fillEllipse(ctx, g.x + g.w - 1, g.top + 11, 5, 11, -0.25 - flap);
}

function bunnyEars(ctx, g) {
  for (const s of [-1, 1]) {
    const ex = g.cx + s * 7;
    ctx.fillStyle = g.c.body;
    ctx.beginPath();
    ctx.ellipse(ex, g.top - 9, 5, 13, s * 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fcc2d7';
    fillEllipse(ctx, ex, g.top - 8, 2.4, 9, s * 0.15);
  }
}

function foxEars(ctx, g) {
  for (const s of [-1, 1]) {
    const bx = s < 0 ? g.x + 3 : g.x + g.w - 3;
    ctx.fillStyle = g.c.body;
    ctx.beginPath();
    ctx.moveTo(bx, g.top + 10);
    ctx.lineTo(bx + s * 1, g.top - 13);
    ctx.lineTo(bx - s * 13, g.top + 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Dark tip
    ctx.fillStyle = '#212529';
    ctx.beginPath();
    ctx.moveTo(bx + s * 1, g.top - 13);
    ctx.lineTo(bx - s * 4, g.top - 4);
    ctx.lineTo(bx + s * 0.5, g.top - 4);
    ctx.closePath();
    ctx.fill();
  }
}

function foxFace(ctx, g) {
  ctx.fillStyle = '#fff';
  fillEllipse(ctx, g.ex - 7, g.ey + 9, 9, 7);
  fillEllipse(ctx, g.ex + 7, g.ey + 9, 9, 7);
}

function pigEars(ctx, g) {
  ctx.fillStyle = g.c.body;
  for (const s of [-1, 1]) {
    const bx = s < 0 ? g.x + 4 : g.x + g.w - 4;
    ctx.beginPath();
    ctx.moveTo(bx - s * 1, g.top + 7);
    ctx.lineTo(bx + s * 2, g.top - 7);
    ctx.lineTo(bx + s * 12, g.top + 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

function penguinFace(ctx, g) {
  // White heart-shaped face and belly
  ctx.fillStyle = '#fff';
  fillEllipse(ctx, g.ex - 5, g.ey + 2, 8.5, 9);
  fillEllipse(ctx, g.ex + 5, g.ey + 2, 8.5, 9);
  fillEllipse(ctx, g.cx, g.top + g.bodyH * 0.8, g.w * 0.3, g.bodyH * 0.3);
}

function flippers(ctx, g) {
  ctx.fillStyle = g.c.body;
  const flap = g.running ? Math.sin(g.t * 18) * 0.25 : 0;
  fillEllipse(ctx, g.x - 1, g.top + 17, 3.5, 9, 0.35 + flap);
  fillEllipse(ctx, g.x + g.w + 1, g.top + 17, 3.5, 9, -0.35 - flap);
}

function whiskers(ctx, g) {
  ctx.strokeStyle = 'rgba(52, 58, 64, 0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const s of [-1, 1]) {
    for (const dy of [-1.5, 1.5]) {
      ctx.moveTo(g.ex + s * 6, g.ey + 8 + dy);
      ctx.lineTo(g.ex + s * 14, g.ey + 7 + dy * 2.2);
    }
  }
  ctx.stroke();
}

// A bow perched on the top corner of the head (the side away from the face)
function bow(color) {
  return (ctx, g) => {
    const bx = g.cx - g.f * 11;
    const by = g.top + 1;
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.lineWidth = 1;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + s * 8, by - 5);
      ctx.lineTo(bx + s * 8, by + 5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    fillEllipse(ctx, bx, by, 2.6, 2.6);
  };
}

function flower(ctx, g) {
  const fx = g.cx - g.f * 9;
  const fy = g.top + 1;
  ctx.fillStyle = '#fff';
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    fillEllipse(ctx, fx + Math.cos(a) * 3.4, fy + Math.sin(a) * 3.4, 2.6, 2.6);
  }
  ctx.fillStyle = '#fcc419';
  fillEllipse(ctx, fx, fy, 2.2, 2.2);
}

// ---------------------------------------------------------------------------
// Main draw
// ---------------------------------------------------------------------------

/**
 * Draw a character with its top-left at (x, y) inside a w×h box.
 * opts: facing (1|-1), time (s), running, airborne, it, frozen, immune
 */
function drawCharacter(ctx, charIndex, x, y, w, h, opts = {}) {
  const c = CHARACTERS[charIndex % CHARACTERS.length];
  const t = opts.time || 0;
  const f = opts.facing || 1;
  const top = y + 4;
  const bodyH = h - 8;
  const cx = x + w / 2;
  const g = {
    c, x, w, top, bodyH, cx, f, t, running: opts.running,
    ex: cx + f * 3,
    ey: top + bodyH * 0.36,
  };
  const { ex, ey } = g;

  ctx.save();
  if (opts.immune && Math.floor(t * 10) % 2 === 0) ctx.globalAlpha *= 0.5; // multiply, so invisibility still applies

  // Feet
  const swing = opts.running ? Math.sin(t * 22) * 4 : 0;
  const lift = opts.airborne ? -3 : 0;
  ctx.fillStyle = c.feet || c.dark;
  fillEllipse(ctx, cx - 8 + swing, y + h - 4 + lift, 7, 4);
  fillEllipse(ctx, cx + 8 - swing, y + h - 4 - lift * 0.3, 7, 4);

  ctx.lineWidth = 2;
  ctx.strokeStyle = c.dark;
  c.back?.(ctx, g);

  // Body (glows red when IT)
  roundRectPath(ctx, x, top, w, bodyH, 13);
  ctx.fillStyle = c.body;
  if (opts.it) {
    ctx.shadowColor = '#ff2d2d';
    ctx.shadowBlur = 14 + Math.sin(t * 8) * 6;
  }
  ctx.fill();
  ctx.shadowBlur = 0;

  // Belly + face markings, clipped to the body
  ctx.save();
  ctx.clip();
  if (c.belly !== false) {
    ctx.fillStyle = c.light;
    fillEllipse(ctx, cx, top + bodyH * 0.74, w * 0.28, bodyH * 0.17);
  }
  c.face?.(ctx, g);
  ctx.restore();

  roundRectPath(ctx, x, top, w, bodyH, 13);
  ctx.lineWidth = opts.it ? 3 : 2;
  ctx.strokeStyle = opts.it ? '#e03131' : c.dark;
  ctx.stroke();

  c.front?.(ctx, g);

  // Eyes look the way the character faces
  const owl = c.eyes === 'owl';
  const eyeDx = owl ? 7 : 6;
  ctx.fillStyle = '#fff';
  ctx.lineWidth = owl ? 2.5 : 1;
  ctx.strokeStyle = owl ? '#ffa94d' : '#333';
  for (const dx of [-eyeDx, eyeDx]) {
    ctx.beginPath();
    if (owl) ctx.arc(ex + dx, ey, 6, 0, Math.PI * 2);
    else ctx.ellipse(ex + dx, ey, 4.5, 5.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = '#222';
  ctx.strokeStyle = '#222';
  if (opts.frozen) {
    ctx.lineWidth = 1.6;
    for (const dx of [-eyeDx, eyeDx]) {
      ctx.beginPath();
      ctx.moveTo(ex + dx - 2.5, ey - 2.5);
      ctx.lineTo(ex + dx + 2.5, ey + 2.5);
      ctx.moveTo(ex + dx + 2.5, ey - 2.5);
      ctx.lineTo(ex + dx - 2.5, ey + 2.5);
      ctx.stroke();
    }
  } else {
    const pr = owl ? 3.2 : 2.3;
    for (const dx of [-eyeDx, eyeDx]) fillEllipse(ctx, ex + dx + f * 1.8, ey + 0.5, pr, owl ? pr : 2.9);
    if (c.lashes) {
      // Three little lashes flicking up from the outer top of each eye
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const s of [-1, 1]) {
        // s = which eye (-1 left, 1 right); lashes sit on the side away from the nose
        for (const deg of [25, 50, 75]) {
          const a = (deg * Math.PI) / 180;
          const px = ex + s * eyeDx + s * Math.cos(a) * 4.5;
          const py = ey - Math.sin(a) * 5.5;
          ctx.moveTo(px, py);
          ctx.lineTo(px + s * Math.cos(a) * 3, py - Math.sin(a) * 3);
        }
      }
      ctx.stroke();
    }
  }

  // Cheeks
  if (c.cheeks !== false) {
    ctx.fillStyle = 'rgba(255, 110, 150, 0.45)';
    fillEllipse(ctx, ex - 11, ey + 7, 3, 2);
    fillEllipse(ctx, ex + 11, ey + 7, 3, 2);
  }

  // Mouth
  if (c.mouth === 'beak') {
    ctx.fillStyle = '#ff922b';
    const open = opts.it || opts.frozen ? 2.5 : 0;
    ctx.beginPath();
    ctx.moveTo(ex - 3.5, ey + 5);
    ctx.lineTo(ex + 3.5, ey + 5);
    ctx.lineTo(ex, ey + 11 + open);
    ctx.closePath();
    ctx.fill();
  } else if (c.mouth === 'pig') {
    ctx.fillStyle = '#ff8fab';
    ctx.strokeStyle = c.dark;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(ex, ey + 8, 6.5, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#a61e4d';
    const nostril = opts.frozen ? 1.6 : 1.2;
    fillEllipse(ctx, ex - 2.3, ey + 8, nostril, 1.8);
    fillEllipse(ctx, ex + 2.3, ey + 8, nostril, 1.8);
  } else {
    if (c.mouth === 'snout') {
      ctx.fillStyle = c.nose || '#222';
      fillEllipse(ctx, ex, ey + 6.5, 2.8, 1.9);
    }
    const my = ey + 9;
    ctx.strokeStyle = '#4a1d1d';
    ctx.fillStyle = '#4a1d1d';
    ctx.lineWidth = 1.8;
    if (opts.frozen) {
      fillEllipse(ctx, ex, my + 1.5, 2.5, 3);
    } else if (opts.it) {
      ctx.beginPath();
      ctx.arc(ex, my - 1, 5, 0.1 * Math.PI, 0.9 * Math.PI);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(ex, my - 2, 4, 0.2 * Math.PI, 0.8 * Math.PI);
      ctx.stroke();
    }
  }

  // Dizzy stars when frozen
  if (opts.frozen) {
    ctx.fillStyle = '#ffe066';
    for (let i = 0; i < 3; i++) {
      const a = t * 6 + i * ((Math.PI * 2) / 3);
      drawStar(ctx, cx + Math.cos(a) * 16, y - 4 + Math.sin(a) * 4, 4);
    }
  }

  ctx.restore();
}
