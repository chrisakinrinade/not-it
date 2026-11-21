# Tag!

A 2–8 player LAN tag platformer. Your Mac runs the server; everyone (including you) plays in a browser.

## Run

```bash
npm install   # first time only
npm start
```

The server prints the URLs to share, e.g. `http://192.168.1.23:3000`. Everyone on the same Wi-Fi opens that URL.
If macOS asks whether to allow incoming connections for `node`, click **Allow**.

## Play

- Enter a name and **Join**. Once 2+ players are in, anyone can press **Start game**.
- Any joined player can pick the game mode, the map (Meadow, Starry Night, Sunset Canyon, and the bigger Frosty Peaks, Jungle Ruins, Lava Caverns, Coral Reef, Candy Clouds and Neon City, marked **BIG**) and round length (30s – 3 min; default 1 min) in the lobby.
- **Classic tag**: a random player starts as **IT**. Touch someone to make them IT. Whoever is IT when the clock hits 0 loses.
- **Hot potato** 🥔: whoever is IT holds a potato with a burning fuse (5–30s, set with the +/− stepper in the lobby; press and hold to step quickly). Passing it on by tagging someone resets the fuse. When it runs out, the holder is knocked out and the potato goes to the nearest player left, who is frozen for a 3s countdown while everyone scatters. The last one standing wins (and is the only one who gets a 🏆). The fuse ticks faster as it burns down.
- Knocked-out players, and anyone who joins mid-round, watch the game: the camera follows IT, or drag the view (touch/mouse) or use the arrow keys to look around. **Follow** snaps back to IT.
- A newly tagged player is frozen for 1s, and the tagger can't be tagged straight back for 2s.
- Keyboard: ← → to run, ↑ or Space to jump (WASD also works). Tap jump for a short hop, hold for a high jump.
- **Dash** (Shift or ↓; ≫ button on touch): on the ground it's a fast, low slide (handy for slipping past IT); in the air it's a short level burst across gaps. 1.5s cooldown, shown as a ring on the button / meter in the corner. Jump out of a slide to keep its speed.
- iPhone/iPad: play in landscape with the on-screen ◀ ▶, ⤒ and ≫ buttons. Tip: Safari → Share → *Add to Home Screen* gives a full-screen view.
- Moving platforms (studded, with a dashed rail showing their path) carry you along when you stand on them: an elevator and a top shuttle on Meadow, twin sky shuttles on Starry Night, a raft across the top of Sunset Canyon, two shuttles on Frosty Peaks, a lift up the temple plus a canopy glider on Jungle Ruins, twin lift shafts and a drifting smoke cloud on Lava Caverns, bobbing jellyfish and a sweeping current on Coral Reef, a cotton-candy cloud and two gumball lifts on Candy Clouds, and a tower elevator, sky tram and crane hook on Neon City.
- Jump pads (red-capped springs) launch you about four levels straight up: two on Meadow, a "tower express" up the middle of Starry Night, one by each wall in Sunset Canyon, two extra-strong wall pads on Frosty Peaks, two on Jungle Ruins, wall pads plus an "eruption" pad on top of the volcano in Lava Caverns, a big geyser under the shipwreck in Coral Reef, bouncy gumdrops all the way up to the cherry on Candy Clouds, and two street pads in Neon City.
- **Power-ups**: one appears on a random ledge 5s into the round, and a new one appears elsewhere 8s after each pickup. Anyone can grab them, IT included. It's randomly either:
  - **Speed boots** 👟 (gold bubble): run 50% faster for 6s, with a gold speed trail.
  - **Invisibility cloak** 👻 (purple bubble): for 5s you're completely invisible to other players: no body, name, IT badge, trail or off-screen arrow, and jump pads, portals and traps don't react visibly when you use them. You see yourself see-through.
- **Traps** (all the big maps): sticky puddles of slush, mud, magma, seaweed, caramel or oil with a snail on them. Step in one and you run, slide and air-dash at half speed while you're in it and for 3s after you leave it. A 🐌 timer shows how long is left.
- Black-hole portals come in linked pairs (same color = linked). Neon City has three pairs of "subway" portals. Touch the middle of one to pop out of the other with your speed intact (jump over it to avoid it).
- **Free roam** 🌿: pick **Free roam** in the lobby's game mode buttons to see every free roam session that's running, who's in it and on which map. **Join** one, or pick a map and press **Start free roam** to start your own (you can go solo). There's no clock and nobody is ever IT; pads, portals, traps and power-ups all still work. Free roam runs alongside the main game, so several sessions and a round of tag can all be going at once (up to 8 players each). **Leave free roam** (top right) takes you back to the lobby, and a session ends when its last player leaves.
- People who join mid-round watch and play from the next round.
- After each round a scoreboard shows everyone's time as IT, tags made, and session wins (🏆). Everyone except the loser gets a win. Wins are kept by name until the server restarts.
- Sound effects for tags, jumps, landings, traps, the 3-2-1-GO countdown and the last 5 seconds.
- Music: a chill lobby loop, an upbeat in-game loop that speeds up in the last 10s, and a win/lose jingle. Toggle with the 🔊 button or **M**. On iPhone, the ring/silent switch must be on ring to hear it.

## Code

- `server.js` runs the game: static files, WebSocket, physics, and tag rules at 60 ticks/s. Tuning constants are at the top.
- `public/client.js` handles the lobby UI, input (keyboard and touch), and canvas rendering with snapshot interpolation.
- `public/characters.js` draws the cartoon characters.
- `public/maps.js` draws each map's theme (sky, scenery, platforms, portals). Map layouts live in `MAPS` in `server.js`; a map can set its own `world` size.
- `public/music.js` generates the chiptune music with the Web Audio API (no audio files).

`ROUND_SECONDS=20 npm start` sets the starting round length (any number of seconds, handy for testing). The lobby choices are `ROUND_OPTIONS` in `server.js`. `PORT=4000 npm start` changes the port.
