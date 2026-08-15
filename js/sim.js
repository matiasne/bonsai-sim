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
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = B;
})(typeof window !== 'undefined' ? window : globalThis);
