'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// Game constants (world units are "logical pixels"; clients scale to fit)
// ---------------------------------------------------------------------------
const WORLD = { width: 1248, height: 702 };
const VIEW = { width: 960, height: 540 }; // what each player sees; the camera follows them
const PLAYER_W = 34;
const PLAYER_H = 38;
const PORTAL_REARM_DIST = 10; // must move this far beyond the exit's radius before it works again

// Maps use WORLD unless they set their own `world` size. Platform tiers are 85px apart (max jump is ~138px)
// and staggered so every tier is reachable. Black-hole portals come in linked
// pairs (0<->1, 2<->3, …): touch the middle of one and you pop out of the other
// with your speed intact. `theme` picks the look in public/maps.js.
const groundFor = (world) => ({ x: 0, y: world.height - 40, w: world.width, h: 40, ground: true });
const ground = groundFor(WORLD);
const BIG_WORLD = { width: 1600, height: 900 };
const bigGround = groundFor(BIG_WORLD);
// `move` makes a platform glide back and forth: it eases from (x, y) to
// (x + dx, y + dy) and back once every `period` seconds.
const plat = (x, y, w, move) => ({ x, y, w, h: 16, ...(move && { move }) });
const portalOn = (x, platformY) => ({ x, y: platformY - 30, r: 24 });
// Jump pads sit on a platform's top surface and launch you upward.
// Launch height is power² / (2 × GRAVITY): 1300 ≈ 385px, about four tiers.
const PAD_W = 40;
const padOn = (x, platformY, power = 1300) => ({ x, y: platformY, w: PAD_W, power });
// Traps are sticky patches on a platform's top surface: step in one and you're
// slowed for a few seconds.
const trapOn = (x, platformY, w) => ({ x, y: platformY, w });
const mirror = (list) => list.map((pl) => plat(WORLD.width - pl.x - pl.w, pl.y, pl.w));

const NIGHT_STAIRS = [plat(40, 577, 140), plat(200, 492, 140), plat(40, 407, 140), plat(200, 322, 140), plat(40, 237, 140)];

