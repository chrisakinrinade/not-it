# Agent guide: Tag!

A LAN multiplayer 2D platformer tag game for 2–8 players. One Node process serves the
static client and runs the authoritative game over WebSockets, and players join from a
browser (desktop or iOS). `README.md` is the player-facing feature list; this file covers
how the code works and how to change it safely.

## Run

```bash
npm install && npm start          # http://localhost:3000
PORT=3101 ROUND_SECONDS=5 npm start
docker build -t tag-game . && docker run -d -p 3000:3000 --name tag-game tag-game
```

- The only dependency is `ws`. There's no build step, no bundler and no test suite. The client is plain browser scripts.
- After a server change, restart the server or container. After a client-only change, players just reload.
- The Docker image copies the source at build time, so rebuild it after any change.
- The owner normally runs the game in the `tag-game` container on **port 3000**. Never stop, restart or use that port for testing unless asked.

## Files

| File | What's in it |
|---|---|
| `server.js` | Static file server, the 60Hz fixed-timestep game loop, physics, tag rules, modes, power-ups, traps, and `MAPS` (all map layouts). Tuning constants are near the top. |
| `public/client.js` | Lobby UI, input (keyboard and multi-touch), snapshot interpolation, camera (including the spectator free camera), rendering, HUD and sound triggers. One IIFE. |
| `public/maps.js` | Map themes (`THEMES`: sky, scenery, platform and trap colors) and drawing for platforms, pads, traps, portals, pickups and icons (boot, ghost, snail, potato), plus lobby previews. |
| `public/characters.js` | The 10 animal characters (`CHARACTERS`) and `drawCharacter`, plus the shared helpers `roundRectPath`, `fillEllipse`, `drawStar`. |
| `public/music.js` | Procedural Web Audio music and sound effects (`Music.sfx(name)`); there are no audio files. |
| `public/index.html`, `style.css` | The lobby card, game canvas, overlays and touch buttons. |

Scripts load in this order: `characters.js`, `maps.js`, `music.js`, `client.js`. Each one's top-level functions are globals that the later files use.

## How it works

- **Rooms:** there's one main game (`mainRoom`: lobby, classic and hot potato) plus any number of free roam sessions (`roamRooms`). All game state lives on a room object `r` from `createRoom`, and game functions take `r`. Each socket views one room (`ws.room`, the main game by default), and `broadcast(r, msg)` only reaches sockets viewing `r`. Free roam rooms (`r.free`, `mode: 'free'`) are always `playing`, with no clock, no IT and no tags, and are deleted when their last player leaves.
- **The server decides everything.** Each tick it steps every active player and broadcasts a full `snap`. Clients send only `input {left,right,jump,dash}`.
- **Client smoothing:** clients render about 50ms in the past (`INTERP_DELAY_MS`), interpolating between snapshots. They don't interpolate across a teleport; they detect one when the `tp` counter changes.
- **Server → client messages:**

  | Message | Contents |
  |---|---|
  | `welcome` | Constants, plus `maps: MAPS` (the client draws whatever layout the server sends). |
  | `room` | State of the room you're viewing: `roomId` (0 is the main game), `free`, phase, mode, settings, `players[]` with `waiting`, `out`, `wins`, and results. |
  | `roam` | The free roam sessions for the lobby list, sent to every socket whenever one changes. |
  | `snap` | Per-tick state. |
  | `tag`, `boom`, `powerup`, `notice`, `error` | One-off events. |

- **Client → server messages:** `join`, `leave`, `input`, `start`, `restart`, `lobby`, `roundLength`, `mode`, `fuse` (`delta` ±1), `map`, `avatar`, and for free roam `roamNew {name, mapId}`, `roamJoin {id, name}`, `roamLeave`.
- **Who can change settings:** lobby settings change only in the `lobby` phase and only for players joined to the main game. The lobby's Free roam button is client-only (`roamView`); it never changes the main game's mode.
- **Phases:** `lobby` → `ready` (3s countdown, nobody moves) → `playing` → `ended`.
- **Classic mode:** whoever is IT when `phaseEndsAt` arrives loses.
- **Hot potato** (`mode === 'potato'`): `phaseEndsAt` is when the fuse blows.
  - Each tag resets it.
  - `explodePotato()` marks the holder `out` and hands the potato to the nearest survivor with a 3s freeze (`handOff`, snapshot field `ho`).
  - Both modes finish in `endRound()`.
- **Player sets:**
  - `activePlayers()` excludes `waiting` players (who joined mid-round) and `out` players (knocked out).
  - Only active players are stepped and appear in snapshots.
  - Clients treat "joined but not in the snapshot" as spectating.
