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
const mirror = (list, world = WORLD) => list.map((pl) => plat(world.width - pl.x - pl.w, pl.y, pl.w));

// Zig-zag cliff up the left wall of Lava Caverns (mirrored on the right)
const LAVA_CLIFF = [
  plat(140, 775, 160), plat(280, 690, 140), plat(40, 605, 170), plat(260, 520, 160),
  plat(40, 435, 170), plat(260, 350, 160), plat(40, 265, 170), plat(260, 180, 150),
];

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
  lava: {
    name: 'Lava Caverns',
    theme: 'volcano',
    world: BIG_WORLD,
    platforms: [
      bigGround,
      // Cliffs up both walls, with lift shafts between them and the volcano
      ...LAVA_CLIFF,
      ...mirror(LAVA_CLIFF, BIG_WORLD),
      // Stepped volcano cone in the middle, then ledges up through the smoke
      plat(560, 775, 480), plat(640, 690, 320), plat(690, 605, 220), plat(730, 520, 140),
      plat(540, 435, 140), plat(920, 435, 140),
      plat(720, 350, 160),
      plat(520, 265, 150), plat(930, 265, 150),
      plat(720, 180, 160),
      plat(440, 840, 80, { dx: 0, dy: -580, period: 8 }), // left lift shaft
      plat(1080, 260, 80, { dx: 0, dy: 580, period: 8 }), // right lift shaft, out of step with the left
      plat(300, 95, 120, { dx: 880, dy: 0, period: 9 }), // smoke cloud drifting over the top
    ],
    portals: [
      portalOn(125, 605), portalOn(1475, 605), // lava tube between the two cliffs
      portalOn(620, 860), portalOn(1265, 180), // ground by the volcano <-> high right ledge
    ],
    pads: [
      padOn(30, 860, 1500), // left wall -> five tiers up
      padOn(1530, 860, 1500), // right wall
      padOn(780, 520), // eruption: volcano top -> the ledge above the smoke
    ],
    traps: [
      trapOn(740, 860, 120), // magma pool at the foot of the volcano
      trapOn(760, 605, 80), // on the cone
      trapOn(760, 350, 80),
    ],
    powerupSpots: [[220, 775], [1380, 775], [800, 690], [610, 435], [990, 435], [125, 435], [1475, 435], [595, 265]],
    spawns: [180, 1390, 380, 1200, 280, 1000, 490, 1100],
  },
  reef: {
    name: 'Coral Reef',
    theme: 'ocean',
    world: BIG_WORLD,
    platforms: [
      bigGround,
      plat(80, 775, 160), plat(520, 775, 160), plat(920, 775, 160), plat(1360, 775, 160),
      plat(300, 690, 160), plat(1140, 690, 160),
      plat(40, 605, 180), plat(1380, 605, 180),
      plat(260, 520, 170), plat(700, 520, 200), plat(1170, 520, 170), // sunken ship's deck in the middle
      plat(40, 435, 170), plat(480, 435, 150), plat(970, 435, 150), plat(1390, 435, 170),
      plat(240, 350, 160), plat(1200, 350, 160),
      plat(40, 265, 170), plat(680, 265, 240), plat(1390, 265, 170),
      plat(260, 180, 150), plat(1190, 180, 150),
      plat(720, 690, 160, { dx: 0, dy: -85, period: 4 }), // jellyfish bobbing up to the deck
      plat(460, 350, 120, { dx: 560, dy: 0, period: 6 }), // current sweeping across the middle
      plat(740, 180, 120, { dx: 0, dy: -85, period: 4 }), // jellyfish over the coral arch
    ],
    portals: [
      portalOn(60, 860), portalOn(1265, 180), // sea floor left <-> high right
      portalOn(1540, 860), portalOn(335, 180), // sea floor right <-> high left
    ],
    pads: [
      padOn(780, 860, 1500), // geyser under the shipwreck
      padOn(380, 860),
      padOn(1180, 860),
    ],
    traps: [
      // Tangles of sticky seaweed
      trapOn(560, 775, 80),
      trapOn(960, 775, 80),
      trapOn(720, 265, 80),
    ],
    powerupSpots: [[160, 775], [1440, 775], [800, 520], [555, 435], [1045, 435], [125, 265], [1475, 265], [860, 265]],
    spawns: [160, 1420, 280, 1300, 560, 1000, 660, 900],
  },
  candy: {
    name: 'Candy Clouds',
    theme: 'candy',
    world: BIG_WORLD,
    platforms: [
      bigGround,
      plat(100, 775, 200), plat(700, 775, 200), plat(1300, 775, 200),
      plat(380, 690, 160), plat(1060, 690, 160),
      plat(60, 605, 180), plat(620, 605, 360), plat(1360, 605, 180),
      plat(300, 520, 160), plat(1140, 520, 160),
      plat(60, 435, 160), plat(700, 435, 200), plat(1380, 435, 160),
      plat(320, 350, 160), plat(1120, 350, 160),
      plat(60, 265, 160), plat(640, 265, 320), plat(1380, 265, 160),
      plat(320, 180, 160), plat(1120, 180, 160),
      plat(700, 95, 200), // the cherry on top
      plat(500, 350, 100, { dx: 500, dy: 0, period: 6 }), // cotton-candy cloud across the middle
      plat(160, 95, 100, { dx: 0, dy: 255, period: 7 }), // left gumball lift between the top tiers
      plat(1340, 350, 100, { dx: 0, dy: -255, period: 7 }), // right gumball lift
    ],
    portals: [
      portalOn(140, 435), portalOn(1460, 435), // across the middle
      portalOn(800, 860), portalOn(400, 180), // under the big gumdrop <-> high left
    ],
    pads: [
      // Bouncy gumdrops
      padOn(560, 860),
      padOn(1000, 860),
      padOn(780, 605, 1000), // middle ledge -> one tier up
      padOn(780, 265, 1000), // top ledge -> the cherry
    ],
    traps: [
      // Sticky caramel
      trapOn(400, 860, 100),
      trapOn(1100, 860, 100),
      trapOn(660, 605, 70),
    ],
    powerupSpots: [[200, 775], [1400, 775], [800, 775], [140, 605], [1460, 605], [800, 435], [800, 95], [400, 350]],
    spawns: [120, 1450, 260, 1300, 660, 900, 1220, 330],
  },
  city: {
    name: 'Neon City',
    theme: 'city',
    world: BIG_WORLD,
    platforms: [
      bigGround,
      plat(160, 775, 200), plat(700, 775, 200), plat(1240, 775, 200),
      plat(420, 690, 180), plat(1000, 690, 180),
      plat(40, 605, 220), plat(660, 605, 280), plat(1340, 605, 220),
      plat(300, 520, 180), plat(1120, 520, 180),
      plat(40, 435, 200), plat(560, 435, 180), plat(860, 435, 180), plat(1360, 435, 200),
      plat(300, 350, 170), plat(1130, 350, 170),
      plat(40, 265, 200), plat(700, 265, 200), plat(1360, 265, 200),
      plat(300, 180, 170), plat(1130, 180, 170),
      plat(765, 690, 70, { dx: 0, dy: -425, period: 7 }), // elevator up the middle tower
      plat(500, 520, 120, { dx: 480, dy: 0, period: 6 }), // sky tram between the side towers
      plat(420, 95, 120, { dx: 640, dy: 0, period: 8 }), // crane hook over the rooftops
    ],
    portals: [
      // Three subway lines
      portalOn(60, 860), portalOn(1460, 265),
      portalOn(1540, 860), portalOn(140, 265),
      portalOn(150, 605), portalOn(1450, 605),
    ],
    pads: [
      padOn(400, 860),
      padOn(1160, 860),
    ],
    traps: [
      // Oil slicks
      trapOn(740, 860, 120),
      trapOn(330, 350, 80),
      trapOn(1190, 350, 80),
    ],
    powerupSpots: [[260, 775], [1340, 775], [700, 605], [140, 435], [1460, 435], [650, 435], [950, 435], [800, 265]],
    spawns: [160, 1420, 280, 1300, 560, 1000, 640, 940],
  },
};
for (const map of Object.values(MAPS)) map.world ??= WORLD;
const mapOf = (r) => MAPS[r.mapId];
const worldOf = (r) => mapOf(r).world;