const MAPS = {
  meadow: {
    name: 'Meadow',
    theme: 'meadow',
    platforms: [
      ground,
      plat(90, 577, 170), plat(540, 577, 170), plat(990, 577, 170),
      plat(300, 492, 180), plat(770, 492, 180),
      plat(60, 407, 160), plat(540, 407, 170), plat(1030, 407, 160),
      plat(280, 322, 170), plat(800, 322, 170),
      plat(60, 237, 150), plat(549, 237, 150), plat(1040, 237, 150),
      plat(300, 152, 160), plat(790, 152, 160),
      plat(712, 600, 56, { dx: 0, dy: -420, period: 6 }), // elevator up the middle gap
      plat(468, 152, 110, { dx: 205, dy: 0, period: 4 }), // shuttle between the top platforms
    ],
    portals: [
      portalOn(60, 662), // ground, far left
      portalOn(870, 152), // top-right platform
    ],
    pads: [
      padOn(280, 662), // ground, left of the middle
      padOn(1090, 407), // right ledge -> top level
    ],
    powerupSpots: [[175, 577], [1075, 577], [625, 407], [140, 407], [624, 237], [380, 152]],
    spawns: [120, 1090, 420, 790, 200, 960, 560, 650],
  },
  night: {
    name: 'Starry Night',
    theme: 'night',
    platforms: [
      ground,
      // Two mirrored staircases around a central tower
      ...NIGHT_STAIRS,
      ...mirror(NIGHT_STAIRS),
      plat(470, 577, 308),
      plat(560, 492, 128),
      plat(380, 407, 150), plat(718, 407, 150),
      plat(560, 322, 128),
      plat(380, 237, 150), plat(718, 237, 150),
      plat(560, 152, 128),
      // Twin sky shuttles from the staircase tops to the central tower
      plat(190, 152, 120, { dx: 230, dy: 0, period: 5 }),
      plat(938, 152, 120, { dx: -230, dy: 0, period: 5 }),
    ],
    portals: [
      // Two pairs that cross over: top-left <-> bottom-right, top-right <-> bottom-left
      portalOn(110, 237), portalOn(1188, 662),
      portalOn(1138, 237), portalOn(60, 662),
    ],
    pads: [
      padOn(604, 662), // tower express: ground straight up the central tower
    ],
    powerupSpots: [[520, 577], [455, 407], [793, 407], [624, 322], [270, 492], [978, 492]],
    spawns: [300, 920, 520, 700, 180, 1040, 410, 810],
  },
  canyon: {
    name: 'Sunset Canyon',
    theme: 'canyon',
    platforms: [
      ground,
      plat(0, 577, 230), plat(520, 577, 208), plat(1018, 577, 230),
      plat(300, 492, 200), plat(748, 492, 200),
      plat(0, 407, 200), plat(524, 407, 200), plat(1048, 407, 200),
      plat(250, 322, 240), plat(758, 322, 240),
      plat(0, 237, 180), plat(524, 237, 200), plat(1068, 237, 180),
      plat(330, 152, 140), plat(778, 152, 140),
      plat(160, 80, 130, { dx: 800, dy: 0, period: 8 }), // raft sweeping across the top
    ],
    portals: [
      portalOn(624, 662), // middle of the ground, under a ledge
      portalOn(90, 237), // high ledge on the left wall
    ],
    pads: [
      padOn(232, 662), // near the left wall
      padOn(976, 662), // near the right wall
    ],
    powerupSpots: [[115, 577], [1133, 577], [624, 407], [370, 322], [878, 322], [624, 237]],
    spawns: [120, 1120, 380, 870, 300, 1040, 490, 740],
  },
  frosty: {
    name: 'Frosty Peaks',
    theme: 'snow',
    world: BIG_WORLD,
    platforms: [
      bigGround,
      plat(100, 775, 200), plat(700, 775, 200), plat(1300, 775, 200),
      plat(380, 690, 180), plat(1040, 690, 180),
      plat(60, 605, 180), plat(650, 605, 300), plat(1360, 605, 180),
      plat(300, 520, 180), plat(1120, 520, 180),
      plat(40, 435, 170), plat(560, 435, 160), plat(880, 435, 160), plat(1390, 435, 170),
      plat(270, 350, 180), plat(1150, 350, 180),
      plat(60, 265, 160), plat(700, 265, 200), plat(1380, 265, 160),
      plat(330, 180, 170), plat(1100, 180, 170),
      plat(720, 95, 160), // the summit
      plat(520, 520, 110, { dx: 450, dy: 0, period: 6 }), // shuttle across the middle
      plat(520, 180, 100, { dx: 460, dy: 0, period: 5 }), // shuttle under the summit
    ],
    portals: [
      // Two crossing pairs: ground left <-> high right, ground right <-> high left
      portalOn(400, 860), portalOn(1460, 265),
      portalOn(1250, 860), portalOn(140, 265),
    ],
    pads: [
      padOn(80, 860, 1500), // left wall -> left ledge, five tiers up
      padOn(1480, 860, 1500), // right wall -> right ledge
    ],
    traps: [
      trapOn(1080, 860, 110), // slush on the ground
      trapOn(760, 605, 80), // middle of the big ledge
      trapOn(320, 350, 90),
    ],
    powerupSpots: [[200, 775], [700, 605], [1450, 605], [130, 435], [800, 265], [800, 95], [390, 350], [1240, 350]],
    spawns: [180, 1340, 520, 1000, 290, 900, 640, 1410],
  },
  jungle: {
    name: 'Jungle Ruins',
    theme: 'jungle',
    world: BIG_WORLD,
    platforms: [
      bigGround,
      plat(60, 775, 160), plat(470, 775, 240), plat(890, 775, 240), plat(1380, 775, 160),
      plat(240, 690, 150), plat(1210, 690, 150),
      plat(30, 605, 170), plat(560, 605, 480), plat(1400, 605, 170), // long stone bridge in the middle
      plat(250, 520, 160), plat(1190, 520, 160),
      plat(40, 435, 160), plat(500, 435, 180), plat(920, 435, 180), plat(1400, 435, 160),
      plat(250, 350, 170), plat(1180, 350, 170),
      plat(40, 265, 150), plat(600, 265, 400), plat(1410, 265, 150), // temple roof
      plat(260, 180, 160), plat(720, 180, 160), plat(1180, 180, 160),
      plat(760, 840, 80, { dx: 0, dy: -560, period: 8 }), // lift up through the temple
      plat(440, 95, 120, { dx: 600, dy: 0, period: 7 }), // glider across the canopy
    ],
    portals: [
      portalOn(150, 860), portalOn(950, 265), // ground left <-> temple roof
      portalOn(1450, 860), portalOn(115, 265), // ground right <-> high left
    ],
    pads: [
      padOn(300, 860), // ground -> left ledges
      padOn(1260, 860), // ground -> right ledges
    ],
    traps: [
      trapOn(690, 860, 130), // mud pit on the ground
      trapOn(600, 605, 90), // both ends of the bridge
      trapOn(910, 605, 90),
    ],
    powerupSpots: [[140, 775], [1460, 775], [800, 605], [590, 435], [1010, 435], [330, 180], [1260, 180], [800, 180]],
    spawns: [220, 1360, 560, 1080, 420, 1180, 960, 1530],
  },
};
for (const map of Object.values(MAPS)) map.world ??= WORLD;
let mapId = 'meadow';
const currentMap = () => MAPS[mapId];
const currentWorld = () => currentMap().world;

