/* Pixel Bonsai — deterministic simulation core: canonical fixed-step integrator +
   season model. No DOM/THREE/network: the same code advances the live game,
   replays a saved action log, and runs headless in Node tests.

   Determinism contract: given the same (seed, genesis ms, hemisphere) and the
   same sequence of step()/advance() calls, the sim is bit-identical on the same
   JS engine. Live weather never feeds the sim — it is ambience only. */
(function (root) {
  'use strict';
  const B = root.Bonsai = root.Bonsai || {};
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  const STEP_S = 900;              // one canonical sim quantum: 15 minutes
  const STEP_H = STEP_S / 3600;
  const DEATH_H = 96;              // hours at rock-bottom health before the tree dies
  const OFFLINE_CAP_S = 72 * 3600; // absences longer than 3 days are truncated
  const PACE = 0.75;               // stands in for the removed day/night + live-weather factors

  const SEASON_GROWTH = { spring: 1.25, summer: 1.0, autumn: 0.5, winter: 0.06 };
  const WIRE_RATE = { spring: 1.1, summer: 1.1, autumn: 1.0, winter: 0.9 };

  // Season from the sim calendar, hemisphere-aware (southern = half-year shift).
  // UTC on purpose: a shared DNA log must grow the same tree in every timezone.
  function seasonInfo(dateMs, south) {
    const d = new Date(dateMs);
    const doy = Math.floor((dateMs - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5);
    const sdoy = (doy + (south ? 182 : 0)) % 365;
    let season, seasonT;
    if (sdoy >= 59 && sdoy < 151) { season = 'spring'; seasonT = (sdoy - 59) / 92; }
    else if (sdoy >= 151 && sdoy < 243) { season = 'summer'; seasonT = (sdoy - 151) / 92; }
    else if (sdoy >= 243 && sdoy < 334) { season = 'autumn'; seasonT = (sdoy - 243) / 91; }
    else { season = 'winter'; seasonT = (sdoy >= 334 ? sdoy - 334 : sdoy + 31) / 90; }
    const bloom = season === 'spring' && sdoy - 59 < 21;   // sakura: ~3 weeks a year
    return {
      season, seasonT, bloom,
      seasonGrowth: SEASON_GROWTH[season],
      wireRate: WIRE_RATE[season],
      foodMul: season === 'winter' ? 0.25 : 1,
    };
  }

  // Fresh sim state. opts: {seed} for a new deterministic tree (or {tree} to
  // adopt an existing model), {g} genesis wall-clock ms, {south} hemisphere.
  function newState(opts) {
    opts = opts || {};
    return {
      tree: opts.tree || new B.TreeModel(opts.seed !== undefined ? { seed: opts.seed } : null),
      res: { water: 72, mist: 60, food: 55, health: 82, dead: 0 },
      gp: 0,          // fractional growth points
      burnH: 0,       // fertilizer-burn hours remaining
      soggy: 0,
      trimBoost: 0,   // recent pinching lets light into the crown → growth buff
      dyingH: 0,      // hours spent in critical condition — reaches DEATH_H and the tree dies
      simT: 0,        // sim-seconds since genesis; only ever advances in STEP_S quanta
      g: opts.g !== undefined ? opts.g : 0,
      south: !!opts.south,
    };
  }

  function healthTarget(state, stats) {
    const r = state.res;
    let t = 1;
    t *= r.water < 8 ? 0.15 : r.water < 30 ? 0.35 + ((r.water - 8) / 22) * 0.5 : 1;
    t *= r.mist < 12 ? 0.85 : r.mist < 35 ? 0.93 : 1;
    t *= r.food < 8 ? 0.88 : r.food <= 100 ? 1 : 0.9;
    if (state.burnH > 0) t *= 0.68;
    t *= 1 - Math.min(0.3, state.soggy * 0.003);
    if (stats && stats.tips >= 20) t *= 0.9;
    return 100 * t;
  }

  // One canonical step. `off` = offline rules (half growth, higher health floor).
  // Returns what happened, for the UI to render — the sim itself never toasts.
  function step(state, off) {
    const out = { grow: [], newlySet: [], startedDying: false, died: false };
    const res = state.res;
    const si = seasonInfo(state.g + state.simT * 1000, state.south);
    state.simT += STEP_S;
    const dtH = STEP_H;

    if (res.dead) {                       // nothing drinks, nothing grows
      res.water = clamp(res.water - dtH * 3, 0, 100);
      res.mist = clamp(res.mist - dtH * 7, 0, 100);
      res.food = clamp(res.food - dtH, 0, 130);
      res.health = 0;
      return out;
    }

    res.water = clamp(res.water - dtH * (100 / 34), 0, 100);
    res.mist = clamp(res.mist - dtH * (100 / 14), 0, 100);
    res.food = clamp(res.food - dtH * (100 / 110) * si.foodMul, 0, 130);
    if (state.burnH > 0) state.burnH = Math.max(0, state.burnH - dtH);
    if (state.soggy > 0) state.soggy = Math.max(0, state.soggy - dtH * 8);

    const stats = state.tree.stats();
    const target = healthTarget(state, stats);
    res.health = clamp(res.health + clamp(target - res.health, -9 * dtH, 7 * dtH), off ? 12 : 5, 100);

    if (res.health <= 15) {               // critical — the tree is slowly dying
      if (state.dyingH === 0) out.startedDying = true;
      state.dyingH += dtH;
      if (state.dyingH >= DEATH_H) {
        res.dead = state.simT;            // death is a deterministic replay outcome
        res.health = 0;
        state.trimBoost = 0;
        out.died = true;
        return out;
      }
    } else if (res.health >= 30) {
      state.dyingH = Math.max(0, state.dyingH - dtH * 2);
    }

    const growth = si.seasonGrowth * PACE;
    const segs = state.tree.segs.size;
    const juv = segs < 26 ? 4.5 : segs < 60 ? 2 : 1;
    const hf = res.health < 25 ? 0.06 : res.health < 60 ? 0.1 + ((res.health - 25) / 35) * 0.8 : 1;
    const ff = 1 + clamp((res.food - 55) / 150, 0, 0.3);
    state.trimBoost *= Math.pow(0.98, dtH);                 // the opened crown closes again
    const tb = 1 + Math.min(0.18, state.trimBoost * 0.012); // light reaches the interior
    state.gp += 1.4 * dtH * growth * hf * ff * tb * juv * (off ? 0.5 : 1);   // ~real-life/5 pace
    state.tree.ageTips(dtH * growth * hf * 1.2);
    out.newlySet = state.tree.ageWires(dtH, si.wireRate);
    if (state.gp >= 1) {
      const n = Math.min(30, Math.floor(state.gp));
      state.gp -= n;
      out.grow = state.tree.grow(n);
    }
    return out;
  }

  // ---------- actions (the event-log vocabulary)
  // Events are compact arrays [op, t, ...args] — t = sim-seconds since genesis,
  // every arg an integer. applyAction owns EVERY gameplay guard so that a log
  // replays to the same tree no matter who wrote it. Time ops ("O" offline
  // advance, "L" timelapse) are handled by replay(), not here.
  //   "W" water · "M" mist · "F" feed · "C" cut(id) · "P" pinch(id)
  //   "w" wire-on(id) · "u" wire-off(id) · "B" bend(id, ax, ay, az, a)
  function applyAction(state, ev) {
    const res = state.res, tree = state.tree, V = B.Vec;
    if (res.dead) return { ok: false, reason: 'dead' };
    const op = ev[0];
    if (op === 'W') {
      let soggy = false;
      if (res.water > 90) { state.soggy = Math.min(100, state.soggy + 25); soggy = true; }
      res.water = clamp(res.water + 35, 0, 100);
      return { ok: true, soggy };
    }
    if (op === 'M') {
      res.mist = clamp(res.mist + 45, 0, 100);
      return { ok: true };
    }
    if (op === 'F') {
      res.food = clamp(res.food + 45, 0, 130);
      const burned = res.food > 100;
      if (burned) state.burnH = 12;
      return { ok: true, burned };
    }
    if (op === 'C') {
      const r = tree.cut(ev[2]);
      return r.ok ? { ok: true, at: r.at, removed: r.removed } : { ok: false, reason: r.reason };
    }
    if (op === 'P') {
      if (res.health < 40) return { ok: false, reason: 'stressed' };
      const r = tree.trimTip(ev[2]);
      if (!r.ok) return { ok: false, reason: r.reason };
      state.trimBoost = Math.min(20, state.trimBoost + 1);
      res.health = Math.max(30, res.health - 1);
      return { ok: true, at: r.at };
    }
    if (op === 'w') {
      const seg = tree.segs.get(ev[2]);
      if (!seg || seg.wired) return { ok: false };
      return tree.wire(ev[2], true) === null ? { ok: false } : { ok: true };
    }
    if (op === 'u') {
      const seg = tree.segs.get(ev[2]);
      if (!seg || !seg.wired) return { ok: false };
      const dir0 = seg.dir0 && seg.dir0.slice();
      const setFrac = clamp(seg.wireAge / tree.wireSetHours(seg), 0, 1);
      tree.wire(ev[2], false);
      let sprung = false;
      if (dir0) {   // canonical instant spring-back, proportional to how unset it is
        const axis = V.cross(seg.dir, dir0);
        const dot = clamp(V.dot(V.norm(seg.dir), V.norm(dir0)), -1, 1);
        const total = Math.acos(dot) * (1 - setFrac);
        if (V.len(axis) > 1e-4 && total > 0.02) sprung = tree.nudge(ev[2], V.norm(axis), total);
      }
      return { ok: true, sprung, setFrac };
    }
    if (op === 'B') {
      const seg = tree.segs.get(ev[2]);
      if (!seg || !seg.wired) return { ok: false };
      const d = decodeBend(ev);
      if (!d.ang) return { ok: false };
      return { ok: tree.bend(ev[2], d.axis, d.ang) };
    }
    return { ok: false, reason: 'unknown' };
  }

  // Bends are logged quantized (axis → int8 triple, angle → 1e-4 rad) so the
  // event is pure integers. Quantize the INPUT only — resulting dirs stay
  // full-precision (rounding them flips growth gates; see tree.js serialize).
  function quantBend(axis, ang) {
    const n = B.Vec.norm(axis);
    return {
      ax: Math.round(n[0] * 127), ay: Math.round(n[1] * 127), az: Math.round(n[2] * 127),
      a: Math.round(ang * 1e4),
    };
  }
  function decodeBend(ev) {
    const ax = ev[3], ay = ev[4], az = ev[5];
    if (!ax && !ay && !az) return { axis: [0, 1, 0], ang: 0 };
    return { axis: B.Vec.norm([ax, ay, az]), ang: ev[6] / 1e4 };
  }

  // ---------- envelope (the DNA): {v:2, seed, g, s, t, e:[events], snap?}
  // seed: uint32 · g: genesis wall-clock ms · s: 1 = southern hemisphere ·
  // t: total sim-seconds · snap: optional checkpoint (legacy v1 migration).
  function loadSnap(env) {
    const sn = env.snap;
    const state = newState({ tree: new B.TreeModel(sn.tree), g: env.g, south: !!env.s });
    if (sn.res) Object.assign(state.res, sn.res);
    state.gp = sn.gp || 0;
    state.burnH = sn.burnH || 0;
    state.soggy = sn.soggy || 0;
    state.trimBoost = sn.trim || 0;
    state.dyingH = sn.dying || 0;
    return state;
  }

  // Pure: envelope → sim state. Gap-fills live time between events, applies
  // O/L time ops and user actions in order, then advances to the envelope's t.
  function replay(env) {
    const state = env.snap ? loadSnap(env) : newState({ seed: env.seed, g: env.g, south: !!env.s });
    for (const ev of env.e || []) {
      if (ev[1] > state.simT) advance(state, ev[1] - state.simT, false);
      if (ev[0] === 'O') advance(state, ev[2], true);
      else if (ev[0] === 'L') advance(state, ev[2], false);
      else applyAction(state, ev);
    }
    if (env.t > state.simT) advance(state, env.t - state.simT, false);
    return state;
  }

  // Byte-stable canonical JSON of an envelope — fixed key order, no whitespace.
  // This exact string is what a DNA URL (and one day a chain) carries.
  function canonical(env) {
    let s = '{"v":2,"seed":' + (env.seed >>> 0) + ',"g":' + env.g +
      ',"s":' + (env.s ? 1 : 0) + ',"t":' + env.t + ',"e":' + JSON.stringify(env.e || []);
    if (env.snap) s += ',"snap":' + JSON.stringify(env.snap);
    return s + '}';
  }

  // ---------- DNA codes: base64url(deflate(canonical JSON)), shareable in a URL
  // Leading flag char picks the codec: '1' deflate-raw, '0' plain (fallback for
  // engines without CompressionStream). Works in browsers and Node ≥18.
  const b64u = {
    enc(bytes) {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    dec(str) {
      const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    },
  };
  async function pipeBytes(bytes, stream) {
    const piped = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(piped).arrayBuffer());
  }
  async function dnaEncode(env) {
    const json = new TextEncoder().encode(canonical(env));
    if (typeof CompressionStream === 'function') {
      return '1' + b64u.enc(await pipeBytes(json, new CompressionStream('deflate-raw')));
    }
    return '0' + b64u.enc(json);
  }
  async function dnaDecode(code) {
    const bytes = b64u.dec(code.slice(1));
    const json = code[0] === '1'
      ? await pipeBytes(bytes, new DecompressionStream('deflate-raw'))
      : bytes;
    return JSON.parse(new TextDecoder().decode(json));
  }

  // ---------- attestation helpers (see js/notary.js)
  async function sha256Hex(str) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // The history prefix an attestation covers: the first n events up to simT.
  // snap passes through by reference — a migrated tree's canonical bytes
  // include it, so dropping it would break every hash on such trees.
  function truncateEnvelope(env, simT, n) {
    const out = { v: 2, seed: env.seed >>> 0, g: env.g, s: env.s ? 1 : 0, t: simT, e: (env.e || []).slice(0, n) };
    if (env.snap) out.snap = env.snap;
    return out;
  }

  async function hashEnvelope(env) {
    return sha256Hex(canonical(env));
  }

  // Advance whole quanta (sub-quantum remainders are the caller's to keep).
  // Aggregated fx events are capped — replays cross years and only the UI cares.
  function advance(state, seconds, off) {
    let n = Math.floor(seconds / STEP_S);
    const agg = { grow: [], newlySet: [], startedDying: false, died: false, steps: n };
    while (n-- > 0) {
      const out = step(state, off);
      for (const e of out.grow) if (agg.grow.length < 64) agg.grow.push(e);
      for (const r of out.newlySet) if (agg.newlySet.length < 16) agg.newlySet.push(r);
      if (out.startedDying) agg.startedDying = true;
      if (out.died) agg.died = true;
    }
    return agg;
  }

  B.Sim = {
    STEP_S, STEP_H, DEATH_H, OFFLINE_CAP_S, PACE, SEASON_GROWTH, WIRE_RATE,
    seasonInfo, newState, healthTarget, step, advance,
    applyAction, quantBend, decodeBend, loadSnap, replay, canonical,
    dnaEncode, dnaDecode,
    sha256Hex, truncateEnvelope, hashEnvelope, b64u,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = B;
})(typeof window !== 'undefined' ? window : globalThis);