// Live platform positions for a room's map (moving ones change every tick)
function updatePlatforms(r, t) {
  const defs = mapOf(r).platforms;
  if (r.liveMapId !== r.mapId) {
    r.livePlatforms = defs.map((d) => ({ ...d, prevX: d.x, prevY: d.y, dx: 0, dy: 0 }));
    r.liveMapId = r.mapId;
  }
  defs.forEach((d, i) => {
    const pl = r.livePlatforms[i];
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

const MAX_PLAYERS = 8; // per room, including each free roam session
const CHARACTER_COUNT = 10; // must match CHARACTERS in public/characters.js
// In-round music; names must match the round songs in public/music.js
const ROUND_TRACKS = ['game', 'chase', 'bounce', 'sprint'];
// Lobby time settings, in whole seconds: [min, max] and how far one +/- press moves
const ROUND_MIN = 10;
const ROUND_MAX = 180;
const ROUND_STEP = 5;
const START_ROUND_SECONDS = Number(process.env.ROUND_SECONDS) || 60;
const READY_SECONDS = 3;
const FREEZE_SECONDS = 1; // newly-tagged player can't move
// Game modes for the main game: classic tag (IT when the clock runs out loses) or hot potato
// (holding the potato when its fuse runs out knocks you out; last one standing wins).
// Free roam isn't one of these: it runs in its own sessions, alongside the main game.
const MODES = ['classic', 'potato'];
const FUSE_MIN = 5;
const FUSE_MAX = 15;
const FUSE_STEP = 1;
const HANDOFF_SECONDS = 3; // after a boom, the new holder is frozen this long so everyone can scatter
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
// randomly speed boots (run faster), an invisibility cloak, wings (double jump) or a shield.
const BOOTS_SECONDS = 6;
const CLOAK_SECONDS = 5; // invisibility cloak: others only see a faint shimmer
const WINGS_SECONDS = 8; // wings: one extra jump in mid-air, recharged on landing
const POWERUP_KINDS = ['boots', 'cloak', 'wings', 'shield'];
// Shield: no timer. It blocks the next tag that would hit you, then pops. The blocked
// tagger can't touch you again for SHIELD_GRACE seconds, or they'd tag you next tick.
const SHIELD_GRACE = 1;
const SHIELD_BOUNCE = 420; // sideways shove the pop gives you, away from the tagger
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
// There's one main game (classic / hot potato, settings chosen in the lobby) plus any
// number of free roam sessions: no clock, nobody IT, anyone can drop in and out, and a
// session ends when its last player leaves. Every socket views exactly one room
// (`ws.room`): the main game by default, or the free roam session it's playing in.
const clients = new Set(); // every open socket, joined or not
// Session win counts, keyed by name so a phone that drops and rejoins keeps its record.
// Reset when the server restarts.
const wins = new Map(); // name -> wins
let nextId = 1;
let nextRoamId = 1;

function createRoom({ id, free = false, mapId = 'meadow' }) {
  return {
    id,
    free,
    players: new Map(), // id -> player (joined sockets only)
    phase: free ? 'playing' : 'lobby', // lobby | ready | playing | ended (free roam is always playing)
    mode: free ? 'free' : 'classic',
    roundSeconds: START_ROUND_SECONDS,
    fuseSeconds: 15, // set in the lobby; the fuse resets to this on every tag
    mapId,
    itId: null,
    loserId: null,
    loserName: null,
    winnerId: null, // hot potato: last one standing
    winnerName: null,
    phaseEndsAt: 0, // end of the round (classic) or when the potato blows (hot potato)
    handoffUntil: 0, // hot potato: new holder frozen after a boom
    outCount: 0, // hot potato: how many have been knocked out this round
    lastResults: null, // per-player stats for the round that just ended
    powerup: null, // { x, y, kind } while one is on the map
    powerupSpotIndex: -1,
    nextPowerupAt: free ? nowSec() + POWERUP_FIRST_DELAY : Infinity,
    livePlatforms: [],
    liveMapId: null,
    track: free ? pickRandom(ROUND_TRACKS) : null, // in-round music, picked here so everyone hears the same one
  };
}

const nowSec = () => performance.now() / 1000;
const NO_INPUT = { left: false, right: false, jump: false, dash: false };

const mainRoom = createRoom({ id: 0 });
const roamRooms = new Map(); // id -> free roam room
const allRooms = () => [mainRoom, ...roamRooms.values()];

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// Send to every socket viewing room `r`
function broadcast(r, msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.room === r && ws.readyState === ws.OPEN) ws.send(data);
}

function activePlayers(r) {
  return [...r.players.values()].filter((p) => !p.waiting && !p.out);
}

function roomMessage(r) {
  return {
    t: 'room',
    roomId: r.id,
    free: r.free,
    phase: r.phase,
    roundSeconds: r.roundSeconds,
    roundRange: [ROUND_MIN, ROUND_MAX],
    mode: r.mode,
    fuseSeconds: r.fuseSeconds,
    fuseRange: [FUSE_MIN, FUSE_MAX],
    mapId: r.mapId,
    track: r.track,
    itId: r.itId,
    loserId: r.loserId,
    loserName: r.loserName,
    winnerId: r.winnerId,
    winnerName: r.winnerName,
    results: r.phase === 'ended' ? r.lastResults : null,
    players: [...r.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      char: p.char,
      waiting: p.waiting,
      out: !!p.out, // knocked out of this hot potato round
      wins: wins.get(p.name) ?? 0,
    })),
  };
}