// Live platform positions for the current map (moving ones change every tick)
let livePlatforms = [];
let liveMapId = null;

function updatePlatforms(t) {
  const defs = currentMap().platforms;
  if (liveMapId !== mapId) {
    livePlatforms = defs.map((d) => ({ ...d, prevX: d.x, prevY: d.y, dx: 0, dy: 0 }));
    liveMapId = mapId;
  }
  defs.forEach((d, i) => {
    const pl = livePlatforms[i];
    pl.prevX = pl.x;
    pl.prevY = pl.y;
    if (d.move) {
      const k = (1 - Math.cos((2 * Math.PI * t) / d.move.period)) / 2; // 0 -> 1 -> 0, eased
      pl.x = d.x + d.move.dx * k;
      pl.y = d.y + d.move.dy * k;
    }
    pl.dx = pl.x - pl.prevX;
    pl.dy = pl.y - pl.prevY;
  });
}

const TICK_MS = 1000 / 60;
const DT = TICK_MS / 1000;
const GRAVITY = 2200;
const MAX_FALL = 1100;
const RUN_SPEED = 320;
const ACCEL_GROUND = 3000;
const ACCEL_AIR = 1800;
const FRICTION_GROUND = 2600;
const FRICTION_AIR = 600;
const JUMP_VELOCITY = 780;
const JUMP_CUT = 0.45; // releasing jump early caps upward speed -> short hop
const COYOTE_TIME = 0.08; // can still jump just after walking off a ledge
const JUMP_BUFFER = 0.1; // jump pressed just before landing still counts
const TAG_INSET = 3; // shrink hitboxes slightly so tags feel fair

const MAX_PLAYERS = 8;
const CHARACTER_COUNT = 10; // must match CHARACTERS in public/characters.js
const ROUND_OPTIONS = [30, 60, 90, 120, 180]; // choices offered in the lobby
let roundSeconds = Number(process.env.ROUND_SECONDS) || 60;
const READY_SECONDS = 3;
const FREEZE_SECONDS = 1; // newly-tagged player can't move
const IMMUNE_SECONDS = 2; // tagger can't be tagged straight back

// Dash button: one button, two moves. On the ground it's a slide (fast, low
// hitbox); in the air it's a short horizontal burst that ignores gravity.
const DASH_COOLDOWN = 1.5;
const SLIDE_SECONDS = 0.35;
const SLIDE_SPEED = 600; // eases down to SLIDE_END_SPEED over the slide
const SLIDE_END_SPEED = 380;
const SLIDE_H = 22; // hitbox height while sliding
const AIRDASH_SECONDS = 0.18;
const AIRDASH_SPEED = 720;

// Power-ups: one on the map at a time, at a random spot from the map's powerupSpots,
// randomly either speed boots (run faster) or an invisibility cloak.
const BOOTS_SECONDS = 6;
const CLOAK_SECONDS = 5; // invisibility cloak: others only see a faint shimmer
const POWERUP_KINDS = ['boots', 'cloak'];
const BOOTS_SPEED_MULT = 1.5;
const POWERUP_FIRST_DELAY = 5; // seconds into the round before the first one appears
const POWERUP_RESPAWN = 8; // seconds after a pickup before the next one appears
const POWERUP_R = 16; // pickup radius
const SLOW_SECONDS = 3; // how long a trap slows you after you step out of it
const SLOW_MULT = 0.5; // running, sliding and air-dash speed while slowed
const MOMENTUM_DECAY = 1400; // how fast leftover dash speed bleeds back to running speed

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const clients = new Set(); // every open socket, joined or not
const players = new Map(); // id -> player (joined sockets only)
// Session win counts, keyed by name so a phone that drops and rejoins keeps its record.
// Reset when the server restarts.
const wins = new Map(); // name -> wins
let lastResults = null; // per-player stats for the round that just ended
let powerup = null; // { x, y, kind } while one is on the map
let powerupSpotIndex = -1;
let nextPowerupAt = Infinity;
let nextId = 1;

