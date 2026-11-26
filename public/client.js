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
  let dashCooldown = 1.5;
  let maxPlayers = 8;
  let room = { phase: 'lobby', players: [], itId: null, loserId: null, loserName: null };
  let joined = false;
  let wantJoin = false; // re-join automatically after a reconnect
  const snaps = [];
  let clockOffset = null;
  let toastTimer = null;
  let lastMusicPhase = null;
  // Spectating (knocked out, or waiting for the next round): follow IT until you pan the view yourself
  let spectating = false;
  let freeCam = false;
  const panKeys = { left: false, right: false, up: false, down: false };
  const booms = []; // hot potato explosions: { x, y, at }
  const shieldPops = []; // shields that just blocked a tag: { x, y, at }
  let shakeUntil = 0;
  let goUntil = 0;
  // Free roam: sessions run alongside the main game. The lobby's Free roam button is a
  // local view (it doesn't change the main game's mode) listing them to join or start.
  let roamSessions = []; // [{ id, mapId, players: [{ name, char }] }]
  let roamView = false;
  let roamMapId = null; // map picked for a new session
  let rejoinMain = false; // was in the main game before free roam: rejoin it on the way out

  const savedName = () => {
    try { return localStorage.getItem('tagName') || ''; } catch { return ''; }
  };
  const saveName = (n) => {
    try { localStorage.setItem('tagName', n); } catch {}
  };
  const currentMap = () => maps[room.mapId] || Object.values(maps)[0];
  const worldOf = (map) => map?.world || world; // maps can be bigger than the default world
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
        dashCooldown = m.dashCooldown || dashCooldown;
        maxPlayers = m.maxPlayers || maxPlayers;
        snaps.length = 0;
        clockOffset = null;
        if (wantJoin) send({ t: 'join', name: savedName() });
        break;
      case 'room':
        if (m.roomId !== room.roomId) {
          // Switched between the main game and a free roam session: start the view afresh
          snaps.length = 0;
          booms.length = 0;
          cam.ready = false;
          freeCam = false;
          if (!m.free && rejoinMain && m.phase === 'lobby') send({ t: 'join', name: savedName() });
          if (!m.free) rejoinMain = false;
        }
        if (m.phase === 'ready' && room.phase !== 'ready') {
          cam.ready = false; // players respawned: snap camera
          freeCam = false;
        }
        room = m;
        joined = room.players.some((p) => p.id === myId);
        if (room.phase === 'lobby') snaps.length = 0;
        renderUI();
        break;
      case 'roam':
        roamSessions = m.sessions;
        if (!$('#lobby').hidden) renderUI();
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
        if (room.mode === 'potato') {
          showToast(m.to === myId ? "You've got the potato! 🥔" : `${nameOf(m.from)} passed the potato to ${nameOf(m.to)}!`);
        } else {
          showToast(m.to === myId ? "You're IT! 🏃" : `${nameOf(m.from)} tagged ${nameOf(m.to)}!`);
        }
        if (m.to === myId) Music.sfx('tagged');
        else if (m.from === myId) Music.sfx('tag');
        else Music.sfx('tag', 0.5);
        break;
      case 'powerup':
        if (m.kind === 'cloak') {
          showToast(m.id === myId ? "You're invisible! 👻" : `${nameOf(m.id)} vanished! 👻`);
          if (m.id === myId) Music.sfx('cloak');
        } else if (m.kind === 'shield') {
          showToast(m.id === myId ? 'Shield up! The next tag bounces off 🛡️' : `${nameOf(m.id)} grabbed a shield! 🛡️`);
          if (m.id === myId) Music.sfx('shield');
        } else if (m.kind === 'wings') {
          showToast(m.id === myId ? 'Wings! Jump again in mid-air 🪽' : `${nameOf(m.id)} grabbed wings! 🪽`);
          if (m.id === myId) Music.sfx('powerup');
        } else {
          showToast(m.id === myId ? 'Speed boots! 👟' : `${nameOf(m.id)} grabbed speed boots! 👟`);
          if (m.id === myId) Music.sfx('powerup');
        }
        break;
      case 'block': {
        // An invisible player's shield pops silently and unseen for everyone else
        const involved = m.to === myId || m.from === myId;
        if (m.hidden && !involved) break;
        shieldPops.push({ x: m.x, y: m.y, at: performance.now() });
        Music.sfx('shieldpop', involved ? 1 : 0.5);
        if (m.to === myId) showToast(`🛡️ Your shield blocked ${nameOf(m.from)}'s tag!`);
        else if (m.from === myId) showToast(`🛡️ ${nameOf(m.to)}'s shield blocked you!`);
        else showToast(`🛡️ ${nameOf(m.to)}'s shield blocked ${nameOf(m.from)}!`);
        break;
      }
      case 'boom':
        booms.push({ x: m.x, y: m.y, at: performance.now() });
        shakeUntil = performance.now() + 350;
        Music.sfx('boom');
        if (m.id === myId) showToast("💥 You're out!");
        else if (m.next === myId) showToast(`💥 ${nameOf(m.id)} is out — you've got the potato!`);
        else if (m.next) showToast(`💥 ${nameOf(m.id)} is out! ${nameOf(m.next)} has the potato`);
        else showToast(`💥 ${nameOf(m.id)} is out!`);
        break;
      case 'notice':
        showToast(m.msg);
        break;
      case 'error':
        $('#lobbyError').textContent = m.msg;
        $('#lobbyError').hidden = false;
        if (!joined) wantJoin = false;
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
    list.hidden = room.players.length === 0 || roamView;

    const potato = room.mode === 'potato';
    $('#lobbySub').innerHTML = roamView
      ? 'Explore any map with <strong>no clock</strong> and nobody IT. Start a session or join one.'
      : potato
        ? "Don't be holding the <strong>potato</strong> when it blows. Last one standing wins!"
        : 'Whoever is <strong>IT</strong> when the clock runs out loses.';
    renderModeOptions();
    const canEdit = joined && room.phase === 'lobby';
    roundPicker.render(room.roundSeconds ?? 60, room.roundRange || [10, 180], canEdit);
    fusePicker.render(room.fuseSeconds ?? 15, room.fuseRange || [5, 15], canEdit);
    $('#roundPicker').hidden = potato || roamView;
    $('#fusePicker').hidden = !potato || roamView;
    renderMapOptions();
    renderRoam();

    const count = room.players.length;
    const full = count >= maxPlayers;
    $('#joinForm').hidden = joined;
    $('#joinBtn').hidden = roamView;
    $('#joinBtn').disabled = full;
    $('#nameInput').disabled = full && !roamView;
    $('#leaveBtn').hidden = !joined || roamView;
    $('#startBtn').hidden = !joined || room.phase !== 'lobby' || roamView;
    $('#startBtn').disabled = count < 2;
    $('#roamNewBtn').hidden = !roamView;
    if (joined && !roamView) $('#lobbyError').hidden = true;

    let status;
    if (roamView) {
      const n = roamSessions.length;
      status = n ? `${n} free roam session${n === 1 ? '' : 's'} running.` : 'No free roam sessions yet. Start one!';
    } else if (room.phase !== 'lobby' && !joined) {
      status = full ? 'A round is in progress and the game is full.' : 'A round is in progress — join now to play in the next one.';
    } else if (full && !joined) status = 'Game is full.';
    else if (count < 2) status = 'Waiting for at least 2 players…';
    else if (!joined) status = `${count}/${maxPlayers} players — join to play!`;
    else status = `${count}/${maxPlayers} players — anyone can start the game.`;
    $('#lobbyStatus').textContent = status;

    // In-game banner for players watching: waiting for the next round, or knocked out
    const me = playerInfo(myId);
    const ended = room.phase === 'ended';
    const watching = inGame && !ended && (me?.waiting || me?.out);
    const lookHint = isTouch ? 'drag to look around' : 'arrow keys to look around';
    $('#banner').hidden = !watching;
    $('#bannerText').textContent = me?.out ? `💥 You're out — ${lookHint}` : `Watching — you'll play next round · ${lookHint}`;
    $('#followBtn').textContent = potato ? 'Follow 🥔' : 'Follow IT';

    // End-of-round overlay
    $('#endOverlay').hidden = !ended;
    if (ended) {
      let featured; // whose face goes on the card
      if (potato) {
        featured = playerInfo(room.winnerId);
        const myPlace = room.results?.find((r) => r.id === myId)?.place;
        if (room.winnerId === myId) {
          $('#endTitle').textContent = 'You win! 🥔🎉';
          $('#endSub').textContent = 'Last one standing.';
        } else if (room.winnerId) {
          $('#endTitle').textContent = `${room.winnerName} wins! 🥔`;
          $('#endSub').textContent = myPlace ? `Last one standing. You came ${ordinal(myPlace)}.` : 'Last one standing.';
        } else {
          $('#endTitle').textContent = 'Nobody wins! 💥';
          $('#endSub').textContent = '';
        }
      } else {
        featured = playerInfo(room.loserId);
        if (room.loserId === myId) {
          $('#endTitle').textContent = 'You were IT — you lose! 😵';
          $('#endSub').textContent = 'Better luck next round.';
        } else {
          $('#endTitle').textContent = `${room.loserName ?? 'Someone'} was IT — they lose!`;
          $('#endSub').textContent = me && !me.waiting ? 'You win! 🎉' : 'Everyone else wins.';
        }
      }
      const icon = $('#loserIcon');
      icon.hidden = !featured;
      if (featured) {
        const dpr = window.devicePixelRatio || 1;
        icon.width = 96 * dpr;
        icon.height = 96 * dpr;
        paintIcon(icon, featured.char, 96);
      }
      $('#restartBtn').disabled = count < 2;
    }
    renderResults();

    $('#roamLeaveBtn').hidden = !(inGame && room.free);
    $('#touch').hidden = !(isTouch && inGame && !ended && !watching);
    if (!inGame || ended) clearInputs();

    updateMusic(inGame);
  }

  function updateMusic(inGame) {
    const musicPhase = !inGame ? 'lobby' : room.phase === 'ended' ? 'ended' : room.track || 'game';
    if (musicPhase === lastMusicPhase) return;
    lastMusicPhase = musicPhase;
    if (musicPhase === 'ended') {
      const me = playerInfo(myId);
      const won = room.mode === 'potato' ? room.winnerId === myId : !!me && !me.waiting && room.loserId !== myId;
      Music.jingle(won);
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


  const ordinal = (n) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');

  // End-of-round scoreboard: time spent as IT (classic) or finishing place (hot potato), tags made, session wins
  function renderResults() {
    const box = $('#results');
    const rows = room.phase === 'ended' ? room.results || [] : [];
    box.hidden = !rows.length;
    box.replaceChildren();
    if (!rows.length) return;
    const table = document.createElement('table');
    const head = table.insertRow();
    const potato = room.mode === 'potato';
    for (const label of ['', 'Player', potato ? 'Place' : 'Time as IT', potato ? 'Passes' : 'Tags', '🏆']) {
      const th = document.createElement('th');
      th.textContent = label;
      head.append(th);
    }
    for (const r of rows) {
      const tr = table.insertRow();
      if (r.id === room.loserId) tr.className = 'loser';
      if (potato && r.place === 1) tr.className = 'winner';
      if (r.id === myId) tr.classList.add('me');
      tr.insertCell().append(iconCanvas(r.char, 28));
      tr.insertCell().textContent = r.id === myId ? `${r.name} (you)` : r.name;
      tr.insertCell().textContent = potato ? ordinal(r.place) : `${r.itTime.toFixed(1)}s`;
      tr.insertCell().textContent = r.tags;
      tr.insertCell().textContent = playerInfo(r.id)?.wins ?? '–';
    }
    box.append(table);
  }

  const MODES = [['classic', 'Classic tag'], ['potato', 'Hot potato 🥔'], ['free', 'Free roam 🌿']];

  function renderModeOptions() {
    const box = $('#modeOptions');
    const canEdit = joined && room.phase === 'lobby';
    box.replaceChildren();
    for (const [id, label] of MODES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(roamView ? id === 'free' : id === (room.mode || 'classic')));
      btn.textContent = label;
      // Free roam is always open; from it, anyone can switch back to see the main game
      btn.disabled = id !== 'free' && !canEdit && !roamView;
      btn.addEventListener('click', () => {
        if (id === 'free') {
          roamView = true;
          roamMapId ??= room.mapId;
        } else {
          roamView = false;
          if (canEdit) send({ t: 'mode', mode: id });
        }
        $('#lobbyError').hidden = true;
        renderUI();
      });
      box.append(btn);
    }
    $('#modeLabel').textContent = canEdit || roamView ? 'Game mode' : 'Game mode (join to change)';
  }

  // Free roam sessions in the lobby: who's in each one, with a Join button
  function renderRoam() {
    $('#roamPanel').hidden = !roamView;
    if (!roamView) return;
    const list = $('#roamList');
    list.replaceChildren();
    if (!roamSessions.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nobody is free roaming right now.';
      list.append(li);
    }
    for (const s of roamSessions) {
      const li = document.createElement('li');
      const faces = document.createElement('div');
      faces.className = 'faces';
      for (const p of s.players.slice(0, 4)) faces.append(iconCanvas(p.char, 32));
      const info = document.createElement('div');
      info.className = 'info';
      const name = document.createElement('div');
      name.className = 'rname';
      name.textContent = `${maps[s.mapId]?.name ?? s.mapId} · ${s.players.length}/${maxPlayers}`;
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = s.players.map((p) => p.name).join(', ');
      info.append(name, who);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Join';
      btn.disabled = s.players.length >= maxPlayers;
      btn.addEventListener('click', (e) => {
        e.currentTarget.blur();
        enterRoam({ t: 'roamJoin', id: s.id });
      });
      li.append(faces, info, btn);
      list.append(li);
    }
  }

  // Start or join a free roam session, using your name (the box, or the one you joined with)
  function enterRoam(msg) {
    const name = joined ? playerInfo(myId)?.name : $('#nameInput').value.trim();
    if (!name) {
      $('#lobbyError').textContent = 'Enter your name first.';
      $('#lobbyError').hidden = false;
      $('#nameInput').focus();
      return;
    }
    if (!joined) saveName(name);
    $('#lobbyError').hidden = true;
    rejoinMain = joined;
    send({ ...msg, name });
  }

  // A seconds picker: a static +/- stepper (rebuilding it would break press-and-hold) that
  // sends `{ t: msgType, delta: ±1 }`; the server owns the step size and the limits.
  function secondsPicker(root, msgType, label) {
    const up = root.querySelector('.step-up');
    const down = root.querySelector('.step-down');
    const value = root.querySelector('.step-value');
    let repeat = null;
    const stop = () => {
      clearTimeout(repeat);
      repeat = null;
    };
    for (const [btn, delta] of [[up, 1], [down, -1]]) {
      const step = () => send({ t: msgType, delta });
      // Press and hold to keep stepping
      btn.addEventListener('pointerdown', (e) => {
        if (btn.disabled) return;
        e.preventDefault();
        step();
        stop();
        const again = (ms) => { repeat = setTimeout(() => { if (btn.disabled) return stop(); step(); again(90); }, ms); };
        again(400);
      });
      btn.addEventListener('click', (e) => { if (e.detail === 0) step(); }); // keyboard activation
    }
    for (const ev of ['pointerup', 'pointercancel', 'blur']) addEventListener(ev, stop);
    return {
      render(secs, [lo, hi], canEdit) {
        value.textContent = secs;
        up.disabled = !canEdit || secs >= hi;
        down.disabled = !canEdit || secs <= lo;
        root.querySelector('.round-label').textContent = canEdit ? label : `${label} (join to change)`;
      },
    };
  }
  const roundPicker = secondsPicker($('#roundPicker'), 'roundLength', 'Round length');
  const fusePicker = secondsPicker($('#fusePicker'), 'fuse', 'Fuse length');

  function renderMapOptions() {
    const box = $('#mapOptions');
    const canEdit = roamView || (joined && room.phase === 'lobby'); // free roam: picks the map for a new session
    const selected = roamView ? roamMapId : room.mapId;
    box.replaceChildren();
    for (const [id, map] of Object.entries(maps)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'map-card';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(id === selected));
      btn.disabled = !canEdit;
      const thumb = document.createElement('canvas');
      const dpr = window.devicePixelRatio || 1;
      thumb.width = 120 * dpr;
      thumb.height = 68 * dpr;
      const g = thumb.getContext('2d');
      g.scale(dpr, dpr);
      drawMapPreview(g, map, worldOf(map), 120, 68);
      const label = document.createElement('span');
      label.textContent = map.name;
      if (worldOf(map).width > world.width) {
        const big = document.createElement('span');
        big.className = 'map-badge';
        big.textContent = 'BIG';
        btn.append(big);
      }
      btn.append(thumb, label);
      btn.addEventListener('click', () => {
        if (!roamView) return send({ t: 'map', id });
        roamMapId = id;
        renderMapOptions();
      });
      box.append(btn);
    }
    $('#mapLabel').textContent = roamView ? 'Map for a new session' : canEdit ? 'Map' : 'Map (join to change)';
  }

  $('#nameInput').value = savedName();

  $('#joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (roamView) return $('#nameInput').blur(); // free roam has its own Start / Join buttons
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
  onClick('#roamNewBtn', () => enterRoam({ t: 'roamNew', mapId: roamMapId }));
  onClick('#roamLeaveBtn', () => send({ t: 'roamLeave' }));

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
    panKeys.left = panKeys.right = panKeys.up = panKeys.down = false;
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

  const PAN_MAP = {
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  };

  function onKey(e, down) {
    if (e.target instanceof HTMLInputElement) return;
    const pan = PAN_MAP[e.code];
    if (pan && !$('#game').hidden) {
      panKeys[pan] = down;
      if (down && spectating) freeCam = true;
    }
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
  // Spectators drag the view around (touch or mouse)
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!spectating) return;
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || !spectating) return;
    cam.x -= (e.clientX - drag.x) / viewScale;
    cam.y -= (e.clientY - drag.y) / viewScale;
    drag = { x: e.clientX, y: e.clientY };
    freeCam = true;
  });
  for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, () => { drag = null; });
  $('#followBtn').addEventListener('click', (e) => {
    e.currentTarget.blur();
    freeCam = false;
  });

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
    if (spectating && freeCam) return null;
    return state.players.some((p) => p.id === myId) ? myId : state.itId;
  }

  function updateCamera(state, dt) {
    const world = worldOf(currentMap());
    const maxX = Math.max(0, world.width - view.width);
    const maxY = Math.max(0, world.height - view.height);
    if (spectating && freeCam) {
      const step = 700 * dt;
      cam.x = clamp(cam.x + (panKeys.right - panKeys.left) * step, 0, maxX);
      cam.y = clamp(cam.y + (panKeys.down - panKeys.up) * step, 0, maxY);
      cam.ready = true;
      return;
    }
    const target = state.players.find((p) => p.id === cameraTargetId(state));
    if (!target) return;
    const tx = clamp(target.x + pSize.w / 2 - view.width / 2, 0, maxX);
    const ty = clamp(target.y + pSize.h / 2 - view.height * 0.55, 0, maxY);
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

  function drawPlayers(state, time) {
    const world = worldOf(currentMap());
    const trapColors = themeFor(currentMap()).trap;
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
      // Invisibility cloak: others see nothing at all; you see yourself see-through
      if (p.iv > 0 && !isMe) continue;
      ctx.save();
      if (p.iv > 0) ctx.globalAlpha = 0.45;
      if (p.sp > 0) {
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
      if (p.sl > 0) drawStuckFeet(ctx, trapColors, p, cx, feetY, time);
      if (p.dj > 0) drawPlayerWings(ctx, p, cx, time);
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
      if (p.sh) drawShieldBubble(ctx, cx, p.y + pSize.h / 2, time);
      ctx.restore();
      if (isIt && room.mode === 'potato') {
        const left = fuseLeft(state);
        drawPotato(ctx, cx + p.f * 21, p.y + (p.dm === 1 ? 30 : 22), 1, left / room.fuseSeconds, time, left < 3 && !state.ho);
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

  // Hot potato: seconds left on the fuse (it sits full during a hand-off)
  function fuseLeft(state) {
    return Math.min(room.fuseSeconds ?? 15, state.timeLeft);
  }

  // Shield: a shimmering bubble around the holder
  function drawShieldBubble(g, cx, cy, time) {
    const r = 34 + Math.sin(time * 4) * 1.5;
    const fill = g.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
    fill.addColorStop(0, 'rgba(99, 230, 190, 0)');
    fill.addColorStop(1, 'rgba(99, 230, 190, 0.35)');
    g.fillStyle = fill;
    fillEllipse(g, cx, cy, r, r);
    g.strokeStyle = 'rgba(150, 242, 215, 0.85)';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
    // Glint sliding round the rim
    g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    g.lineWidth = 3;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(cx, cy, r - 4, time * 1.5, time * 1.5 + 0.6);
    g.stroke();
  }

  // Shield pop: the bubble bursts into a ring and shards
  function drawShieldPops(now) {
    while (shieldPops.length && now - shieldPops[0].at > 600) shieldPops.shift();
    for (const s of shieldPops) {
      const k = (now - s.at) / 600;
      ctx.strokeStyle = `rgba(150, 242, 215, ${1 - k})`;
      ctx.lineWidth = 4 * (1 - k) + 1;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 34 + k * 40, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(255, 255, 255, ${1 - k})`;
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        const r = 34 + k * (30 + (i % 2) * 20);
        fillEllipse(ctx, s.x + Math.cos(a) * r, s.y + Math.sin(a) * r, 3 * (1 - k) + 1, 3 * (1 - k) + 1);
      }
    }
  }

  // Hot potato explosion: flash, shockwave ring, debris and smoke
  function drawBooms(now) {
    while (booms.length && now - booms[0].at > 900) booms.shift();
    for (const b of booms) {
      const k = (now - b.at) / 900;
      if (k < 0.25) {
        ctx.fillStyle = `rgba(255, 244, 200, ${1 - k / 0.25})`;
        fillEllipse(ctx, b.x, b.y, 40 + k * 120, 40 + k * 120);
      }
      ctx.strokeStyle = `rgba(255, 146, 43, ${1 - k})`;
      ctx.lineWidth = 6 * (1 - k) + 1;
      ctx.beginPath();
      ctx.arc(b.x, b.y, 20 + k * 110, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + i * 0.3;
        const r = 10 + k * (70 + (i % 3) * 25);
        const x = b.x + Math.cos(a) * r;
        const y = b.y + Math.sin(a) * r + k * k * 60;
        ctx.fillStyle = i % 2 ? `rgba(255, 212, 59, ${1 - k})` : `rgba(201, 139, 75, ${1 - k})`;
        fillEllipse(ctx, x, y, 4 * (1 - k) + 1.5, 4 * (1 - k) + 1.5);
      }
      ctx.fillStyle = `rgba(90, 90, 100, ${0.45 * (1 - k)})`;
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i - 2) * 0.5;
        fillEllipse(ctx, b.x + Math.cos(a) * k * 50, b.y + Math.sin(a) * k * 60, 12 + k * 18, 12 + k * 18);
      }
    }
  }

  // Slowed by a trap: goo clinging to the feet and dripping off
  function drawStuckFeet(g, colors, p, cx, feetY, time) {
    if (!colors) return;
    g.fillStyle = colors.goo;
    fillEllipse(g, cx, feetY - 2, 19, 5);
    for (let k = 0; k < 3; k++) {
      const dx = (k - 1) * 11;
      const ph = (time * 1.2 + k * 0.37 + p.id * 0.13) % 1;
      fillEllipse(g, cx + dx, feetY - 4 + ph * 9, 3 - ph * 1.5, 4 - ph * 2);
    }
    g.fillStyle = colors.light;
    fillEllipse(g, cx - 6, feetY - 4, 5, 1.5);
  }

  // Wings power-up: a pair flapping on the player's back (folded once the air jump is used)
  function drawPlayerWings(g, p, cx, time) {
    const flap = p.g ? Math.sin(time * 4) * 0.08 : Math.sin(time * 14) * 0.35;
    const cy = p.y + pSize.h * 0.42;
    for (const side of [-1, 1]) {
      g.save();
      g.translate(cx - p.f * 3 + side * 11, cy);
      g.scale(side, 1);
      g.rotate(0.1 - flap);
      drawWing(g, 8, -6, 1.05); // wing root sits at the origin, tip sweeps up and out
      g.restore();
    }
  }

  // ---- Double jumps: a puff of feathers under whoever jumped in mid-air ----
  const airPuffs = []; // { x, y, at }
  const lastAirJumps = new Map(); // player id -> mid-air jump count last seen

  function detectAirJumps(state) {
    for (const p of state.players) {
      const prev = lastAirJumps.get(p.id);
      lastAirJumps.set(p.id, p.ac);
      if (prev === undefined || prev === p.ac) continue;
      if (p.iv > 0 && p.id !== myId) continue; // don't give away an invisible player
      airPuffs.push({ x: p.x + pSize.w / 2, y: p.y + pSize.h, at: performance.now() });
    }
  }

  function drawAirPuffs(now) {
    while (airPuffs.length && now - airPuffs[0].at > 400) airPuffs.shift();
    for (const a of airPuffs) {
      const k = (now - a.at) / 400;
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.8 * (1 - k)})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(a.x, a.y + k * 10, 10 + k * 22, 3 + k * 5, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(255, 255, 255, ${0.9 * (1 - k)})`;
      for (const dx of [-1, 1]) fillEllipse(ctx, a.x + dx * (8 + k * 18), a.y + 4 + k * 14, 3, 1.5);
    }
  }

  // ---- Sound effects driven by game state ----
  const heard = { ho: null, fuseTick: 0, sp: 0, iv: 0, dj: 0, sl: 0, tc: null, ac: null, dc: null, jc: null, g: null, count: null, tick: null, phase: null };

  function detectSounds(state) {
    const me = state.players.find((p) => p.id === myId);
    if (me) {
      if (heard.dc !== null && me.dc !== heard.dc) Music.sfx(me.dm === 2 ? 'airdash' : 'slide');
      if (heard.ac !== null && me.ac !== heard.ac) Music.sfx('flap');
      else if (heard.jc !== null && me.jc !== heard.jc) Music.sfx('jump');
      else if (heard.g === 0 && me.g === 1 && me.dm !== 1) Music.sfx('land');
      if (heard.tc !== null && me.tc !== heard.tc) Music.sfx('splat');
      const wornOff = (heard.sp > 0 && me.sp === 0) || (heard.iv > 0 && me.iv === 0) || (heard.dj > 0 && me.dj === 0) || (heard.sl > 0 && me.sl === 0);
      if (wornOff && state.phase === 'playing') Music.sfx('powerdown');
      heard.sp = me.sp;
      heard.iv = me.iv;
      heard.dj = me.dj;
      heard.ac = me.ac;
      heard.sl = me.sl;
      heard.tc = me.tc;
      heard.dc = me.dc;
      heard.jc = me.jc;
      heard.g = me.g;
    } else {
      heard.jc = heard.g = heard.dc = heard.tc = heard.ac = null;
    }

    // 3-2-1 beeps, then GO!
    if (state.phase === 'ready') {
      const n = Math.ceil(state.timeLeft);
      if (n !== heard.count && n >= 1 && n <= 3) Music.sfx('beep');
      heard.count = n;
    } else if (state.phase === 'playing' && heard.phase === 'ready') {
      Music.sfx('go');
      goUntil = performance.now() + 800;
    }

    if (room.mode === 'potato') {
      // Hand-off countdown beeps, then a fuse that ticks faster as it burns down
      if (state.ho > 0) {
        const n = Math.ceil(state.ho);
        if (n !== heard.ho) Music.sfx('beep');
        heard.ho = n;
      } else {
        if (heard.ho !== null && state.phase === 'playing') goUntil = performance.now() + 800;
        heard.ho = null;
        const now = performance.now() / 1000;
        if (state.phase === 'playing' && now >= heard.fuseTick) {
          const left = fuseLeft(state);
          Music.sfx('tick', left < 3 ? 1.6 : 1);
          heard.fuseTick = now + clamp(0.1 + left * 0.04, 0.1, 0.7);
        }
      }
    } else if (state.phase === 'playing' && !room.free && state.timeLeft <= 5) {
      // Clock ticks for the final 5 seconds (louder on the last one)
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
      if (p.iv > 0 && p.id !== myId) continue; // don't give away an invisible player
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

  // ---- Traps: splash the one someone just stepped in ----
  const trapSplashAt = [];
  const lastTrapHits = new Map(); // player id -> trap counter last seen

  function detectTrapSplashes(state) {
    const traps = currentMap()?.traps || [];
    for (const p of state.players) {
      const prev = lastTrapHits.get(p.id);
      lastTrapHits.set(p.id, p.tc);
      if (prev === undefined || prev === p.tc || !traps.length || (p.iv > 0 && p.id !== myId)) continue;
      const cx = p.x + pSize.w / 2;
      const feetY = p.y + pSize.h;
      const dist = (t) => Math.abs(t.x + t.w / 2 - cx) + Math.abs(t.y - feetY) * 4;
      let best = 0;
      traps.forEach((t, i) => { if (dist(t) < dist(traps[best])) best = i; });
      trapSplashAt[best] = performance.now();
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
      if (p.iv <= 0 || p.id === myId) portalFlashUntil = performance.now() + 400; // no flash for an invisible player
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
    const potato = room.mode === 'potato';

    if (room.free) {
      // No clock and nobody IT: just say who's here
      const label = `🌿 Free roam · ${state.players.length} ${state.players.length === 1 ? 'player' : 'players'}`;
      ctx.font = '800 16px ui-rounded, system-ui, sans-serif';
      const w = ctx.measureText(label).width + 32;
      ctx.fillStyle = 'rgba(20, 26, 44, 0.8)';
      roundRectPath(ctx, cx - w / 2, 14, w, 36, 18);
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(label, cx, 33);
      ctx.textBaseline = 'alphabetic';
    }

    if (state.phase === 'ready') {
      ctx.fillStyle = 'rgba(15, 20, 36, 0.35)';
      ctx.fillRect(0, 0, view.width, view.height);
      const n = Math.max(1, Math.ceil(state.timeLeft));
      drawLabel(String(n), cx, 250, '#ffffff', 96);
      const itName = state.itId === myId ? 'You are' : `${nameOf(state.itId)} is`;
      const role = potato ? 'holding the potato' : 'IT';
      drawLabel(`${itName} ${role} — get ready!`, cx, 300, '#ffe066', 26);
      return;
    }

    // Hot potato hand-off: the game keeps going while the new holder counts down
    if (potato && state.phase === 'playing' && state.ho > 0) {
      drawLabel(String(Math.ceil(state.ho)), cx, 250, '#ffffff', 80);
      const who = state.itId === myId ? "You've" : `${nameOf(state.itId)} has`;
      drawLabel(`${who} got the potato — scatter!`, cx, 295, '#ffe066', 24);
    }

    if (!room.free) drawRoundHud(state, time);
    drawPowerupTimers(state, time);

    if (performance.now() < goUntil) {
      drawLabel('GO!', cx, 280, '#ffe066', 90);
    }
  }

  // Timer pill (hot potato: the fuse) and who's IT
  function drawRoundHud(state, time) {
    const cx = view.width / 2;
    const potato = room.mode === 'potato';
    const secs = Math.ceil(potato ? fuseLeft(state) : state.timeLeft);
    const label = potato ? `${secs}s` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const urgent = state.phase === 'playing' && (potato ? secs <= 3 && !state.ho : secs <= 10);
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
    if (potato) {
      drawPotato(ctx, -28, 3, 0.9, fuseLeft(state) / room.fuseSeconds, time, false);
      ctx.fillText(label, 14, 2);
    } else {
      ctx.fillText(label, 0, 2);
    }
    ctx.restore();
    ctx.textBaseline = 'alphabetic';
    if (potato) {
      ctx.font = '800 15px ui-rounded, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(20, 26, 44, 0.8)';
      roundRectPath(ctx, cx + 60, 18, 74, 28, 14);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(`${state.players.length} left`, cx + 72, 37);
    }

    // Who's IT
    const it = playerInfo(state.itId);
    if (it && !it.out) {
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
      ctx.fillText(`${potato ? '🥔' : 'IT:'} ${who}`, 50, 38, 124);
    }
  }

  // Your power-ups (speed boots, invisibility, wings, shield) and trap slow
  function drawPowerupTimers(state, time) {
    const me = state.players.find((p) => p.id === myId);
    if (me && state.phase === 'playing') {
      const active = [[drawBoot, me.sp], [drawGhost, me.iv], [drawWing, me.dj], [drawShield, me.sh ? Infinity : 0], [drawSnail, me.sl]].filter(([, secs]) => secs > 0);
      active.forEach(([icon, secs], i) => {
        const y = 58 + i * 36;
        ctx.fillStyle = 'rgba(20, 26, 44, 0.8)';
        roundRectPath(ctx, 12, y, 84, 30, 15);
        ctx.fill();
        icon(ctx, 34, y + 14, 0.9);
        ctx.font = '800 15px ui-rounded, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillStyle = secs <= 1.5 && Math.floor(time * 6) % 2 ? '#ff8787' : '#ffe066';
        ctx.fillText(secs === Infinity ? 'ON' : `${Math.ceil(secs)}s`, 54, y + 20); // the shield has no timer
      });
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
    spectating = !!state && joined && room.phase !== 'ended' && !state.players.some((p) => p.id === myId);
    if (!spectating) freeCam = false;
    $('#followBtn').hidden = !(spectating && freeCam);
    if (state) {
      detectTeleports(state);
      detectSounds(state);
      detectPadLaunches(state);
      detectTrapSplashes(state);
      detectAirJumps(state);
      updateCamera(state, dt);
    }

    const map = currentMap();
    if (!map) return;
    const theme = themeFor(map);
    drawSkyLayer(ctx, theme, view.width, view.height, cam.x, cam.y, time);
    ctx.save();
    const shake = Math.max(0, (shakeUntil - now) / 350) * 6;
    ctx.translate(-cam.x + (Math.random() - 0.5) * shake, -cam.y + (Math.random() - 0.5) * shake);
    drawScenery(ctx, theme, map.platforms);
    drawRails(ctx, map.platforms);
    drawPlatformsThemed(ctx, theme, livePlatforms(map, state));
    drawPads(ctx, map.pads || [], time, padLaunchedAt);
    drawTraps(ctx, theme, map.traps || [], time, trapSplashAt);
    if (state?.pu) drawPowerupPickup(ctx, state.pu, time);
    drawPortalsThemed(ctx, map.portals, time, Math.max(0, (portalFlashUntil - now) / 400));
    if (state) drawPlayers(state, time);
    drawAirPuffs(now);
    drawBooms(now);
    drawShieldPops(now);
    ctx.restore();

    if (state) {
      const urgent = room.mode === 'potato' ? !state.ho && fuseLeft(state) <= 5 : state.timeLeft <= 10;
      Music.setUrgent(state.phase === 'playing' && !room.free && urgent);
      drawOffscreenArrows(state, time);
      updateDashMeter(state);
      drawHud(state, time);
    }
  }

  connect();
  requestAnimationFrame(frame);
})();