function broadcastRoom(r) {
  broadcast(r, roomMessage(r));
}

// The free roam sessions anyone can join, for the lobby's list (sent to every socket)
function roamMessage() {
  return {
    t: 'roam',
    sessions: [...roamRooms.values()].map((r) => ({
      id: r.id,
      mapId: r.mapId,
      players: [...r.players.values()].map((p) => ({ name: p.name, char: p.char })),
    })),
  };
}

function broadcastRoam() {
  const data = JSON.stringify(roamMessage());
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

function snapshot(r) {
  const t = nowSec();
  return {
    t: 'snap',
    st: performance.now(),
    phase: r.phase,
    timeLeft: r.phase === 'ended' || r.free ? 0 : Math.max(0, r.phaseEndsAt - t),
    itId: r.itId,
    ho: Math.max(0, Math.round((r.handoffUntil - t) * 10) / 10), // hot potato hand-off countdown (s)
    // [index, x, y] for each moving platform
    pu: r.powerup, // { x, y, kind } or null
    mp: r.livePlatforms.flatMap((pl, i) => (pl.move ? [[i, Math.round(pl.x * 10) / 10, Math.round(pl.y * 10) / 10]] : [])),
    players: activePlayers(r).map((p) => ({
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
      dj: Math.max(0, Math.round((p.wingsUntil - t) * 10) / 10), // wings (double jump) time left (s)
      ac: p.airJumps, // mid-air jump counter, lets clients puff + play a flap
      sh: p.shield ? 1 : 0, // holding a shield
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

function resetBody(r, p, spawnX) {
  p.x = spawnX;
  p.y = mapOf(r).platforms[0].y - PLAYER_H;
  p.vx = 0;
  p.vy = 0;
  p.onGround = true;
  p.facing = spawnX < worldOf(r).width / 2 ? 1 : -1;
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
  p.wingsUntil = 0; // can double jump until this time
  p.airJumpUsed = false; // already used the mid-air jump since leaving the ground
  p.airJumps = p.airJumps ?? 0;
  p.shield = false; // blocks the next tag, then pops
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

function checkPads(r, p) {
  if (!p.onGround) return;
  for (const pad of mapOf(r).pads || []) {
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
function checkTraps(r, p, t) {
  let inTrap = false;
  if (p.onGround) {
    for (const trap of mapOf(r).traps || []) {
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

function checkPortals(r, p) {
  const PORTALS = mapOf(r).portals;
  if (p.portalLock >= 0 && distToPortal(p, PORTALS[p.portalLock]) > PORTALS[p.portalLock].r + PORTAL_REARM_DIST) {
    p.portalLock = -1;
  }
  for (let i = 0; i < PORTALS.length; i++) {
    if (i === p.portalLock || distToPortal(p, PORTALS[i]) >= PORTALS[i].r) continue;
    const exitIndex = i ^ 1;
    const exit = PORTALS[exitIndex];
    p.x = Math.max(0, Math.min(worldOf(r).width - PLAYER_W, exit.x - PLAYER_W / 2));
    p.y = exit.y - PLAYER_H / 2;
    p.onGround = false;
    p.portalLock = exitIndex;
    p.teleports++;
    return;
  }
}

function updatePowerup(r, active, t) {
  const spots = mapOf(r).powerupSpots || [];
  if (!r.powerup && t >= r.nextPowerupAt && spots.length) {
    // Pick a different spot from last time
    let i = Math.floor(Math.random() * spots.length);
    if (spots.length > 1 && i === r.powerupSpotIndex) i = (i + 1) % spots.length;
    r.powerupSpotIndex = i;
    const [x, platformY] = spots[i];
    r.powerup = { x, y: platformY - 22, kind: pickRandom(POWERUP_KINDS) };
  }
  if (!r.powerup) return;
  for (const p of active) {
    const cx = Math.max(p.x, Math.min(r.powerup.x, p.x + PLAYER_W)); // closest point on the player box
    const cy = Math.max(p.y, Math.min(r.powerup.y, p.y + PLAYER_H));
    if (Math.hypot(r.powerup.x - cx, r.powerup.y - cy) > POWERUP_R) continue;
    if (r.powerup.kind === 'boots') p.speedUntil = t + BOOTS_SECONDS;
    else if (r.powerup.kind === 'wings') p.wingsUntil = t + WINGS_SECONDS;
    else if (r.powerup.kind === 'shield') p.shield = true;
    else p.cloakUntil = t + CLOAK_SECONDS;
    broadcast(r, { t: 'powerup', id: p.id, kind: r.powerup.kind });
    r.powerup = null;
    r.nextPowerupAt = t + POWERUP_RESPAWN;
    return;
  }
}

function startRound(r) {
  const list = [...r.players.values()];
  if (list.length < 2) return false;
  const spawns = shuffle(mapOf(r).spawns.slice());
  list.forEach((p, i) => {
    p.waiting = false;
    p.out = false;
    p.outOrder = 0;
    p.itTime = 0;
    p.tags = 0;
    resetBody(r, p, spawns[i]);
  });
  r.itId = pickRandom(list).id;
  r.loserId = null;
  r.loserName = null;
  r.winnerId = null;
  r.winnerName = null;
  r.handoffUntil = 0;
  r.outCount = 0;
  r.track = pickRandom(ROUND_TRACKS.filter((t) => t !== r.track));
  r.phase = 'ready';
  r.phaseEndsAt = nowSec() + READY_SECONDS;
  r.powerup = null;
  r.powerupSpotIndex = -1;
  r.nextPowerupAt = r.phaseEndsAt + POWERUP_FIRST_DELAY;
  updatePlatforms(r, nowSec()); // so the first snapshot has this map's platforms
  broadcastRoom(r);
  broadcast(r, snapshot(r));
  return true;
}

function toLobby(r) {
  r.phase = 'lobby';
  r.itId = null;
  r.loserId = null;
  r.loserName = null;
  r.winnerId = null;
  r.winnerName = null;
  for (const p of r.players.values()) {
    p.waiting = false;
    p.out = false;
  }
  broadcastRoom(r);
}

// Classic: `loser` is whoever was IT. Hot potato: `winner` is the last one standing.
function endRound(r, { loser = null, winner = null }) {
  r.phase = 'ended';
  const played = [...r.players.values()].filter((p) => !p.waiting);
  if (r.mode === 'potato') {
    r.winnerId = winner?.id ?? null;
    r.winnerName = winner?.name ?? null;
    if (winner) wins.set(winner.name, (wins.get(winner.name) ?? 0) + 1);
    // 1st = last one standing, then in reverse order of being knocked out
    r.lastResults = played
      .sort((a, b) => (b === winner) - (a === winner) || b.outOrder - a.outOrder)
      .map((p, i) => ({ id: p.id, name: p.name, char: p.char, place: i + 1, itTime: Math.round(p.itTime * 10) / 10, tags: p.tags }));
  } else {
    r.loserId = loser?.id ?? null;
    r.loserName = loser?.name ?? null;
    for (const p of played) if (p !== loser) wins.set(p.name, (wins.get(p.name) ?? 0) + 1);
    r.lastResults = played
      .map((p) => ({ id: p.id, name: p.name, char: p.char, itTime: Math.round(p.itTime * 10) / 10, tags: p.tags }))
      .sort((a, b) => (a.id === r.loserId) - (b.id === r.loserId) || a.itTime - b.itTime);
  }
  broadcast(r, snapshot(r));
  broadcastRoom(r);
}

// Hot potato: give the potato to `next`, frozen briefly so everyone else can scatter
function handOff(r, next, t) {
  r.itId = next.id;
  next.frozenUntil = t + HANDOFF_SECONDS;
  next.immuneUntil = 0;
  r.handoffUntil = t + HANDOFF_SECONDS;
  r.phaseEndsAt = r.handoffUntil + r.fuseSeconds;
}

// Hot potato: the fuse ran out. The holder is out and the nearest survivor gets the potato.
function explodePotato(r, t) {
  const holder = r.players.get(r.itId);
  if (!holder) return;
  holder.out = true;
  holder.outOrder = ++r.outCount;
  const survivors = activePlayers(r);
  const hx = holder.x + PLAYER_W / 2;
  const hy = holder.y + PLAYER_H / 2;
  const dist = (p) => Math.hypot(p.x + PLAYER_W / 2 - hx, p.y + PLAYER_H / 2 - hy);
  const next = survivors.length > 1 ? survivors.reduce((a, b) => (dist(b) < dist(a) ? b : a)) : null;
  broadcast(r, { t: 'boom', id: holder.id, x: Math.round(hx), y: Math.round(hy), next: next?.id ?? null });
  if (!next) {
    endRound(r, { winner: survivors[0] ?? null });
    return;
  }
  handOff(r, next, t);
  broadcastRoom(r);
}

// Main game: someone left (or disconnected)
function removePlayer(id) {
  const r = mainRoom;
  const p = r.players.get(id);
  if (!p) return;
  r.players.delete(id);
  if (r.players.size === 0) return toLobby(r); // nobody left, e.g. everyone went off to free roam from the results
  if (r.phase === 'ready' || r.phase === 'playing') {
    const active = activePlayers(r);
    if (active.length < 2) {
      if (r.mode === 'potato' && active.length === 1 && r.outCount > 0) {
        broadcast(r, { t: 'notice', msg: `${p.name} left — ${active[0].name} is the last one standing!` });
        endRound(r, { winner: active[0] });
        return;
      }
      broadcast(r, { t: 'notice', msg: `${p.name} left — not enough players.` });
      toLobby(r);
      return;
    }
    if (id === r.itId) {
      const next = pickRandom(active);
      if (r.mode === 'potato' && r.phase === 'playing') {
        handOff(r, next, nowSec());
        broadcast(r, { t: 'notice', msg: `${p.name} left — ${next.name} has the potato! 🥔` });
      } else {
        r.itId = next.id;
        next.frozenUntil = nowSec() + FREEZE_SECONDS;
        broadcast(r, { t: 'notice', msg: `${p.name} left — ${next.name} is now IT!` });
      }
    }
  }
  broadcastRoom(r);
}

// ---------------------------------------------------------------------------
// Free roam sessions
// ---------------------------------------------------------------------------
function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 12) || 'Player';
}

// A lobby time setting: `delta` (±1) moves it one step, or `seconds` sets it outright.
// Either way the result is whole seconds clamped to [lo, hi]; junk leaves it unchanged.
function stepSeconds(current, msg, lo, hi, step) {
  const v = msg.seconds !== undefined
    ? (typeof msg.seconds === 'number' ? msg.seconds : NaN)
    : current + Math.sign(Number(msg.delta) || 0) * step;
  if (!Number.isFinite(v)) return current;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

// A character nobody else in the room is using
function freeCharacter(r) {
  const used = new Set([...r.players.values()].map((p) => p.char));
  return pickRandom([...Array(CHARACTER_COUNT).keys()].filter((c) => !used.has(c)));
}

// Move a socket out of the main game (if it's in it) and into free roam session `r`
function enterRoam(ws, r, name) {
  removePlayer(ws.id);
  const p = { id: ws.id, name: cleanName(name), char: freeCharacter(r), waiting: false, input: { ...NO_INPUT } };
  // Drop in at a spawn point nobody's standing on, if there is one
  const groundY = mapOf(r).platforms[0].y - PLAYER_H;
  const others = [...r.players.values()];
  const clear = mapOf(r).spawns.filter((x) => others.every((o) => Math.abs(o.x - x) > PLAYER_W || Math.abs(o.y - groundY) > PLAYER_H));
  resetBody(r, p, pickRandom(clear.length ? clear : mapOf(r).spawns));
  p.jumpWasDown = false;
  p.dashWasDown = false;
  r.players.set(ws.id, p);
  broadcast(r, { t: 'notice', msg: `${p.name} joined` }); // before ws.room switches, so only the others see it
  ws.room = r;
  broadcastRoom(r);
  send(ws, snapshot(r));
  broadcastRoam();
}

function leaveRoam(ws) {
  const r = ws.room;
  if (!r?.free) return;
  const p = r.players.get(ws.id);
  r.players.delete(ws.id);
  ws.room = mainRoom;
  if (r.players.size === 0) {
    roamRooms.delete(r.id); // the last one out ends the session
  } else {
    broadcastRoom(r);
    if (p) broadcast(r, { t: 'notice', msg: `${p.name} left` });
  }
  broadcastRoam();
}

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------
function stepPlayer(r, p, t) {
  const world = worldOf(r);
  const slow = t < p.slowUntil ? SLOW_MULT : 1;
  // Ride a moving platform: get carried by however far it moved this tick
  const under = p.onGround ? r.livePlatforms[p.standingOn] : null;
  if (under && (under.dx || under.dy)) {
    p.x = Math.max(0, Math.min(world.width - PLAYER_W, p.x + under.dx));
    p.y += under.dy;
  }

  const canMove = r.phase === 'playing' && t >= p.frozenUntil;
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
  } else if (jumpPressed && t < p.wingsUntil && !p.airJumpUsed && !p.onGround) {
    // Wings: a fresh jump in mid-air (also cancels an air dash or pad launch)
    p.vy = -JUMP_VELOCITY;
    p.airJumpUsed = true;
    p.jumps = (p.jumps ?? 0) + 1;
    p.airJumps++;
    p.dashMode = null;
    p.boosted = false;
    p.jumpBuffer = 0;
  }
  if (p.onGround) p.airJumpUsed = false;
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
    r.livePlatforms.forEach((pl, i) => {
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
  if (p.y > world.height) resetBody(r, p, pickRandom(mapOf(r).spawns)); // safety net
  if (r.phase === 'playing') {
    checkPads(r, p);
    checkTraps(r, p, t);
    checkPortals(r, p);
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

function checkTag(r, active, t) {
  const it = r.players.get(r.itId);
  if (!it || it.waiting || t < it.frozenUntil) return;
  for (const p of active) {
    if (p === it || t < p.immuneUntil) continue;
    if (!overlaps(it, p)) continue;
    if (p.shield) {
      // The shield takes the hit: nobody changes roles and a hot potato fuse keeps burning
      p.shield = false;
      p.immuneUntil = t + SHIELD_GRACE;
      const away = Math.sign(p.x - it.x) || -it.facing;
      p.vx = away * SHIELD_BOUNCE;
      p.dashMode = null;
      broadcast(r, { t: 'block', from: it.id, to: p.id, x: Math.round(p.x + PLAYER_W / 2), y: Math.round(p.y + PLAYER_H / 2), hidden: t < p.cloakUntil });
      return;
    }
    r.itId = p.id;
    it.immuneUntil = t + IMMUNE_SECONDS;
    it.tags++;
    p.frozenUntil = t + FREEZE_SECONDS;
    p.dashMode = null;
    p.vx = 0;
    if (r.mode === 'potato') r.phaseEndsAt = p.frozenUntil + r.fuseSeconds; // passing the potato resets its fuse
    broadcast(r, { t: 'tag', from: it.id, to: p.id });
    return;
  }
}

function tick(r) {
  if (r.phase !== 'ready' && r.phase !== 'playing') return;
  const t = nowSec();
  if (r.phase === 'ready' && t >= r.phaseEndsAt) {
    r.phase = 'playing';
    r.phaseEndsAt = t + (r.mode === 'potato' ? r.fuseSeconds : r.roundSeconds);
    broadcastRoom(r);
  }
  updatePlatforms(r, t);
  const active = activePlayers(r);
  for (const p of active) stepPlayer(r, p, t);
  if (r.phase === 'playing') {
    updatePowerup(r, active, t);
    if (r.free) return; // free roam: no clock and nobody is IT
    const it = r.players.get(r.itId);
    if (it) it.itTime += DT;
    checkTag(r, active, t);
    if (t >= r.phaseEndsAt) {
      if (r.mode === 'potato') explodePotato(r, t);
      else endRound(r, { loser: r.players.get(r.itId) });
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
    for (const r of allRooms()) tick(r);
    stepped = true;
  }
  if (!stepped) return;
  for (const r of allRooms()) if (r.phase === 'ready' || r.phase === 'playing') broadcast(r, snapshot(r));
}, 4);

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

function handleMessage(ws, msg) {
  const main = mainRoom;
  // Lobby settings: only players who've joined the main game, and only between rounds
  const canSet = main.players.has(ws.id) && main.phase === 'lobby';
  switch (msg.t) {
    case 'join': {
      if (ws.room !== main || main.players.has(ws.id)) return;
      if (main.players.size >= MAX_PLAYERS) {
        return send(ws, { t: 'error', msg: `Game is full (${MAX_PLAYERS} players max).` });
      }
      const p = {
        id: ws.id,
        name: cleanName(msg.name),
        char: freeCharacter(main),
        waiting: main.phase !== 'lobby',
        input: { ...NO_INPUT },
      };
      const spawns = mapOf(main).spawns;
      resetBody(main, p, spawns[main.players.size % spawns.length]);
      main.players.set(ws.id, p);
      broadcastRoom(main);
      break;
    }
    case 'leave':
      removePlayer(ws.id);
      break;
    case 'roundLength':
      if (!canSet) return;
      main.roundSeconds = stepSeconds(main.roundSeconds, msg, ROUND_MIN, ROUND_MAX, ROUND_STEP);
      broadcastRoom(main);
      break;
    case 'mode':
      if (!canSet || !MODES.includes(msg.mode)) return;
      main.mode = msg.mode;
      broadcastRoom(main);
      break;
    case 'fuse':
      if (!canSet) return;
      main.fuseSeconds = stepSeconds(main.fuseSeconds, msg, FUSE_MIN, FUSE_MAX, FUSE_STEP);
      broadcastRoom(main);
      break;
    case 'map':
      if (!canSet || !Object.hasOwn(MAPS, msg.id)) return;
      main.mapId = msg.id;
      broadcastRoom(main);
      break;
    case 'avatar': {
      // Cycle to the next character nobody else is using (lobby only)
      const p = main.players.get(ws.id);
      if (!p || main.phase !== 'lobby') return;
      const used = new Set([...main.players.values()].filter((o) => o !== p).map((o) => o.char));
      const dir = msg.dir === -1 ? -1 : 1;
      let c = p.char;
      do c = (c + dir + CHARACTER_COUNT) % CHARACTER_COUNT;
      while (used.has(c));
      p.char = c;
      broadcastRoom(main);
      break;
    }
    case 'input': {
      const p = ws.room.players.get(ws.id);
      if (p) p.input = { left: !!msg.left, right: !!msg.right, jump: !!msg.jump, dash: !!msg.dash };
      break;
    }
    case 'start':
      if (!canSet) return;
      if (!startRound(main)) send(ws, { t: 'error', msg: 'Need at least 2 players to start.' });
      break;
    case 'restart':
      if (!main.players.has(ws.id) || main.phase !== 'ended') return;
      if (!startRound(main)) toLobby(main);
      break;
    case 'lobby':
      if (main.players.has(ws.id) && main.phase === 'ended') toLobby(main);
      break;
    case 'roamNew': {
      // Start a free roam session of your own on any map
      if (ws.room.free) return;
      if (main.players.has(ws.id) && main.phase !== 'lobby') return; // finish your round first
      const r = createRoom({ id: nextRoamId++, free: true, mapId: Object.hasOwn(MAPS, msg.mapId) ? msg.mapId : main.mapId });
      updatePlatforms(r, nowSec());
      roamRooms.set(r.id, r);
      enterRoam(ws, r, msg.name);
      break;
    }
    case 'roamJoin': {
      if (ws.room.free) return;
      if (main.players.has(ws.id) && main.phase !== 'lobby') return;
      const r = roamRooms.get(Number(msg.id));
      if (!r) return send(ws, { t: 'error', msg: 'That free roam session has ended.' });
      if (r.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: `That session is full (${MAX_PLAYERS} players max).` });
      enterRoam(ws, r, msg.name);
      break;
    }
    case 'roamLeave':
      if (!ws.room.free) return;
      leaveRoam(ws);
      send(ws, roomMessage(main));
      if (main.phase !== 'lobby') send(ws, snapshot(main));
      break;
  }
}

wss.on('connection', (ws) => {
  ws.id = nextId++;
  ws.isAlive = true;
  ws.room = mainRoom;
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
    if (ws.room.free) leaveRoam(ws);
    else removePlayer(ws.id);
  });

  send(ws, {
    t: 'welcome',
    id: ws.id,
    world: WORLD,
    view: VIEW,
    maps: MAPS,
    player: { w: PLAYER_W, h: PLAYER_H },
    maxPlayers: MAX_PLAYERS,
    dashCooldown: DASH_COOLDOWN,
    slideHeight: SLIDE_H,
  });
  send(ws, roomMessage(mainRoom));
  send(ws, roamMessage());
  if (mainRoom.phase !== 'lobby') send(ws, snapshot(mainRoom));
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
