'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const canvas = $('#canvas');
  const ctx = canvas.getContext('2d');

  const INTERP_DELAY_MS = 50; // render slightly in the past to smooth network jitter
  const isTouch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  document.body.classList.toggle('touch', isTouch);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let ws = null;
  let myId = null;
  let world = { width: 960, height: 540 };
  let view = { width: 960, height: 540 };
  let maps = {}; // id -> { name, theme, platforms, portals }
  let pSize = { w: 34, h: 38 };
  let roundOptions = [30, 60, 90, 120, 180];
  let dashCooldown = 1.5;
  let maxPlayers = 8;
  let room = { phase: 'lobby', players: [], itId: null, loserId: null, loserName: null };
  let joined = false;
  let wantJoin = false; // re-join automatically after a reconnect
  const snaps = [];
  let clockOffset = null;
  let toastTimer = null;
  let lastMusicPhase = null;

  const savedName = () => {
    try { return localStorage.getItem('tagName') || ''; } catch { return ''; }
  };
  const saveName = (n) => {
    try { localStorage.setItem('tagName', n); } catch {}
  };
  const playerInfo = (id) => room.players.find((p) => p.id === id);
  const nameOf = (id) => playerInfo(id)?.name ?? '???';

  // ---------------------------------------------------------------------------
  // Networking
  // ---------------------------------------------------------------------------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => { $('#conn').hidden = true; };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = () => {
      myId = null;
      joined = false;
      $('#conn').textContent = 'Disconnected — reconnecting…';
      $('#conn').hidden = false;
      setTimeout(connect, 1000);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function handle(m) {
    switch (m.t) {
      case 'welcome':
        myId = m.id;
        world = m.world;
        view = m.view || m.world;
        maps = m.maps;
        pSize = m.player;
        roundOptions = m.roundOptions || roundOptions;
        dashCooldown = m.dashCooldown || dashCooldown;
        maxPlayers = m.maxPlayers || maxPlayers;
        snaps.length = 0;
        clockOffset = null;
        if (wantJoin) send({ t: 'join', name: savedName() });
        break;
      case 'room':
        if (m.phase === 'ready' && room.phase !== 'ready') cam.ready = false; // players respawned: snap camera
        room = m;
        joined = room.players.some((p) => p.id === myId);
        if (room.phase === 'lobby') snaps.length = 0;
        renderUI();
        break;
      case 'snap': {
        const d = performance.now() - m.st;
        // Track the smallest observed delay (least-jittery estimate), letting it creep up slowly
        clockOffset = clockOffset === null ? d : Math.min(d, clockOffset + 0.5);
        snaps.push(m);
        if (snaps.length > 60) snaps.shift();
        break;
      }
      case 'tag':
        showToast(m.to === myId ? "You're IT! 🏃" : `${nameOf(m.from)} tagged ${nameOf(m.to)}!`);
        if (m.to === myId) Music.sfx('tagged');
        else if (m.from === myId) Music.sfx('tag');
        else Music.sfx('tag', 0.5);
        break;
      case 'powerup':
        if (m.kind === 'cloak') {
          showToast(m.id === myId ? "You're invisible! 👻" : `${nameOf(m.id)} vanished! 👻`);
          if (m.id === myId) Music.sfx('cloak');
        } else {
          showToast(m.id === myId ? 'Speed boots! 👟' : `${nameOf(m.id)} grabbed speed boots! 👟`);
          if (m.id === myId) Music.sfx('powerup');
        }
        break;
      case 'notice':
        showToast(m.msg);
        break;
      case 'error':
        $('#lobbyError').textContent = m.msg;
        $('#lobbyError').hidden = false;
        wantJoin = false;
        break;
    }
  }

  function showToast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
  }

  // ---------------------------------------------------------------------------
  // UI (lobby + overlays)
  // ---------------------------------------------------------------------------
  function iconCanvas(charIndex, size) {
    const c = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    paintIcon(c, charIndex, size);
    return c;
  }

  function paintIcon(c, charIndex, size) {
    const g = c.getContext('2d');
    const scale = c.width / size;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    const s = (size / 52) * scale; // character + head feature fits in ~52 units
    g.setTransform(s, 0, 0, s, 0, 0);
    drawCharacter(g, charIndex, 9, 12, 34, 38, { facing: 1, time: 0.3 });
  }

  function renderUI() {
    const inGame = room.phase !== 'lobby' && joined;
    $('#lobby').hidden = inGame;
    $('#game').hidden = !inGame;
    document.body.classList.toggle('in-game', inGame);
    if (inGame && document.activeElement instanceof HTMLElement) document.activeElement.blur();

    // One tile per player; the list grows as people join
    const list = $('#playerList');
    list.replaceChildren();
    for (const p of room.players) {
      const li = document.createElement('li');
      const isMe = p.id === myId;
      const canChange = isMe && room.phase === 'lobby';
      if (isMe) li.classList.add('me');
      const icon = iconCanvas(p.char, 48);
      if (canChange) {
        // Tap your own avatar to cycle through the free characters
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'avatar-btn';
        btn.title = 'Change character';
        btn.setAttribute('aria-label', `Change character (currently ${CHARACTERS[p.char].name})`);
        btn.append(icon);
        btn.addEventListener('click', () => send({ t: 'avatar', dir: 1 }));
        li.append(btn);
      } else {
        li.append(icon);
      }
      const info = document.createElement('div');
      info.style.minWidth = '0';
      const name = document.createElement('div');
      name.className = 'pname';
      name.textContent = p.name;
      info.append(name);
      const tagText = [
        CHARACTERS[p.char].name,
        isMe ? 'you' : '',
        p.waiting ? 'next round' : '',
        p.wins ? `🏆 ${p.wins}` : '',
      ].filter(Boolean).join(' · ');
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = tagText;
      info.append(tag);
      if (canChange) {
        const hint = document.createElement('span');
        hint.className = 'tag change-hint';
        hint.textContent = 'tap to change';
        info.append(hint);
      }
      li.append(info);
      list.append(li);
    }
    list.hidden = room.players.length === 0;

    renderRoundOptions();
    renderMapOptions();

    const count = room.players.length;
    const full = count >= maxPlayers;
    $('#joinForm').hidden = joined;
    $('#joinBtn').disabled = full;
    $('#nameInput').disabled = full;
    $('#leaveBtn').hidden = !joined;
    $('#startBtn').hidden = !joined || room.phase !== 'lobby';
    $('#startBtn').disabled = count < 2;
    if (joined) $('#lobbyError').hidden = true;

    let status;
    if (room.phase !== 'lobby' && !joined) {
      status = full ? 'A round is in progress and the game is full.' : 'A round is in progress — join now to play in the next one.';
    } else if (full && !joined) status = 'Game is full.';
    else if (count < 2) status = 'Waiting for at least 2 players…';
    else if (!joined) status = `${count}/${maxPlayers} players — join to play!`;
    else status = `${count}/${maxPlayers} players — anyone can start the game.`;
    $('#lobbyStatus').textContent = status;

    // In-game banner for players waiting for the next round
    const me = playerInfo(myId);
    const waiting = me?.waiting && room.phase !== 'ended';
    $('#banner').hidden = !waiting;
    $('#banner').textContent = "You're in! Watching this round — you'll play the next one.";

    // End-of-round overlay
    const ended = room.phase === 'ended';
    $('#endOverlay').hidden = !ended;
    if (ended) {
      const loser = playerInfo(room.loserId);
      if (room.loserId === myId) {
        $('#endTitle').textContent = 'You were IT — you lose! 😵';
        $('#endSub').textContent = 'Better luck next round.';
      } else {
        $('#endTitle').textContent = `${room.loserName ?? 'Someone'} was IT — they lose!`;
        $('#endSub').textContent = me && !me.waiting ? 'You win! 🎉' : 'Everyone else wins.';
      }
      const icon = $('#loserIcon');
      icon.hidden = !loser;
      if (loser) {
        const dpr = window.devicePixelRatio || 1;
        icon.width = 96 * dpr;
        icon.height = 96 * dpr;
        paintIcon(icon, loser.char, 96);
      }
      $('#restartBtn').disabled = count < 2;
    }
    renderResults();

    $('#touch').hidden = !(isTouch && inGame && !ended);
    if (!inGame || ended) clearInputs();

    updateMusic(inGame);
  }

  function updateMusic(inGame) {
    const musicPhase = !inGame ? 'lobby' : room.phase === 'ended' ? 'ended' : 'game';
    if (musicPhase === lastMusicPhase) return;
    lastMusicPhase = musicPhase;
    if (musicPhase === 'ended') {
      const me = playerInfo(myId);
      Music.jingle(!!me && !me.waiting && room.loserId !== myId);
    } else {
      Music.play(musicPhase);
    }
  }

  // Audio may only start after a user gesture (required on iOS)
  for (const ev of ['pointerdown', 'touchend', 'keydown']) {
    addEventListener(ev, () => Music.unlock(), { capture: true });
  }
  const muteBtn = $('#muteBtn');
  const syncMuteBtn = () => {
    muteBtn.textContent = Music.isMuted() ? '🔇' : '🔊';
    muteBtn.setAttribute('aria-label', Music.isMuted() ? 'Unmute music' : 'Mute music');
  };
  const toggleMute = () => {
    Music.toggleMute();
    syncMuteBtn();
  };
  syncMuteBtn();
  muteBtn.addEventListener('click', (e) => {
    e.currentTarget.blur();
    toggleMute();
  });
  addEventListener('keydown', (e) => {
    if (e.code === 'KeyM' && !e.repeat && !(e.target instanceof HTMLInputElement)) toggleMute();
  });

  const formatRound = (secs) => (secs < 60 ? `${secs}s` : `${secs / 60} min`.replace('1.5 min', '1½ min'));

  // End-of-round scoreboard: time spent as IT, tags made, session wins
  function renderResults() {
    const box = $('#results');
    const rows = room.phase === 'ended' ? room.results || [] : [];
    box.hidden = !rows.length;
    box.replaceChildren();
    if (!rows.length) return;
    const table = document.createElement('table');
    const head = table.insertRow();
    for (const label of ['', 'Player', 'Time as IT', 'Tags', '🏆']) {
      const th = document.createElement('th');
      th.textContent = label;
      head.append(th);
    }
    for (const r of rows) {
      const tr = table.insertRow();
      if (r.id === room.loserId) tr.className = 'loser';
      if (r.id === myId) tr.classList.add('me');
      tr.insertCell().append(iconCanvas(r.char, 28));
      tr.insertCell().textContent = r.id === myId ? `${r.name} (you)` : r.name;
      tr.insertCell().textContent = `${r.itTime.toFixed(1)}s`;
      tr.insertCell().textContent = r.tags;
      tr.insertCell().textContent = playerInfo(r.id)?.wins ?? '–';
    }
    box.append(table);
  }

  function renderRoundOptions() {
    const box = $('#roundOptions');
    const canEdit = joined && room.phase === 'lobby';
    box.replaceChildren();
    for (const secs of roundOptions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(secs === room.roundSeconds));
      btn.textContent = formatRound(secs);
      btn.disabled = !canEdit;
      btn.addEventListener('click', () => send({ t: 'roundLength', seconds: secs }));
      box.append(btn);
    }
    $('#roundLabel').textContent = canEdit ? 'Round length' : 'Round length (join to change)';
  }

  function renderMapOptions() {
    const box = $('#mapOptions');
    const canEdit = joined && room.phase === 'lobby';
    box.replaceChildren();
    for (const [id, map] of Object.entries(maps)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'map-card';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(id === room.mapId));
      btn.disabled = !canEdit;
      const thumb = document.createElement('canvas');
      const dpr = window.devicePixelRatio || 1;
      thumb.width = 120 * dpr;
      thumb.height = 68 * dpr;
      const g = thumb.getContext('2d');
      g.scale(dpr, dpr);
      drawMapPreview(g, map, world, 120, 68);
      const label = document.createElement('span');
      label.textContent = map.name;
      btn.append(thumb, label);
      btn.addEventListener('click', () => send({ t: 'map', id }));
      box.append(btn);
    }
    $('#mapLabel').textContent = canEdit ? 'Map' : 'Map (join to change)';
  }

  $('#nameInput').value = savedName();

  $('#joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#nameInput').value.trim();
    if (!name) {
      $('#nameInput').focus();
      return;
    }
    saveName(name);
    wantJoin = true;
    $('#lobbyError').hidden = true;
    send({ t: 'join', name });
    $('#nameInput').blur();
  });

  const onClick = (sel, fn) =>
    $(sel).addEventListener('click', (e) => {
      e.currentTarget.blur(); // don't let Space re-trigger a focused button mid-game
      fn();
    });
  onClick('#startBtn', () => send({ t: 'start' }));
  onClick('#leaveBtn', () => {
    wantJoin = false;
    send({ t: 'leave' });
  });
  onClick('#restartBtn', () => send({ t: 'restart' }));
  onClick('#lobbyBtn', () => send({ t: 'lobby' }));

  // ---------------------------------------------------------------------------
  // Input: keyboard + touch
  // ---------------------------------------------------------------------------
  const keys = { left: false, right: false, jump: false, dash: false };
  const touch = { left: false, right: false, jump: false, dash: false };
  let lastSent = '';

  function pushInput() {
    const input = {
      left: keys.left || touch.left,
      right: keys.right || touch.right,
      jump: keys.jump || touch.jump,
      dash: keys.dash || touch.dash,
    };
    const key = `${+input.left}${+input.right}${+input.jump}${+input.dash}`;
    if (key === lastSent) return;
    lastSent = key;
    send({ t: 'input', ...input });
  }

  function clearInputs() {
    keys.left = keys.right = keys.jump = keys.dash = false;
    touch.left = touch.right = touch.jump = touch.dash = false;
    document.querySelectorAll('.tbtn.active').forEach((b) => b.classList.remove('active'));
    pushInput();
  }

  const KEY_MAP = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'jump', KeyW: 'jump', Space: 'jump',
    ShiftLeft: 'dash', ShiftRight: 'dash', ArrowDown: 'dash', KeyS: 'dash',
  };

  function onKey(e, down) {
    if (e.target instanceof HTMLInputElement) return;
    const k = KEY_MAP[e.code];
    if (!k || $('#game').hidden) return;
    e.preventDefault();
    keys[k] = down;
    pushInput();
  }
  addEventListener('keydown', (e) => onKey(e, true));
  addEventListener('keyup', (e) => onKey(e, false));
  addEventListener('blur', clearInputs);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearInputs(); });

  // Recompute pressed buttons from every active touch, so sliding a thumb
  // from ◀ to ▶ switches direction without lifting.
  function onTouch(e) {
    e.preventDefault();
    const next = { left: false, right: false, jump: false, dash: false };
    for (const t of e.touches) {
      const el = document.elementFromPoint(t.clientX, t.clientY);
      const k = el?.closest?.('[data-key]')?.dataset.key;
      if (k) next[k] = true;
    }
    Object.assign(touch, next);
    document.querySelectorAll('.tbtn').forEach((b) => b.classList.toggle('active', next[b.dataset.key]));
    pushInput();
  }
  for (const pad of document.querySelectorAll('.pad')) {
    for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      pad.addEventListener(ev, onTouch, { passive: false });
    }
  }
  // Block pinch-zoom / double-tap-zoom gestures on iOS during play
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  $('#game').addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function interpolatedState() {
    if (!snaps.length) return null;
    const latest = snaps[snaps.length - 1];
    const rt = performance.now() - clockOffset - INTERP_DELAY_MS;
    let a = null;
    let b = null;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].st <= rt) {
        a = snaps[i];
        b = snaps[i + 1] ?? null;
        break;
      }
    }
    if (!a) a = snaps[0];
    if (!b) return { ...latest, players: a.players, mp: a.mp };
    const k = (rt - a.st) / (b.st - a.st);
    const byId = new Map(b.players.map((p) => [p.id, p]));
    const mpB = new Map((b.mp || []).map((m) => [m[0], m]));
    return {
      ...latest, // phase / timer / itId from newest data
      mp: (a.mp || []).map(([i, x, y]) => {
        const m = mpB.get(i);
        return m ? [i, x + (m[1] - x) * k, y + (m[2] - y) * k] : [i, x, y];
      }),
      players: a.players.map((pa) => {
        const pb = byId.get(pa.id);
        if (!pb || pb.tp !== pa.tp) return pb ?? pa; // teleported: jump straight there
        return { ...pb, x: pa.x + (pb.x - pa.x) * k, y: pa.y + (pb.y - pa.y) * k };
      }),
    };
  }

  let viewScale = 1;
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    viewScale = Math.min(vw / view.width, vh / view.height);
    const cssW = Math.floor(view.width * viewScale);
    const cssH = Math.floor(view.height * viewScale);
    if (canvas.style.width !== `${cssW}px` || canvas.width !== Math.round(cssW * dpr)) {
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(viewScale * dpr, 0, 0, viewScale * dpr, 0, 0);
  }

  // ---- Camera: follows you (or whoever is IT when spectating) ----
  const cam = { x: 0, y: 0, ready: false };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function cameraTargetId(state) {
    return state.players.some((p) => p.id === myId) ? myId : state.itId;
  }

  function updateCamera(state, dt) {
    const target = state.players.find((p) => p.id === cameraTargetId(state));
    if (!target) return;
    const tx = clamp(target.x + pSize.w / 2 - view.width / 2, 0, Math.max(0, world.width - view.width));
    const ty = clamp(target.y + pSize.h / 2 - view.height * 0.55, 0, Math.max(0, world.height - view.height));
    if (!cam.ready) {
      cam.x = tx;
      cam.y = ty;
      cam.ready = true;
    } else {
      const k = 1 - Math.exp(-dt * 10); // smooth, frame-rate independent follow
      cam.x += (tx - cam.x) * k;
      cam.y += (ty - cam.y) * k;
    }
  }

  const currentMap = () => maps[room.mapId] || Object.values(maps)[0];

  // The map's platforms with moving ones placed where the latest snapshot says
  function livePlatforms(map, state) {
    if (!state?.mp?.length) return map.platforms;
    const moved = map.platforms.slice();
    for (const [i, x, y] of state.mp) if (moved[i]) moved[i] = { ...moved[i], x, y };
    return moved;
  }

  function drawLabel(text, x, y, color, size = 13) {
    ctx.font = `800 ${size}px ui-rounded, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(20, 26, 44, 0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  // How visible each cloaked player's shimmer is (0 = gone, 1 = faint shimmer).
  // Running along the ground fades it out; standing still or jumping fades it back in.
  const shimmer = new Map();
  let lastShimmerTime = 0;

  function drawPlayers(state, time) {
    const dt = Math.min(0.1, Math.max(0, time - lastShimmerTime));
    lastShimmerTime = time;
    // Draw IT last so it's always on top
    const list = [...state.players].sort((a, b) => (a.id === state.itId) - (b.id === state.itId));
    for (const p of list) {
      const info = playerInfo(p.id);
      if (!info) continue;
      const isIt = p.id === state.itId;
      const opts = {
        facing: p.f,
        time,
        running: p.g && Math.abs(p.vx) > 30,
        airborne: !p.g,
        it: isIt,
        frozen: !!p.fr,
        immune: !!p.im,
      };
      const cx = p.x + pSize.w / 2;
      const feetY = p.y + pSize.h;
      const isMe = p.id === myId;
      // Invisibility cloak: others see only a faint shimmer; you see yourself see-through
      const hidden = p.iv > 0 && !isMe;
      let level = 1;
      if (hidden) {
        const runningOnGround = p.g && Math.abs(p.vx) > 30;
        const prev = shimmer.get(p.id) ?? 1;
        level = prev + ((runningOnGround ? 0 : 1) - prev) * Math.min(1, dt * 12); // ~0.1s fade
        shimmer.set(p.id, level);
        if (level < 0.03) continue; // fully invisible while running
      } else {
        shimmer.delete(p.id);
      }
      ctx.save();
      if (p.iv > 0) ctx.globalAlpha = hidden ? 0.1 * level : 0.45;
      if (p.sp > 0 && !hidden) {
        // Speed boots: golden glow underfoot + speed lines when moving
        ctx.fillStyle = 'rgba(255, 224, 102, 0.5)';
        fillEllipse(ctx, cx, feetY - 1, 20, 4);
        if (Math.abs(p.vx) > 60) {
          const dirX = Math.sign(p.vx);
          ctx.strokeStyle = 'rgba(255, 212, 59, 0.8)';
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          ctx.beginPath();
          for (let k = 0; k < 3; k++) {
            const ly = p.y + 10 + k * 9;
            const x0 = cx - dirX * (20 + (k % 2) * 4);
            ctx.moveTo(x0, ly);
            ctx.lineTo(x0 - dirX * (16 + (k === 1 ? 12 : 0)), ly);
          }
          ctx.stroke();
        }
      }
      if (p.dm === 1) {
        // Slide: squashed toward the feet, kicking up dust
        ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
        for (let k = 0; k < 3; k++) fillEllipse(ctx, cx - p.f * (24 + k * 11), feetY - 4 - k * 2, 6 - k * 1.5, 4 - k);
        ctx.save();
        ctx.translate(cx, feetY);
        ctx.scale(1.25, 0.6);
        ctx.translate(-cx, -feetY);
        drawCharacter(ctx, info.char, p.x, p.y, pSize.w, pSize.h, opts);
        ctx.restore();
      } else if (p.dm === 2) {
        // Air dash: afterimages trailing behind + a horizontal stretch
        for (const [off, alpha] of [[30, 0.15], [15, 0.3]]) {
          ctx.save();
          ctx.globalAlpha *= alpha;
          drawCharacter(ctx, info.char, p.x - p.f * off, p.y, pSize.w, pSize.h, opts);
          ctx.restore();
        }
        const cy = p.y + pSize.h / 2;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1.2, 0.88);
        ctx.translate(-cx, -cy);
        drawCharacter(ctx, info.char, p.x, p.y, pSize.w, pSize.h, opts);
        ctx.restore();
      } else {
        drawCharacter(ctx, info.char, p.x, p.y, pSize.w, pSize.h, opts);
      }
      ctx.restore();
      if (hidden) {
        // A few twinkles are the only giveaway; no name, badge or trail
        ctx.fillStyle = `rgba(255, 255, 255, ${0.85 * level})`;
        for (let k = 0; k < 3; k++) {
          const ph = time * 1.7 + k * 2.1 + p.id;
          const twinkle = Math.sin(ph * 2);
          if (twinkle < 0.3) continue;
          drawStar(ctx, cx + Math.sin(ph * 1.3) * 16, p.y + 6 + ((k * 13 + time * 10) % 30), 1.5 + 2 * twinkle);
        }
        continue;
      }
      const topY = p.dm === 1 ? p.y + pSize.h * 0.4 : p.y; // labels drop with a slide

      const label = isMe ? `${info.name} (you)` : info.name;
      ctx.font = '800 13px ui-rounded, system-ui, sans-serif';
      const half = ctx.measureText(label).width / 2 + 3;
      const lx = clamp(cx, half, world.width - half); // keep labels inside the world edges
      drawLabel(label, lx, topY - 14, isMe ? '#ffe066' : '#ffffff');

      if (isIt) {
        const bx = clamp(cx, 18, world.width - 18);
        const by = topY - 40 + Math.sin(time * 6) * 3;
        ctx.fillStyle = '#e03131';
        roundRectPath(ctx, bx - 16, by - 13, 32, 18, 7);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(bx - 5, by + 5);
        ctx.lineTo(bx + 5, by + 5);
        ctx.lineTo(bx, by + 10);
        ctx.closePath();
        ctx.fill();
        ctx.font = '900 13px ui-rounded, system-ui, sans-serif';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText('IT!', bx, by + 1);
      }
    }
  }

  // ---- Sound effects driven by game state ----
  const heard = { sp: 0, iv: 0, dc: null, jc: null, g: null, count: null, tick: null, phase: null };

  function detectSounds(state) {
    const me = state.players.find((p) => p.id === myId);
    if (me) {
      if (heard.dc !== null && me.dc !== heard.dc) Music.sfx(me.dm === 2 ? 'airdash' : 'slide');
      if (heard.jc !== null && me.jc !== heard.jc) Music.sfx('jump');
      else if (heard.g === 0 && me.g === 1 && me.dm !== 1) Music.sfx('land');
      const wornOff = (heard.sp > 0 && me.sp === 0) || (heard.iv > 0 && me.iv === 0);
      if (wornOff && state.phase === 'playing') Music.sfx('powerdown');
      heard.sp = me.sp;
      heard.iv = me.iv;
      heard.dc = me.dc;
      heard.jc = me.jc;
      heard.g = me.g;
    } else {
      heard.jc = heard.g = heard.dc = null;
    }

    // 3-2-1 beeps, then GO!
    if (state.phase === 'ready') {
      const n = Math.ceil(state.timeLeft);
      if (n !== heard.count && n >= 1 && n <= 3) Music.sfx('beep');
      heard.count = n;
    } else if (state.phase === 'playing' && heard.phase === 'ready') {
      Music.sfx('go');
    }

    // Clock ticks for the final 5 seconds (louder on the last one)
    if (state.phase === 'playing' && state.timeLeft <= 5) {
      const secs = Math.ceil(state.timeLeft);
      if (secs !== heard.tick && secs >= 1) Music.sfx('tick', secs === 1 ? 1.8 : 1);
      heard.tick = secs;
    } else {
      heard.tick = null;
    }
    heard.phase = state.phase;
  }

  // ---- Jump pads: pop the pad that launched someone (and boing if it was you) ----
  const padLaunchedAt = [];
  const lastBoosts = new Map(); // player id -> launch count last seen

  function detectPadLaunches(state) {
    const pads = currentMap()?.pads || [];
    for (const p of state.players) {
      const prev = lastBoosts.get(p.id);
      lastBoosts.set(p.id, p.bc);
      if (prev === undefined || prev === p.bc || !pads.length) continue;
      // The pad nearest this player's feet is the one that fired
      const cx = p.x + pSize.w / 2;
      let best = 0;
      pads.forEach((pad, i) => {
        if (Math.abs(pad.x + pad.w / 2 - cx) < Math.abs(pads[best].x + pads[best].w / 2 - cx)) best = i;
      });
      padLaunchedAt[best] = performance.now();
      if (p.id === myId) Music.sfx('boing');
    }
  }

  // ---- Portals (black holes) ----
  const lastTeleports = new Map(); // player id -> teleport count last seen
  let portalFlashUntil = 0;

  function detectTeleports(state) {
    for (const p of state.players) {
      const prev = lastTeleports.get(p.id);
      lastTeleports.set(p.id, p.tp);
      if (prev === undefined || prev === p.tp) continue;
      portalFlashUntil = performance.now() + 400;
      if (p.id === cameraTargetId(state)) cam.ready = false; // snap the view to the exit
      if (p.id === myId) Music.whoosh();
    }
  }

  // Edge-of-screen markers pointing at players outside the view
  function drawOffscreenArrows(state, time) {
    const followId = cameraTargetId(state);
    const cx = view.width / 2;
    const cy = view.height / 2;
    const L = 30, R = view.width - 30, T = 76, B = view.height - 30; // keep clear of the HUD
    for (const p of state.players) {
      if (p.id === followId) continue;
      const info = playerInfo(p.id);
      if (!info) continue;
      const onScreen =
        p.x + pSize.w > cam.x && p.x < cam.x + view.width &&
        p.y + pSize.h > cam.y && p.y < cam.y + view.height;
      if (onScreen || p.iv > 0) continue; // invisible players don't get an arrow either

      const dx = p.x + pSize.w / 2 - cam.x - cx;
      const dy = p.y + pSize.h / 2 - cam.y - cy;
      const tx = dx > 0 ? (R - cx) / dx : dx < 0 ? (L - cx) / dx : Infinity;
      const ty = dy > 0 ? (B - cy) / dy : dy < 0 ? (T - cy) / dy : Infinity;
      const t = Math.min(tx, ty);
      const isIt = p.id === state.itId;
      const c = CHARACTERS[info.char % CHARACTERS.length];
      const pulse = isIt ? 1 + Math.sin(time * 8) * 0.08 : 1;

      ctx.save();
      ctx.translate(cx + dx * t, cy + dy * t);
      ctx.scale(pulse, pulse);

      ctx.save();
      ctx.rotate(Math.atan2(dy, dx));
      ctx.fillStyle = isIt ? '#e03131' : c.dark;
      ctx.beginPath();
      ctx.moveTo(31, 0);
      ctx.lineTo(17, -10);
      ctx.lineTo(17, 10);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(0, 0, 19, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(20, 26, 44, 0.75)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = isIt ? '#e03131' : c.body;
      ctx.stroke();

      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, 17, 0, Math.PI * 2);
      ctx.clip();
      ctx.scale(0.62, 0.62);
      drawCharacter(ctx, info.char, -pSize.w / 2, -pSize.h / 2 + 3, pSize.w, pSize.h, {
        facing: dx < 0 ? -1 : 1, time, it: isIt, frozen: !!p.fr,
      });
      ctx.restore();

      ctx.restore();
    }
  }

  // Dash cooldown: fills the touch button's ring, or a small meter for keyboard players
  const dashBtn = $('[data-key="dash"]');
  function updateDashMeter(state) {
    const me = state.players.find((p) => p.id === myId);
    const ready = me ? clamp(1 - me.cd / dashCooldown, 0, 1) : 1;
    dashBtn.style.setProperty('--ready', ready.toFixed(3));
    dashBtn.classList.toggle('ready', ready >= 1);
    if (isTouch || !me || state.phase === 'ended') return;

    const x = 38;
    const y = view.height - 46;
    ctx.fillStyle = 'rgba(20, 26, 44, 0.75)';
    fillEllipse(ctx, x, y, 22, 22);
    ctx.strokeStyle = ready >= 1 ? '#ffe066' : 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, y, 19, -Math.PI / 2, -Math.PI / 2 + ready * Math.PI * 2);
    ctx.stroke();
    ctx.font = '900 16px ui-rounded, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = ready >= 1 ? '#ffe066' : 'rgba(255, 255, 255, 0.6)';
    ctx.fillText('≫', x, y + 1);
    ctx.textBaseline = 'alphabetic';
    drawLabel('Shift', x, view.height - 9, 'rgba(255, 255, 255, 0.85)', 11);
  }

  function drawHud(state, time) {
    const cx = view.width / 2;

    if (state.phase === 'ready') {
      ctx.fillStyle = 'rgba(15, 20, 36, 0.35)';
      ctx.fillRect(0, 0, view.width, view.height);
      const n = Math.max(1, Math.ceil(state.timeLeft));
      drawLabel(String(n), cx, 250, '#ffffff', 96);
      const itName = state.itId === myId ? 'You are' : `${nameOf(state.itId)} is`;
      drawLabel(`${itName} IT — get ready!`, cx, 300, '#ffe066', 26);
      return;
    }

    // Timer pill
    const secs = Math.ceil(state.timeLeft);
    const label = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const urgent = state.phase === 'playing' && secs <= 10;
    const pulse = urgent ? 1 + Math.max(0, Math.sin(time * 10)) * 0.08 : 1;
    ctx.save();
    ctx.translate(cx, 32);
    ctx.scale(pulse, pulse);
    ctx.fillStyle = urgent ? '#e03131' : 'rgba(20, 26, 44, 0.8)';
    roundRectPath(ctx, -52, -22, 104, 44, 22);
    ctx.fill();
    ctx.font = '900 28px ui-rounded, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(label, 0, 2);
    ctx.restore();
    ctx.textBaseline = 'alphabetic';

    // Who's IT
    const it = playerInfo(state.itId);
    if (it) {
      ctx.fillStyle = 'rgba(20, 26, 44, 0.8)';
      roundRectPath(ctx, 12, 12, 170, 40, 20);
      ctx.fill();
      ctx.save();
      ctx.translate(20, 15);
      ctx.scale(0.62, 0.62);
      drawCharacter(ctx, it.char, 0, 8, pSize.w, pSize.h, { facing: 1, time, it: true });
      ctx.restore();
      ctx.font = '800 16px ui-rounded, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#fff';
      const who = state.itId === myId ? 'YOU' : it.name;
      ctx.fillText(`IT: ${who}`, 50, 38, 124);
    }

    // Your power-up countdowns (speed boots, invisibility)
    const me = state.players.find((p) => p.id === myId);
    if (me && state.phase === 'playing') {
      const active = [[drawBoot, me.sp], [drawGhost, me.iv]].filter(([, secs]) => secs > 0);
      active.forEach(([icon, secs], i) => {
        const y = 58 + i * 36;
        ctx.fillStyle = 'rgba(20, 26, 44, 0.8)';
        roundRectPath(ctx, 12, y, 84, 30, 15);
        ctx.fill();
        icon(ctx, 34, y + 14, 0.9);
        ctx.font = '800 15px ui-rounded, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillStyle = secs <= 1.5 && Math.floor(time * 6) % 2 ? '#ff8787' : '#ffe066';
        ctx.fillText(`${Math.ceil(secs)}s`, 54, y + 20);
      });
    }

    if (state.phase === 'playing' && room.roundSeconds - state.timeLeft < 0.8) {
      drawLabel('GO!', cx, 280, '#ffe066', 90);
    }
  }

  let lastFrameTime = performance.now();
  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;
    if ($('#game').hidden) return;
    const time = now / 1000;
    resizeCanvas();
    const state = interpolatedState();
    if (state) {
      detectTeleports(state);
      detectSounds(state);
      detectPadLaunches(state);
      updateCamera(state, dt);
    }

    const map = currentMap();
    if (!map) return;
    const theme = themeFor(map);
    drawSkyLayer(ctx, theme, view.width, view.height, cam.x, cam.y, time);
    ctx.save();
    ctx.translate(-cam.x, -cam.y);
    drawScenery(ctx, theme, map.platforms);
    drawRails(ctx, map.platforms);
    drawPlatformsThemed(ctx, theme, livePlatforms(map, state));
    drawPads(ctx, map.pads || [], time, padLaunchedAt);
    if (state?.pu) drawPowerupPickup(ctx, state.pu, time);
    drawPortalsThemed(ctx, map.portals, time, Math.max(0, (portalFlashUntil - now) / 400));
    if (state) drawPlayers(state, time);
    ctx.restore();

    if (state) {
      Music.setUrgent(state.phase === 'playing' && state.timeLeft <= 10);
      drawOffscreenArrows(state, time);
      updateDashMeter(state);
      drawHud(state, time);
    }
  }

  connect();
  requestAnimationFrame(frame);
})();