let phase = 'lobby'; // lobby | ready | playing | ended
let itId = null;
let loserId = null;
let loserName = null;
let phaseEndsAt = 0;

const nowSec = () => performance.now() / 1000;
const NO_INPUT = { left: false, right: false, jump: false, dash: false };

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

function activePlayers() {
  return [...players.values()].filter((p) => !p.waiting);
}

function roomMessage() {
  return {
    t: 'room',
    phase,
    roundSeconds,
    mapId,
    itId,
    loserId,
    loserName,
    results: phase === 'ended' ? lastResults : null,
    players: [...players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      char: p.char,
      waiting: p.waiting,
      wins: wins.get(p.name) ?? 0,
    })),
  };
}

function broadcastRoom() {
  broadcast(roomMessage());
}

function snapshot() {
  const t = nowSec();
  return {
    t: 'snap',
    st: performance.now(),
    phase,
    timeLeft: phase === 'ended' ? 0 : Math.max(0, phaseEndsAt - t),
    itId,
    // [index, x, y] for each moving platform
    pu: powerup, // { x, y, kind } or null
    mp: livePlatforms.flatMap((pl, i) => (pl.move ? [[i, Math.round(pl.x * 10) / 10, Math.round(pl.y * 10) / 10]] : [])),
    players: activePlayers().map((p) => ({
      id: p.id,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      vx: Math.round(p.vx),
      f: p.facing,
      g: p.onGround ? 1 : 0,
      fr: t < p.frozenUntil ? 1 : 0,
      im: t < p.immuneUntil ? 1 : 0,
      tp: p.teleports,
      jc: p.jumps, // jump counter, lets clients play a jump sound
      bc: p.boosts, // jump-pad launch counter
      sp: Math.max(0, Math.round((p.speedUntil - t) * 10) / 10), // speed boots time left (s)
      sl: Math.max(0, Math.round((p.slowUntil - t) * 10) / 10), // slowed by a trap, time left (s)
      tc: p.trapHits, // trap counter, lets clients splash + play a sound
      iv: Math.max(0, Math.round((p.cloakUntil - t) * 10) / 10), // invisibility time left (s)
      dm: p.dashMode === 'slide' ? 1 : p.dashMode === 'air' ? 2 : 0,
      dc: p.dashes,
      cd: Math.max(0, Math.round((p.dashReadyAt - t) * 20) / 20), // dash cooldown left (s)
    })),
  };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function resetBody(p, spawnX) {
  p.x = spawnX;
  p.y = currentMap().platforms[0].y - PLAYER_H;
  p.vx = 0;
  p.vy = 0;
  p.onGround = true;
  p.facing = spawnX < currentWorld().width / 2 ? 1 : -1;
  p.coyote = 0;
  p.jumpBuffer = 0;
  p.jumpWasDown = true; // holding jump through the countdown shouldn't auto-jump
  p.frozenUntil = 0;
  p.immuneUntil = 0;
  p.portalLock = -1; // index of the portal we just exited (ignored until we leave it)
  p.standingOn = -1; // index of the platform underfoot, so moving ones can carry us
  p.boosted = false; // launched by a jump pad (releasing jump mustn't cut it short)
  p.boosts = p.boosts ?? 0; // counter so clients can animate the pad + play a sound
  p.speedUntil = 0; // speed boots active until this time
  p.cloakUntil = 0; // invisible until this time
  p.slowUntil = 0; // slowed by a trap until this time
  p.inTrap = false;
  p.trapHits = p.trapHits ?? 0;
  p.jumps = p.jumps ?? 0;
  p.dashMode = null; // null | 'slide' | 'air'
  p.dashReadyAt = 0;
  p.dashWasDown = true;
  p.dashes = p.dashes ?? 0; // counter so clients can play the dash sound
  p.teleports = p.teleports ?? 0; // bumps on every teleport so clients skip interpolating the jump
}

function checkPads(p) {
  if (!p.onGround) return;
  for (const pad of currentMap().pads || []) {
    const onTop = Math.abs(p.y + PLAYER_H - pad.y) < 1;
    const overlapsX = p.x + PLAYER_W > pad.x + 6 && p.x < pad.x + pad.w - 6;
    if (!onTop || !overlapsX) continue;
    p.vy = -pad.power;
    p.onGround = false;
    p.standingOn = -1;
    p.coyote = 0; // otherwise a coyote-time jump next tick would replace the launch
    p.jumpBuffer = 0;
    p.boosted = true;
    p.boosts++;
    if (p.dashMode === 'slide') p.dashMode = null;
    return;
  }
}

// Standing in a trap keeps you slowed; the slow wears off SLOW_SECONDS after you leave it
function checkTraps(p, t) {
  let inTrap = false;
  if (p.onGround) {
    for (const trap of currentMap().traps || []) {
      const onTop = Math.abs(p.y + PLAYER_H - trap.y) < 1;
      const overlapsX = p.x + PLAYER_W > trap.x + 6 && p.x < trap.x + trap.w - 6;
      if (onTop && overlapsX) inTrap = true;
    }
  }
  if (inTrap) {
    if (!p.inTrap) p.trapHits++;
    p.slowUntil = t + SLOW_SECONDS;
  }
  p.inTrap = inTrap;
}

function distToPortal(p, portal) {
  return Math.hypot(p.x + PLAYER_W / 2 - portal.x, p.y + PLAYER_H / 2 - portal.y);
}

function checkPortals(p) {
  const PORTALS = currentMap().portals;
  if (p.portalLock >= 0 && distToPortal(p, PORTALS[p.portalLock]) > PORTALS[p.portalLock].r + PORTAL_REARM_DIST) {
    p.portalLock = -1;
  }
  for (let i = 0; i < PORTALS.length; i++) {
    if (i === p.portalLock || distToPortal(p, PORTALS[i]) >= PORTALS[i].r) continue;
    const exitIndex = i ^ 1;
    const exit = PORTALS[exitIndex];
    p.x = Math.max(0, Math.min(currentWorld().width - PLAYER_W, exit.x - PLAYER_W / 2));
    p.y = exit.y - PLAYER_H / 2;
    p.onGround = false;
    p.portalLock = exitIndex;
    p.teleports++;
    return;
  }
}

function updatePowerup(active, t) {
  const spots = currentMap().powerupSpots || [];
  if (!powerup && t >= nextPowerupAt && spots.length) {
    // Pick a different spot from last time
    let i = Math.floor(Math.random() * spots.length);
    if (spots.length > 1 && i === powerupSpotIndex) i = (i + 1) % spots.length;
    powerupSpotIndex = i;
    const [x, platformY] = spots[i];
    powerup = { x, y: platformY - 22, kind: pickRandom(POWERUP_KINDS) };
  }
  if (!powerup) return;
  for (const p of active) {
    const cx = Math.max(p.x, Math.min(powerup.x, p.x + PLAYER_W)); // closest point on the player box
    const cy = Math.max(p.y, Math.min(powerup.y, p.y + PLAYER_H));
    if (Math.hypot(powerup.x - cx, powerup.y - cy) > POWERUP_R) continue;
    if (powerup.kind === 'boots') p.speedUntil = t + BOOTS_SECONDS;
    else p.cloakUntil = t + CLOAK_SECONDS;
    broadcast({ t: 'powerup', id: p.id, kind: powerup.kind });
    powerup = null;
    nextPowerupAt = t + POWERUP_RESPAWN;
    return;
  }
}

function startRound() {
  const list = [...players.values()];
  if (list.length < 2) return false;
  const spawns = shuffle(currentMap().spawns.slice());
  list.forEach((p, i) => {
    p.waiting = false;
    p.itTime = 0;
    p.tags = 0;
    resetBody(p, spawns[i]);
  });
  itId = pickRandom(list).id;
  loserId = null;
  loserName = null;
  phase = 'ready';
  phaseEndsAt = nowSec() + READY_SECONDS;
  powerup = null;
  powerupSpotIndex = -1;
  nextPowerupAt = phaseEndsAt + POWERUP_FIRST_DELAY;
  updatePlatforms(nowSec()); // so the first snapshot has this map's platforms
  broadcastRoom();
  broadcast(snapshot());
  return true;
}

function toLobby() {
  phase = 'lobby';
  itId = null;
  loserId = null;
  loserName = null;
  for (const p of players.values()) p.waiting = false;
  broadcastRoom();
}

function removePlayer(id) {
  const p = players.get(id);
  if (!p) return;
  players.delete(id);
  if (phase === 'ready' || phase === 'playing') {
    const active = activePlayers();
    if (active.length < 2) {
      broadcast({ t: 'notice', msg: `${p.name} left — not enough players.` });
      toLobby();
      return;
    }
    if (id === itId) {
      const next = pickRandom(active);
      itId = next.id;
      next.frozenUntil = nowSec() + FREEZE_SECONDS;
      broadcast({ t: 'notice', msg: `${p.name} left — ${next.name} is now IT!` });
    }
  }
  broadcastRoom();
}

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------
function stepPlayer(p, t) {
  const world = currentWorld();
  const slow = t < p.slowUntil ? SLOW_MULT : 1;
  // Ride a moving platform: get carried by however far it moved this tick
  const under = p.onGround ? livePlatforms[p.standingOn] : null;
  if (under && (under.dx || under.dy)) {
    p.x = Math.max(0, Math.min(world.width - PLAYER_W, p.x + under.dx));
    p.y += under.dy;
  }

  const canMove = phase === 'playing' && t >= p.frozenUntil;
  const input = canMove ? p.input : NO_INPUT;

  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);

  // Dash (slide on the ground, air dash in the air)
  const dashPressed = input.dash && !p.dashWasDown;
  p.dashWasDown = input.dash;
  if (p.dashMode && t >= p.dashUntil) p.dashMode = null;
  if (dashPressed && !p.dashMode && t >= p.dashReadyAt) {
    p.dashDir = dir || p.facing;
    p.facing = p.dashDir;
    p.dashMode = p.onGround ? 'slide' : 'air';
    p.dashStart = t;
    p.dashUntil = t + (p.dashMode === 'slide' ? SLIDE_SECONDS : AIRDASH_SECONDS);
    p.dashReadyAt = t + DASH_COOLDOWN;
    p.dashes++;
    if (p.dashMode === 'air') p.vy = 0;
  }

  // Horizontal
  if (p.dashMode === 'slide') {
    const k = (t - p.dashStart) / SLIDE_SECONDS;
    p.vx = p.dashDir * (SLIDE_SPEED + (SLIDE_END_SPEED - SLIDE_SPEED) * k) * slow;
  } else if (p.dashMode === 'air') {
    p.vx = p.dashDir * AIRDASH_SPEED * slow;
  } else if (dir !== 0) {
    p.facing = dir;
    const boots = t < p.speedUntil;
    const runSpeed = (boots ? RUN_SPEED * BOOTS_SPEED_MULT : RUN_SPEED) * slow;
    if (p.vx * dir > runSpeed) {
      // Still carrying extra speed from a dash: ease back down to running speed
      p.vx = dir * Math.max(runSpeed, p.vx * dir - MOMENTUM_DECAY * DT);
    } else {
      let accel = p.onGround ? ACCEL_GROUND : ACCEL_AIR;
      if (boots) accel *= BOOTS_SPEED_MULT;
      if (p.vx * dir < 0) accel *= 1.8; // snappier turnarounds
      p.vx = Math.max(-runSpeed, Math.min(runSpeed, p.vx + dir * accel * DT));
    }
  } else {
    const friction = (p.onGround ? FRICTION_GROUND : FRICTION_AIR) * DT;
    p.vx = Math.abs(p.vx) <= friction ? 0 : p.vx - Math.sign(p.vx) * friction;
  }

  // Jump (with coyote time, input buffering and variable height)
  const jumpPressed = input.jump && !p.jumpWasDown;
  p.jumpWasDown = input.jump;
  p.jumpBuffer = jumpPressed ? JUMP_BUFFER : Math.max(0, p.jumpBuffer - DT);
  p.coyote = p.onGround ? COYOTE_TIME : Math.max(0, p.coyote - DT);
  if (p.jumpBuffer > 0 && p.coyote > 0) {
    p.vy = -JUMP_VELOCITY;
    p.jumps = (p.jumps ?? 0) + 1;
    if (p.dashMode === 'slide') p.dashMode = null; // jump out of a slide, keeping its speed
    p.jumpBuffer = 0;
    p.coyote = 0;
    p.onGround = false;
  }
  if (p.boosted && p.vy >= 0) p.boosted = false;
  if (!input.jump && !p.boosted && p.vy < -JUMP_VELOCITY * JUMP_CUT) {
    p.vy = -JUMP_VELOCITY * JUMP_CUT;
  }

  if (p.dashMode !== 'air') p.vy = Math.min(MAX_FALL, p.vy + GRAVITY * DT);

  // Move X, clamp to world edges
  p.x += p.vx * DT;
  if (p.x < 0) {
    p.x = 0;
    p.vx = 0;
  } else if (p.x > world.width - PLAYER_W) {
    p.x = world.width - PLAYER_W;
    p.vx = 0;
  }

  // Move Y; platforms are one-way (land on top, jump up through from below)
  const prevBottom = p.y + PLAYER_H;
  p.y += p.vy * DT;
  p.onGround = false;
  p.standingOn = -1;
  if (p.vy >= 0) {
    let landY = Infinity;
    livePlatforms.forEach((pl, i) => {
      const overlapsX = p.x + PLAYER_W > pl.x && p.x < pl.x + pl.w;
      // Compare against where the platform was too, so a rising platform can't slip past our feet
      const wasAbove = prevBottom <= Math.max(pl.y, pl.prevY) + 0.01;
      if (overlapsX && wasAbove && p.y + PLAYER_H >= pl.y && pl.y < landY) {
        landY = pl.y;
        p.standingOn = i;
      }
    });
    if (landY !== Infinity) {
      p.y = landY - PLAYER_H;
      p.vy = 0;
      p.onGround = true;
    }
  }
  if (p.y < 0) {
    p.y = 0;
    p.vy = 0;
  }
  if (p.dashMode === 'slide' && !p.onGround) p.dashMode = null; // slid off a ledge
  if (p.dashMode === 'air' && p.onGround) p.dashMode = null; // landed mid-dash
  if (p.y > world.height) resetBody(p, pickRandom(currentMap().spawns)); // safety net
  if (phase === 'playing') {
    checkPads(p);
    checkTraps(p, t);
    checkPortals(p);
  }
}

