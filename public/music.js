'use strict';

// Procedural chiptune music via Web Audio — no audio files needed.
// Browsers (especially iOS Safari) only allow audio after a user gesture,
// so the client calls Music.unlock() from tap/click/key handlers.
const Music = (() => {
  const VOLUME = 0.5;
  const LOOKAHEAD = 0.12; // seconds of notes scheduled ahead of time

  let ctx = null;
  let master = null;
  let bus = null; // per-song gain node, faded out on song change
  let noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem('tagMuted') === '1'; } catch {}

  let desired = null; // song name we want playing (may be set before unlock)
  let current = null;
  let timer = null;
  let step = 0;
  let nextTime = 0;
  let tempoMul = 1;

  const SEMIS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function freq(note) {
    const m = /^([A-G])(#|b)?(\d)$/.exec(note);
    const midi = (Number(m[3]) + 1) * 12 + SEMIS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    return 440 * 2 ** ((midi - 69) / 12);
  }

  // ---- Instruments ----
  function tone(t, f, dur, type, vol, dest = bus) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function kick(t, vol = 0.8) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + 0.17);
  }

  function noise(t, dur, vol, highpass, dest = bus) {
    const src = ctx.createBufferSource();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    src.buffer = noiseBuf;
    f.type = 'highpass';
    f.frequency.value = highpass;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t);
    src.stop(t + dur + 0.02);
  }
  const snare = (t) => noise(t, 0.12, 0.3, 1500);
  const hat = (t, vol = 0.07) => noise(t, 0.04, vol, 7000);

  // ---- Songs: play(step, time, sixteenthDuration) schedules one 16th step ----
  const ROOTS = ['C3', 'A2', 'F2', 'G2']; // I – vi – IV – V

  const bars = (s) => s.split('|').map((b) => b.trim().split(/\s+/));
  // Eighth notes, '-' extends the previous note
  const GAME_MELODY = bars(`
    E5 G5 C6 G5 E5 G5 A5 G5 | E5 -  C5 E5 A5 -  G5 E5 | F5 A5 C6 A5 F5 A5 G5 F5 | D5 G5 B5 G5 D5 -  G5 - |
    C6 -  B5 C6 G5 -  E5 G5 | A5 -  G5 A5 E5 -  C5 E5 | F5 -  A5 -  C6 -  A5 F5 | G5 F5 E5 D5 B4 -  -  -`);

  const LOBBY_CHORDS = [
    ['C4', 'E4', 'G4', 'C5'],
    ['A3', 'C4', 'E4', 'A4'],
    ['F3', 'A3', 'C4', 'F4'],
    ['G3', 'B3', 'D4', 'G4'],
  ];
  const ARP = [0, 1, 2, 3, 2, 1, 2, 1];

  const SONGS = {
    lobby: {
      bpm: 96,
      play(step, t, sd) {
        const bar = Math.floor(step / 16) % 4;
        const s = step % 16;
        if (s === 0) tone(t, freq(ROOTS[bar]), sd * 15, 'sine', 0.3);
        if (s % 2 === 0) tone(t, freq(LOBBY_CHORDS[bar][ARP[s / 2]]) * 2, sd * 1.8, 'triangle', 0.13);
        if (s % 4 === 2) hat(t, 0.035);
      },
    },
    game: {
      bpm: 140,
      play(step, t, sd) {
        const bar = Math.floor(step / 16) % GAME_MELODY.length;
        const s = step % 16;
        if (s === 0 || s === 8 || s === 10) kick(t);
        if (s === 4 || s === 12) snare(t);
        if (s % 2 === 0) hat(t, s % 4 === 2 ? 0.09 : 0.05);
        if (s % 2 === 0) {
          tone(t, freq(ROOTS[bar % 4]) * (s % 4 === 2 ? 2 : 1), sd * 1.6, 'triangle', 0.32);
          const notes = GAME_MELODY[bar];
          const i = s / 2;
          if (notes[i] !== '-') {
            let len = 1;
            while (i + len < notes.length && notes[i + len] === '-') len++;
            tone(t, freq(notes[i]), sd * 2 * len * 0.9, 'square', 0.08);
          }
        }
      },
    },
  };

  // ---- Scheduler ----
  function newBus() {
    if (bus) {
      const old = bus;
      old.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      setTimeout(() => old.disconnect(), 500);
    }
    bus = ctx.createGain();
    bus.connect(master);
    return bus;
  }

  function scheduler() {
    const sd = 60 / (current.bpm * tempoMul) / 4;
    if (nextTime < ctx.currentTime - 0.05) nextTime = ctx.currentTime + 0.02; // fell behind (tab throttled)
    while (nextTime < ctx.currentTime + LOOKAHEAD) {
      current.play(step, nextTime, sd);
      nextTime += sd;
      step++;
    }
  }

  function stopScheduler() {
    clearInterval(timer);
    timer = null;
    current = null;
  }

  function startDesired() {
    stopScheduler();
    if (!ctx || !SONGS[desired]) return;
    newBus();
    current = SONGS[desired];
    step = 0;
    nextTime = ctx.currentTime + 0.05;
    scheduler();
    timer = setInterval(scheduler, 25);
  }

  // ---- Public API ----
  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : VOLUME;
      master.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      startDesired();
    }
    if (ctx.state === 'suspended' && !document.hidden) ctx.resume();
  }

  function play(name) {
    if (desired === name) return;
    desired = name;
    tempoMul = 1;
    startDesired();
  }

  function jingle(win) {
    desired = null;
    stopScheduler();
    if (!ctx) return;
    const b = newBus();
    const t = ctx.currentTime + 0.08;
    const notes = win ? ['C5', 'E5', 'G5', 'C6'] : ['G4', 'F#4', 'F4', 'E4'];
    notes.forEach((n, i) => {
      const last = i === notes.length - 1;
      tone(t + i * 0.15, freq(n), last ? 0.7 : 0.16, 'square', 0.1, b);
      tone(t + i * 0.15, freq(n) / 2, last ? 0.7 : 0.16, 'triangle', 0.2, b);
    });
  }

  // Portal sound: a quick falling "whoosh"
  function whoosh() {
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const [type, from, vol] of [['sine', 900, 0.22], ['triangle', 1350, 0.08]]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(from, t);
      o.frequency.exponentialRampToValueAtTime(110, t + 0.35);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + 0.45);
    }
  }

  // ---- Sound effects (straight to master, so song changes don't cut them off) ----
  function sweep(t, from, to, dur, type, vol) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  const SFX = {
    jump: (t, v) => sweep(t, 320, 640, 0.12, 'square', 0.06 * v),
    land: (t, v) => {
      sweep(t, 160, 60, 0.08, 'sine', 0.25 * v);
      noise(t, 0.05, 0.05 * v, 800, master);
    },
    tag: (t, v) => {
      tone(t, 660, 0.09, 'square', 0.1 * v, master);
      tone(t + 0.08, 990, 0.14, 'square', 0.1 * v, master);
    },
    tagged: (t, v) => {
      tone(t, 600, 0.14, 'triangle', 0.3 * v, master);
      tone(t + 0.15, 420, 0.3, 'triangle', 0.3 * v, master);
    },
    slide: (t, v) => noise(t, 0.25, 0.12 * v, 1200, master),
    airdash: (t, v) => {
      sweep(t, 400, 1200, 0.15, 'sawtooth', 0.05 * v);
      noise(t, 0.15, 0.08 * v, 3000, master);
    },
    boing: (t, v) => {
      sweep(t, 180, 720, 0.28, 'triangle', 0.3 * v);
      sweep(t, 360, 1440, 0.2, 'square', 0.04 * v);
    },
    powerup: (t, v) => {
      ['C6', 'E6', 'G6', 'C7'].forEach((n, i) => tone(t + i * 0.06, freq(n), 0.12, 'square', 0.07 * v, master));
    },
    cloak: (t, v) => {
      ['G6', 'E6', 'C6', 'G5'].forEach((n, i) => tone(t + i * 0.07, freq(n), 0.18, 'triangle', 0.12 * v, master));
      noise(t, 0.35, 0.04 * v, 5000, master);
    },
    flap: (t, v) => {
      sweep(t, 480, 960, 0.12, 'triangle', 0.12 * v);
      noise(t, 0.12, 0.06 * v, 2500, master);
    },
    powerdown: (t, v) => sweep(t, 900, 300, 0.25, 'triangle', 0.15 * v),
    boom: (t, v) => {
      noise(t, 0.7, 0.5 * v, 40, master);
      sweep(t, 140, 30, 0.6, 'sine', 0.6 * v);
      sweep(t, 90, 25, 0.5, 'square', 0.08 * v);
    },
    splat: (t, v) => {
      noise(t, 0.18, 0.18 * v, 500, master);
      sweep(t, 220, 70, 0.22, 'sine', 0.3 * v);
    },
    tick: (t, v) => sweep(t, 1800, 1500, 0.04, 'square', 0.05 * v),
    beep: (t, v) => tone(t, 523, 0.15, 'square', 0.09 * v, master),
    go: (t, v) => tone(t, 1047, 0.4, 'square', 0.1 * v, master),
  };

  function sfx(name, vol = 1) {
    if (!ctx || ctx.state !== 'running' || !SFX[name]) return;
    SFX[name](ctx.currentTime + 0.005, vol);
  }

  function setUrgent(urgent) {
    tempoMul = urgent ? 1.25 : 1;
  }

  function toggleMute() {
    muted = !muted;
    try { localStorage.setItem('tagMuted', muted ? '1' : '0'); } catch {}
    if (master) master.gain.setTargetAtTime(muted ? 0 : VOLUME, ctx.currentTime, 0.03);
    return muted;
  }

  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend();
    else ctx.resume();
  });

  return { unlock, play, jingle, whoosh, sfx, setUrgent, toggleMute, isMuted: () => muted };
})();