- **One-off effects use counters, not events.** Per-player counters in the snapshot (`jc` jumps, `dc` dashes, `bc` pad launches, `tp` teleports, `tc` trap hits) let clients trigger sounds and animations when a value changes. Add new effects the same way.
- **Other snapshot fields:**

  | Field | Meaning |
  |---|---|
  | `sp`, `iv`, `sl` | Seconds left on boots, invisibility and trap slow |
  | `dm` | Dash mode |
  | `cd` | Dash cooldown left |
  | `fr` | Frozen |
  | `im` | Immune |
  | `mp` | Moving platform positions, as `[index, x, y]` |
  | `pu` | The current power-up pickup |

## Maps (`MAPS` in server.js)

- **World size:** maps default to `WORLD` (1248×702). They can set `world` (Frosty Peaks and Jungle Ruins use `BIG_WORLD`, 1600×900). The view is always 960×540 and the camera scrolls.
- **Ground:** `platforms[0]` must be the ground (`groundFor(world)`). Spawning uses its `y`.
- **Platform spacing:** tiers are 85px apart, and a full jump rises about 138px (`JUMP_VELOCITY² / 2·GRAVITY`).
- **Pads:** a pad launches `power² / 4400` px. 1300 is about 385px.
- **Placement helpers:** `padOn`, `trapOn` and `powerupSpots` (`[x, platformY]`) take a **platform's top y** and must sit on a static platform.
- **Portals:** `portalOn(x, platformY)` creates portals that link in pairs: index `i` links to `i ^ 1`.
- **Moving platforms:** `plat(x, y, w, { dx, dy, period })` eases back and forth. Riders are carried along and can pass up through other platforms.
- **Spawns:** `spawns` needs at least `MAX_PLAYERS` (8) ground x positions, at least 50px apart, and clear of ground pads, traps and portals.
- **Themes:** `theme` names an entry in `THEMES` in maps.js. A theme needs `sky`, `platform`, `trap` colors and a `scenery(g, groundY, width)` function.
- **Check reachability:** after changing a layout, run a quick geometry script (load the `MAPS` block with `new Function`) to check that every tier can be reached and every item sits on a platform.

## Rules that are easy to break

- **Invisible players must leave no trace for others:**
  - Not drawn at all.
  - No label or badge.
  - No off-screen arrow.
  - No pad pop, portal flash or trap splash.
  - Sound effects play only for the player who caused them.

  Check `p.iv > 0 && p.id !== myId` wherever you add a visual effect.
- `CHARACTER_COUNT` in server.js must equal `CHARACTERS.length` in characters.js.
- `ROUND_TRACKS` in server.js must name songs in `SONGS` in music.js. The server picks each round's track (`track` in the `room` message) so every player hears the same one.
- **Adding a power-up** takes four changes:
  1. Add it to `POWERUP_KINDS`.
  2. Apply its effect in `updatePowerup`.
  3. Add a time-left field to the snapshot.
  4. On the client, add a HUD pill (the `active` list in `drawHud`), a pickup look (`drawPowerupPickup`) and a toast (`handle` → `powerup`).
- **The fuse stepper is static HTML.** Don't rebuild it in `renderUI`, because press-and-hold repeat breaks if the element is replaced. Other lobby controls are rebuilt on every `room` message.
- Keep everything working on iOS Safari: multi-touch controls, landscape, `touch-action`, and audio that starts only after a user gesture.

## Testing (no automated tests)

- **Syntax:** `node --check server.js public/*.js`.
- **Server logic:** write headless bots with `ws` in the scratchpad.
  - Run them against a server on a spare port: `PORT=3101 node server.js`.
  - A script outside the repo needs `NODE_PATH=<repo>/node_modules` (or `require` with the absolute path).
  - Attach message handlers before sending `join`.
  - Stop test servers by port (`lsof -tiTCP:3101 -sTCP:LISTEN | xargs kill`), never with `pkill node`.
- **Test hooks:**
  - Never edit project files to add hooks.
  - Copy `server.js` and/or `public/` into the scratchpad and patch the copy, for example forcing power-up kinds or spots, or pointing `PUBLIC_DIR` at a patched `public` copy.
  - Delete the copies afterwards.
- **Browser checks** (in-app browser pane):
  - **Mute first.** Set `localStorage.setItem('tagMuted','1')` and reload before interacting. Otherwise the owner hears the music, and it keeps playing until the tab closes.
  - **Hidden pane:** if the pane is hidden, `requestAnimationFrame` doesn't run. Serve a patched `public` copy whose `index.html` shims it with `setTimeout(…, 16)`.
  - **Rendering assertions:** to check what gets drawn, wrap `window.drawCharacter` and capture snapshots by wrapping `window.WebSocket` in that shim.
- **Clean up** when done: close browser tabs, kill test servers and bots, and remove scratch files.

## Conventions

- **Code style:** plain JS with `'use strict'`, 2-space indent, single quotes and semicolons. Comments explain *why* and are kept sparse, with one-line section banners in long files. Match the surrounding code.
- **Git:**
  - Make each feature on its own branch.
  - Commit, merge into `main`, push or rebuild the Docker image only when the owner asks.
  - End commit messages with the attribution trailer the harness gives you.
- **README:** when you add or change a player-visible feature, update the feature list in `README.md`.