// Tag hitbox; sliding players are shorter (feet stay put)
function hitbox(p) {
  const h = p.dashMode === 'slide' ? SLIDE_H : PLAYER_H;
  return { x: p.x + TAG_INSET, y: p.y + PLAYER_H - h + TAG_INSET, w: PLAYER_W - 2 * TAG_INSET, h: h - 2 * TAG_INSET };
}

function overlaps(a, b) {
  const A = hitbox(a);
  const B = hitbox(b);
  return A.x < B.x + B.w && A.x + A.w > B.x && A.y < B.y + B.h && A.y + A.h > B.y;
}

function checkTag(active, t) {
  const it = players.get(itId);
  if (!it || it.waiting || t < it.frozenUntil) return;
  for (const p of active) {
    if (p === it || t < p.immuneUntil) continue;
    if (overlaps(it, p)) {
      itId = p.id;
      it.immuneUntil = t + IMMUNE_SECONDS;
      it.tags++;
      p.frozenUntil = t + FREEZE_SECONDS;
      p.dashMode = null;
      p.vx = 0;
      broadcast({ t: 'tag', from: it.id, to: p.id });
      return;
    }
  }
}

function tick() {
  if (phase !== 'ready' && phase !== 'playing') return;
  const t = nowSec();
  if (phase === 'ready' && t >= phaseEndsAt) {
    phase = 'playing';
    phaseEndsAt = t + roundSeconds;
    broadcastRoom();
  }
  updatePlatforms(t);
  const active = activePlayers();
  for (const p of active) stepPlayer(p, t);
  if (phase === 'playing') {
    const it = players.get(itId);
    if (it) it.itTime += DT;
    checkTag(active, t);
    updatePowerup(active, t);
    if (t >= phaseEndsAt) {
      phase = 'ended';
      loserId = itId;
      loserName = players.get(itId)?.name ?? null;
      for (const p of active) if (p.id !== loserId) wins.set(p.name, (wins.get(p.name) ?? 0) + 1);
      lastResults = active
        .map((p) => ({ id: p.id, name: p.name, char: p.char, itTime: Math.round(p.itTime * 10) / 10, tags: p.tags }))
        .sort((a, b) => (a.id === loserId) - (b.id === loserId) || a.itTime - b.itTime);
      broadcast(snapshot());
      broadcastRoom();
    }
  }
}

// Fixed-timestep loop: setInterval granularity is coarse, so accumulate time.
let lastLoop = performance.now();
let accumulator = 0;
setInterval(() => {
  const n = performance.now();
  accumulator += Math.min(n - lastLoop, 250);
  lastLoop = n;
  let stepped = false;
  while (accumulator >= TICK_MS) {
    accumulator -= TICK_MS;
    tick();
    stepped = true;
  }
  if (stepped && (phase === 'ready' || phase === 'playing')) broadcast(snapshot());
}, 4);

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

function handleMessage(ws, msg) {
  switch (msg.t) {
    case 'join': {
      if (players.has(ws.id)) return;
      if (players.size >= MAX_PLAYERS) {
        return send(ws, { t: 'error', msg: `Game is full (${MAX_PLAYERS} players max).` });
      }
      const name = String(msg.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 12) || 'Player';
      const used = new Set([...players.values()].map((p) => p.char));
      const free = [...Array(CHARACTER_COUNT).keys()].filter((c) => !used.has(c));
      const char = pickRandom(free);
      const p = {
        id: ws.id,
        name,
        char,
        waiting: phase !== 'lobby',
        input: { ...NO_INPUT },
      };
      const spawns = currentMap().spawns;
      resetBody(p, spawns[players.size % spawns.length]);
      players.set(ws.id, p);
      broadcastRoom();
      break;
    }
    case 'leave':
      removePlayer(ws.id);
      break;
    case 'roundLength': {
      // Any joined player can change the round length while in the lobby
      const seconds = Number(msg.seconds);
      if (!players.has(ws.id) || phase !== 'lobby' || !ROUND_OPTIONS.includes(seconds)) return;
      roundSeconds = seconds;
      broadcastRoom();
      break;
    }
    case 'map':
      // Any joined player can pick the map while in the lobby
      if (!players.has(ws.id) || phase !== 'lobby' || !Object.hasOwn(MAPS, msg.id)) return;
      mapId = msg.id;
      broadcastRoom();
      break;
    case 'avatar': {
      // Cycle to the next character nobody else is using (lobby only)
      const p = players.get(ws.id);
      if (!p || phase !== 'lobby') return;
      const used = new Set([...players.values()].filter((o) => o !== p).map((o) => o.char));
      const dir = msg.dir === -1 ? -1 : 1;
      let c = p.char;
      do c = (c + dir + CHARACTER_COUNT) % CHARACTER_COUNT;
      while (used.has(c));
      p.char = c;
      broadcastRoom();
      break;
    }
    case 'input': {
      const p = players.get(ws.id);
      if (p) p.input = { left: !!msg.left, right: !!msg.right, jump: !!msg.jump, dash: !!msg.dash };
      break;
    }
    case 'start':
      if (!players.has(ws.id) || phase !== 'lobby') return;
      if (!startRound()) send(ws, { t: 'error', msg: 'Need at least 2 players to start.' });
      break;
    case 'restart':
      if (!players.has(ws.id) || phase !== 'ended') return;
      if (!startRound()) toLobby();
      break;
    case 'lobby':
      if (players.has(ws.id) && phase === 'ended') toLobby();
      break;
  }
}

wss.on('connection', (ws) => {
  ws.id = nextId++;
  ws.isAlive = true;
  clients.add(ws);

  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg && typeof msg === 'object') handleMessage(ws, msg);
  });
  ws.on('close', () => {
    clients.delete(ws);
    removePlayer(ws.id);
  });

  send(ws, {
    t: 'welcome',
    id: ws.id,
    world: WORLD,
    view: VIEW,
    maps: MAPS,
    player: { w: PLAYER_W, h: PLAYER_H },
    roundOptions: ROUND_OPTIONS,
    maxPlayers: MAX_PLAYERS,
    dashCooldown: DASH_COOLDOWN,
    slideHeight: SLIDE_H,
  });
  send(ws, roomMessage());
  if (phase !== 'lobby') send(ws, snapshot());
});

// Drop sockets that silently vanished (e.g. a phone that went to sleep).
setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 5000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Tag server running.');
  console.log(`  On this machine:  http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log(`  On your LAN:      http://${a.address}:${PORT}`);
      }
    }
  }
});
