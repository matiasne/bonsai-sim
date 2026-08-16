/* Headless smoke test for the pure modules (no browser, no network).
   Run: node test/smoke.js */
'use strict';
const path = require('path');
const assert = require('assert');

require(path.join(__dirname, '..', 'js', 'tree.js'));
require(path.join(__dirname, '..', 'js', 'sim.js'));
require(path.join(__dirname, '..', 'js', 'voxels.js'));
require(path.join(__dirname, '..', 'js', 'weather.js'));
const B = globalThis.Bonsai;

let passed = 0;
function ok(cond, label) {
  assert(cond, label);
  passed++;
  console.log('  ✓', label);
}

console.log('seed tree');
const t = new B.TreeModel();
const seedSegs = t.segs.size;
ok(seedSegs >= 8, `seed has ${seedSegs} segments`);
ok(t.stats().blossoms >= 3, `seed has ${t.stats().blossoms} blossoms`);
for (const s of t.segs.values()) {
  ok2NoNaN(s);
}
function ok2NoNaN(s) {
  for (const v of [...s.start, ...s.end, ...s.dir, s.len, s.thick]) {
    if (!isFinite(v)) throw new Error('NaN in segment ' + s.id);
  }
}

console.log('90-day growth run (caps + silhouette)');
for (let day = 0; day < 90; day++) {
  t.ageTips(24 * 0.7);
  t.grow(90); // ≈ a generous day of growth points
}
const st = t.stats();
ok(st.segments > seedSegs, `grew to ${st.segments} segments`);
ok(st.segments <= B.TreeCFG.maxSegments, 'segment cap respected');
ok(st.tips <= B.TreeCFG.maxTips, `tip cap respected (${st.tips})`);
ok(st.height <= B.TreeCFG.maxHeight + 1.5, `height ${st.height.toFixed(1)} within cap`);
ok(st.height > 18, 'tree gained height');
ok(st.width >= 14 && st.width <= 2 * (B.TreeCFG.maxRadius + 8), `canopy spread ${st.width.toFixed(1)} fits the viewport`);
ok(st.width / st.height > 0.4 && st.width / st.height < 2.2, 'silhouette ratio sane');
ok(st.blossoms >= 4, `${st.blossoms} blossoms after 90 days`);
function maxChainRun(tree) {
  let m = 0;
  for (const s of tree.segs.values()) m = Math.max(m, (s.runLen || 0) + s.len);
  return m;
}
ok(maxChainRun(t) <= B.TreeCFG.maxRunLen + 8, `no whips: longest chain run ${maxChainRun(t).toFixed(1)}`);
for (const s of t.segs.values()) ok2NoNaN(s);
console.log('  ✓ no NaN across', t.segs.size, 'segments');
passed++;

console.log('prune + back-bud + undo');
const lowTrunk = [...t.segs.values()].find(s => s.pid !== null && s.order === 0 && s.thick > 5);
ok(!lowTrunk || t.cut(lowTrunk.id).ok === false, 'thick low trunk refuses scissors');
const victim = [...t.segs.values()].find(s =>
  s.pid !== null && s.children.length > 0 && !(s.order === 0 && s.thick > 5));
const before = t.segs.size;
const cutRes = t.cut(victim.id);
ok(cutRes.ok && t.segs.size < before, `cut removed ${cutRes.removed} segments`);
ok(t.segs.get(victim.id).cut === true, 'stub is marked cut');
ok(B.Voxels.buildTree(t).voxels.every(v => v.seg !== undefined), 'voxels still build after cut');
ok(t.restore(cutRes.undo), 'undo restores the branch');
ok(t.segs.size === before, 'undo restored exact segment count');
const cut2 = t.cut(victim.id);
ok(cut2.ok, 'cut again after undo');
const rootSeg = t.root();
ok(t.cut(rootSeg.id).ok === false, 'root segment is protected');
let sprouted = false;
for (let i = 0; i < 40 && !sprouted; i++) { t.grow(10); sprouted = !t.segs.get(victim.id).cut; }
ok(sprouted, 'stub back-budded into a new shoot');

console.log('wire + bend');
t.ageTips(24);
t.grow(150); // regrow structure after the prune tests
let branch = [...t.segs.values()].find(s => s.pid !== null && s.order >= 1 && !s.cut);
if (!branch) branch = [...t.segs.values()].find(s => s.pid !== null && !s.cut);
ok(!!branch, 'found a bendable branch');
ok(t.bend(branch.id, [0, 0, 1], 0.1) === false, 'unwired branch refuses to bend');
ok(t.wire(branch.id, true) === true, 'wire attaches');
ok(Array.isArray(t.segs.get(branch.id).dir0), 'wiring records the original direction');
const d0keep = t.segs.get(branch.id).dir0.slice();
const preDirs = JSON.stringify([...t.segs.values()].map(s => s.dir));
const bent = t.bend(branch.id, [0, 0, 1], 0.08);
ok(typeof bent === 'boolean', 'bend returns verdict');
if (bent) ok(JSON.stringify([...t.segs.values()].map(s => s.dir)) !== preDirs, 'bend rotated subtree dirs');
else { passed++; console.log('  ✓ bend was vetoed by soil clamp (acceptable)'); }
let minY = Infinity;
for (const s of t.segs.values()) minY = Math.min(minY, s.end[1]);
ok(minY >= B.TreeCFG.minBendY - 1e-6 || minY >= 0, 'nothing below the soil after bends');
const hugeBend = t.bend(branch.id, [1, 0, 0], -1.4);
for (const s of t.segs.values()) ok2NoNaN(s);
console.log('  ✓ extreme bend attempt left no NaN (applied:', hugeBend, ')');
passed++;
ok(t.segs.get(branch.id).dir0[0] === d0keep[0] && t.segs.get(branch.id).dir0[1] === d0keep[1],
  'dir0 keeps the pre-bend direction through bends');
ok(t.wire(branch.id, false) === false, 'unwire works');
ok(t.segs.get(branch.id).dir0 === null, 'unwire clears dir0');
const nudged = t.nudge(branch.id, [0, 0, 1], 0.05) || t.nudge(branch.id, [0, 0, 1], -0.05) || t.nudge(branch.id, [1, 0, 0], 0.05);
ok(nudged === true, 'nudge rotates without wire (spring-back path; soil veto may block a direction)');

console.log('wire setting (removal is always manual, 1–3 months by thickness)');
t.wire(branch.id, true);
const wseg = t.segs.get(branch.id);
const need = t.wireSetHours(wseg);
ok(need >= 720 && need <= 2160, `set time within 1–3 months (${(need / 720).toFixed(1)}mo at thick ${wseg.thick.toFixed(1)})`);
ok(t.wireSetHours({ thick: 1 }) < t.wireSetHours({ thick: 6 }), 'thicker branches need the wire longer');
let rel = t.ageWires(need - 5);
ok(rel.length === 0 && wseg.wired === true, 'wire still on just before setting');
const serMid = new B.TreeModel(t.serialize());
ok(Math.abs(serMid.segs.get(branch.id).wireAge - (need - 5)) < 0.5, 'wireAge survives save round-trip');
rel = t.ageWires(10, 1);
ok(rel.length === 1, 'crossing the threshold reports the branch as newly set (once)');
ok(wseg.wired === true, 'the wire STAYS on after setting — no auto-release');
ok(t.ageWires(5).length === 0, 'the set event fires only once');
const wildBefore = wseg.wireAge;
t.ageWires(10, 99);
ok(Math.abs(wseg.wireAge - wildBefore - 11) < 0.01, 'season rate clamps to +10%');
ok(B.Voxels.buildTree(t).voxels.some(v => v.kind === 'wire'), 'coils still render after setting');
t.wire(branch.id, false);
ok(t.segs.get(branch.id).wired === false && t.segs.get(branch.id).dir0 === null, 'manual removal takes the wire off');
ok(!B.Voxels.buildTree(t).voxels.some(v => v.kind === 'wire'), 'coils gone after manual removal');

console.log('leaf trimming (pinch/defoliation)');
const padTip = [...t.segs.values()].find(s => !s.children.length && !s.cut && t.leafRadius(s) >= 2);
ok(!!padTip, 'found a pad to trim');
const preR = t.leafRadius(padTip), preBB = padTip.budBoost;
const trimRes = t.trimTip(padTip.id);
ok(trimRes.ok === true, 'trim succeeds on a full pad');
ok(t.leafRadius(padTip) < preR && padTip.budBoost > preBB, 'trim shrinks the pad and boosts ramification');
const interiorSeg = [...t.segs.values()].find(s => s.children.length);
ok(t.trimTip(interiorSeg.id).ok === false, 'cannot trim interior segments');
let overTrim = { ok: true }, trimGuard = 6;
while (overTrim.ok && trimGuard--) overTrim = t.trimTip(padTip.id);
ok(overTrim.ok === false && overTrim.reason === 'small', 'a pad can only be trimmed down so far');

console.log('serialize round-trip');
const s1 = t.serialize();
const t2 = new B.TreeModel(s1);
ok(t2.segs.size === t.segs.size, 'round-trip segment count');
ok(Math.abs(t2.stats().height - t.stats().height) < 0.8, 'round-trip height matches');
ok(t2.rng.state === t.rng.state, 'RNG state persists');
const g1 = t.grow(5).map(e => e.type).join(','), g2 = t2.grow(5).map(e => e.type).join(',');
ok(g1 === g2, `growth is deterministic after reload (${g2 || 'saturated'})`);

console.log('voxel builders');
const pot = B.Voxels.buildPot();
ok(pot.length > 400 && pot.length < 4096, `pot voxels: ${pot.length}`);
ok(pot.some(v => v.kind === 'pebble'), 'pot has pebbles');
const built = B.Voxels.buildTree(t2);
ok(built.voxels.length > 300 && built.voxels.length < 40960, `tree voxels: ${built.voxels.length}`);
ok(built.voxels.some(v => v.kind === 'leaf'), 'tree has blossom voxels');
ok(built.canopy.maxY > built.canopy.minY, 'canopy bounds sane');
const shrunk = B.Voxels.buildTree(t2, { puffScale: 0.6 });
ok(shrunk.voxels.filter(v => v.kind === 'leaf').length <= built.voxels.filter(v => v.kind === 'leaf').length,
  'wire-mode puff shrink reduces leaf voxels');
t2.wire([...t2.segs.values()].find(s => s.pid !== null).id, true);
ok(B.Voxels.buildTree(t2).voxels.some(v => v.kind === 'wire'), 'wired branch renders wire coils');
const spot = B.Voxels.pebbleSpot(() => 0.3);
ok(isFinite(spot.u) && isFinite(spot.v), 'pebbleSpot returns a point');

console.log('future preview (growFuture)');
const baseSer = t2.serialize();
const baseSegs = t2.segs.size;
const f2 = B.growFuture(baseSer, 2);
const f3 = B.growFuture(baseSer, 3);
const f4 = B.growFuture(baseSer, 4);
ok(t2.segs.size === baseSegs, 'growFuture never touches the original tree');
ok(f2.stats().segments > t2.stats().segments, `+2y grew ${t2.stats().segments} → ${f2.stats().segments} segs`);
ok(f4.stats().tips > f2.stats().tips, `+4y fuller than +2y (tips ${f2.stats().tips} → ${f4.stats().tips})`);
ok(f3.stats().segments <= B.TreeCFG.maxSegments + 3 * 3 * 6, '+3y respects boosted segment cap');
// user bends may legally exceed the growth height cap — future growth must not add to it
ok(f4.stats().height <= Math.max(B.TreeCFG.maxHeight, t2.stats().height) + 1.5, '+4y adds no height beyond the cap');
ok(f4.stats().width <= 2 * (B.TreeCFG.maxRadius + 10), '+4y still fits the viewport');
ok([...t2.segs.values()].some(s => s.wired) ? [...f4.segs.values()].some(s => s.wired) : true,
  'visions keep wires on — only the user removes them');
const f2b = B.growFuture(baseSer, 2);
ok(JSON.stringify(f2b.serialize()) === JSON.stringify(f2.serialize()), 'future previews are deterministic');
const futVox = B.Voxels.buildTree(f4).voxels.length;
ok(futVox < 40960, `+4y voxels fit instanced-mesh capacity (${futVox})`);
for (const s of f4.segs.values()) ok2NoNaN(s);
console.log('  ✓ +4y tree has no NaN');
passed++;

const t9 = Date.now();
const f9 = B.growFuture(baseSer, 9);
const ms9 = Date.now() - t9;
ok(f9.stats().tips > f4.stats().tips, `+9y fuller than +4y (tips ${f4.stats().tips} → ${f9.stats().tips})`);
ok(f9.stats().segments <= B.TreeCFG.maxSegments + 9 * 3 * 6, '+9y respects boosted segment cap');
ok(f9.stats().width <= 2 * (B.TreeCFG.maxRadius + 10), '+9y still fits the viewport');
const f9vox = B.Voxels.buildTree(f9).voxels.length;
ok(f9vox < 40960, `+9y voxels fit capacity (${f9vox}, grown in ${ms9}ms)`);
ok(maxChainRun(f9) <= B.TreeCFG.maxRunLen + 8, `+9y has no whips (longest chain ${maxChainRun(f9).toFixed(1)})`);
ok(ms9 < 3000, `+9y preview computes fast enough (${ms9}ms)`);
const maxThick9 = Math.max(...[...f9.segs.values()].map(s => s.thick));
const maxThick2 = Math.max(...[...f2.segs.values()].map(s => s.thick));
ok(maxThick9 > maxThick2, `+9y trunk stockier than +2y (${maxThick2.toFixed(1)} → ${maxThick9.toFixed(1)})`);
for (const s of f9.segs.values()) ok2NoNaN(s);
console.log('  ✓ +9y tree has no NaN');
passed++;

console.log('weather env (offline defaults)');
const envDay = B.Weather.env(new Date(2026, 5, 10, 13, 0));
const envNight = B.Weather.env(new Date(2026, 5, 10, 2, 0));
ok(envDay.growth > 0 && envDay.growth <= 1.5, `day growth factor ${envDay.growth}`);
ok(envNight.night === true && envNight.growth < envDay.growth, 'night slows growth');
ok(envDay.dryMul > 0 && envDay.mistMul > 0 && envDay.sway > 0, 'drain/sway factors positive');
ok(envDay.wireRate >= 0.9 && envDay.wireRate <= 1.1, `seasonal wire rate within ±10% (${envDay.wireRate.toFixed(2)})`);
ok(['spring', 'summer', 'autumn', 'winter'].includes(envDay.season), `season computed (${envDay.season})`);
ok(typeof envDay.bloom === 'boolean' && envDay.seasonGrowth >= 0.05 && envDay.seasonGrowth <= 1.3,
  `bloom flag + season growth factor sane (${envDay.seasonGrowth})`);
B.Weather.forceSeason = { season: 'winter', bloom: false };
const envWinter = B.Weather.env(new Date(2026, 5, 10, 13, 0));
ok(envWinter.season === 'winter' && envWinter.seasonGrowth <= 0.1, 'winter dormancy nearly stops growth');
B.Weather.forceSeason = { season: 'spring', bloom: true };
const envBloom = B.Weather.env(new Date(2026, 5, 10, 13, 0));
ok(envBloom.bloom === true && envBloom.seasonGrowth > 1, 'spring bloom + flush via the override');
B.Weather.forceSeason = null;
ok(B.Voxels.PAL.leafGreen.length === 4 && B.Voxels.PAL.leafAutumn.length === 4, 'seasonal foliage palettes present');
ok(typeof envDay.emoji === 'string', 'weather emoji present');

console.log('sim core (deterministic fixed-step integrator)');
const SIM = B.Sim;
const G0 = Date.UTC(2026, 3, 1);   // April 1 — mid-spring in the north
{
  const a = SIM.seasonInfo(G0, false), b = SIM.seasonInfo(G0, false);
  ok(JSON.stringify(a) === JSON.stringify(b), 'seasonInfo is pure');
  ok(a.season === 'spring' && a.seasonGrowth === 1.25, `April is spring in the north (${a.season})`);
  ok(SIM.seasonInfo(G0, true).season === 'autumn', 'April is autumn in the south');
  ok(SIM.seasonInfo(Date.UTC(2026, 0, 10), false).foodMul === 0.25, 'winter slows food decay');
}
function simSnap(st) {
  return JSON.stringify({
    tree: st.tree.serialize(), res: st.res, gp: st.gp, burnH: st.burnH,
    soggy: st.soggy, trim: st.trimBoost, dying: st.dyingH, simT: st.simT,
  });
}
function careFor(st) {   // keep the tree alive without touching the RNG stream
  const r = st.res;
  if (r.water < 45) r.water = Math.min(100, r.water + 35);
  if (r.mist < 40) r.mist = Math.min(100, r.mist + 45);
  if (r.food < 40) r.food = Math.min(100, r.food + 45);
}
{
  // step-size invariance: 30 days in one call ≡ 30 × 1-day calls (with identical care)
  const sA = SIM.newState({ seed: 42, g: G0 });
  const sB = SIM.newState({ seed: 42, g: G0 });
  ok(simSnap(sA) === simSnap(sB), 'same seed → identical fresh state');
  for (let d = 0; d < 30; d++) { careFor(sA); SIM.advance(sA, 86400, false); }
  const sBcare = () => { careFor(sB); return 86400 / SIM.STEP_S; };
  for (let d = 0; d < 30; d++) { let n = sBcare(); while (n-- > 0) SIM.step(sB, false); }
  ok(simSnap(sA) === simSnap(sB), 'advance(1d)×30 ≡ step()×2880 — no step-size drift');
  ok(sA.simT === 30 * 86400, `simT advanced exactly 30 days (${sA.simT})`);
  ok(sA.tree.segs.size > 8, `30 spring days grew the tree (${sA.tree.segs.size} segs)`);
  ok(sA.tree.rng.state === sB.tree.rng.state, 'RNG streams stayed in lockstep');
}
{
  // offline rules differ from live rules, deterministically
  const live = SIM.newState({ seed: 7, g: G0 });
  const off1 = SIM.newState({ seed: 7, g: G0 });
  const off2 = SIM.newState({ seed: 7, g: G0 });
  SIM.advance(live, 48 * 3600, false);
  SIM.advance(off1, 48 * 3600, true);
  SIM.advance(off2, 48 * 3600, true);
  ok(simSnap(off1) === simSnap(off2), 'offline advance is deterministic');
  ok(off1.gp !== live.gp || off1.tree.segs.size !== live.tree.segs.size, 'offline half-pace differs from live');
  ok(off1.res.health >= 12, `offline health floor holds (${off1.res.health.toFixed(1)})`);
}
{
  // death by neglect is an emergent, deterministic outcome
  const d1 = SIM.newState({ seed: 99, g: G0 });
  const d2 = SIM.newState({ seed: 99, g: G0 });
  let guard = 40 * 96;   // up to 40 days
  while (!d1.res.dead && guard-- > 0) SIM.step(d1, false);
  while (!d2.res.dead && d2.simT < d1.simT) SIM.step(d2, false);
  ok(!!d1.res.dead, `neglected tree died (day ${(d1.res.dead / 86400).toFixed(1)})`);
  ok(d1.res.dead === d2.res.dead, 'death lands at the same deterministic simT');
  const seg0 = d1.tree.segs.size;
  SIM.advance(d1, 86400, false);
  ok(d1.tree.segs.size === seg0 && d1.res.health === 0, 'a dead tree neither grows nor recovers');
}

console.log('event log + replay (the envelope IS the tree)');
{
  // a scripted "live session": time passes, the player waters/feeds/prunes/wires,
  // every action logged exactly the way game.js logs it
  const env2 = { v: 2, seed: 1234, g: G0, s: 0, t: 0, e: [] };
  const live = SIM.newState({ seed: env2.seed, g: env2.g });
  const act = (ev) => { const out = SIM.applyAction(live, ev); if (out.ok) env2.e.push(ev); return out; };
  const passTime = (sec, off) => {
    if (off) env2.e.push(['O', live.simT, sec]);
    SIM.advance(live, sec, !!off);
  };
  const careDay = (i) => {   // twice-daily watering keeps up with the drain
    act(['W', live.simT]);
    if (i % 3 === 0) act(['F', live.simT]);
    passTime(43200);
    act(['W', live.simT]); act(['M', live.simT]);
    passTime(43200);
  };
  for (let i = 0; i < 6; i++) careDay(i);                     // a live week-ish
  passTime(2 * 86400, true);                                  // away for 2 days
  for (let i = 0; i < 4; i++) careDay(i);
  const branch2 = [...live.tree.segs.values()].find(s => s.pid !== null && s.children.length && !(s.order === 0 && s.thick > 5));
  ok(!!branch2 && act(['C', live.simT, branch2.id]).ok, 'live cut accepted');
  careDay(1);
  const wireable = [...live.tree.segs.values()].find(s => s.pid !== null && !s.cut && s.order >= 1);
  ok(!!wireable && act(['w', live.simT, wireable.id]).ok, 'live wire accepted');
  const qb = SIM.quantBend([0.2, 0.1, 0.97], 0.31);
  act(['B', live.simT, wireable.id, qb.ax, qb.ay, qb.az, qb.a]);
  careDay(2);
  act(['u', live.simT, wireable.id]);                          // early unwire → canonical spring-back
  for (let i = 0; i < 3; i++) careDay(i);
  const pad2 = [...live.tree.segs.values()].find(s => !s.children.length && !s.cut && live.tree.leafRadius(s) >= 2);
  if (pad2) act(['P', live.simT, pad2.id]);
  careDay(0); careDay(1);
  env2.t = live.simT;

  const replayed = SIM.replay(env2);
  ok(simSnap(replayed) === simSnap(live), 'replay(log) ≡ the live session, bit for bit');
  ok(replayed.tree.rng.state === live.tree.rng.state, 'RNG stream identical after replay');
  ok(env2.e.every(ev => ev[1] % SIM.STEP_S === 0 && ev.slice(2).every(Number.isInteger)),
    'every event sits on a quantum boundary with integer args');

  // canonical string is byte-stable through a JSON round-trip
  const c1 = SIM.canonical(env2);
  const c2 = SIM.canonical(JSON.parse(c1));
  ok(c1 === c2 && JSON.parse(c1).v === 2, `canonical envelope is byte-stable (${c1.length} bytes)`);
  ok(simSnap(SIM.replay(JSON.parse(c1))) === simSnap(live), 'replay from the canonical string matches too');

  // undo-by-rewind: splicing the cut out replays to a tree that never lost the branch
  const cutIdx = env2.e.findIndex(ev => ev[0] === 'C');
  const rewound = { ...env2, e: env2.e.filter((_, i) => i !== cutIdx) };
  const rr = SIM.replay(rewound);
  ok(rr.tree.segs.size >= replayed.tree.segs.size, 'rewinding the cut replays a fuller tree');

  // guards hold in replay: a hand-edited log can't act on a dead tree
  const deadEnv = { v: 2, seed: 5, g: G0, s: 0, t: 12 * 86400, e: [['W', 10 * 86400]] };
  const deadState = SIM.replay(deadEnv);   // neglect kills it around day 5 — later W is refused
  ok(!!deadState.res.dead && deadState.res.water <= 35, 'post-death events replay as no-ops');
}
{
  // bend quantization: composing micro-bends then snapping to the quantized net
  // rotation lands within a hair of the freehand result
  const V = B.Vec;
  const s1 = SIM.newState({ seed: 77, g: G0 });
  for (let d = 0; d < 10; d++) { careFor(s1); SIM.advance(s1, 86400, false); }
  const seg = [...s1.tree.segs.values()].find(s => s.pid !== null && s.order >= 1 && !s.cut);
  ok(!!seg, 'found a branch to micro-bend');
  s1.tree.wire(seg.id, true);
  let q = [0, 0, 0, 1];
  const preDirs = new Map();
  const walk = (s) => { preDirs.set(s.id, s.dir.slice()); for (const c of s.children) walk(c); };
  walk(seg);
  for (let i = 0; i < 12; i++) {   // a wiggly drag: varying axes and angles
    const axis = V.norm([0.1 + 0.05 * i, 0.2, 0.97]);
    const ang = 0.02 + 0.003 * i;
    if (s1.tree.bend(seg.id, axis, ang)) q = V.qMul(V.qFromAxisAngle(axis, ang), q);
  }
  const freehand = seg.dir.slice();
  for (const [id, dir] of preDirs) { const s = s1.tree.segs.get(id); if (s) s.dir = dir; }
  s1.tree.recompute();
  const net = V.qToAxisAngle(q);
  const qb2 = SIM.quantBend(net.axis, net.ang);
  const applied = SIM.applyAction(s1, ['B', s1.simT, seg.id, qb2.ax, qb2.ay, qb2.az, qb2.a]);
  ok(applied.ok, 'net quantized bend applies');
  const err = Math.hypot(seg.dir[0] - freehand[0], seg.dir[1] - freehand[1], seg.dir[2] - freehand[2]);
  ok(err < 0.02, `quantized net bend within a hair of the freehand drag (err ${err.toFixed(4)})`);
}
{
  // v1 → snapshot migration: a legacy tree keeps living inside a v2 envelope
  const legacyTree = new B.TreeModel({ seed: 11 });
  for (let d = 0; d < 20; d++) { legacyTree.ageTips(17); legacyTree.grow(60); }
  const env2 = {
    v: 2, seed: 0, g: G0, s: 0, t: 0, e: [],
    snap: { tree: legacyTree.serialize(), res: { water: 40, mist: 50, food: 60, health: 70, dead: 0 }, gp: 0.4, burnH: 2, soggy: 5, trim: 1, dying: 0 },
  };
  const m1 = SIM.replay(env2);
  ok(m1.tree.segs.size === legacyTree.segs.size && m1.res.health === 70 && m1.burnH === 2,
    'snapshot envelope restores the legacy tree and care state');
  env2.e.push(['O', 0, 86400]);
  env2.t = 86400;
  const m2 = SIM.replay(env2);
  const m3 = SIM.replay(env2);
  ok(simSnap(m2) === simSnap(m3), 'life after migration replays deterministically');
  ok(m2.simT === 86400 && m2.tree.ageHours > legacyTree.ageHours, 'the migrated tree kept growing');
}

(async () => {
  console.log('DNA codes (URL-safe, byte-stable, replayable)');
  const env = {
    v: 2, seed: 31337, g: G0, s: 0, t: 6 * 86400,
    e: [['W', 43200], ['F', 43200], ['O', 86400, 86400], ['W', 3 * 86400], ['L', 4 * 86400, 3600]],
  };
  const code = await SIM.dnaEncode(env);
  ok(/^[01][A-Za-z0-9_-]+$/.test(code), `DNA code is URL-safe (${code.length} chars)`);
  const back = await SIM.dnaDecode(code);
  ok(SIM.canonical(back) === SIM.canonical(env), 'encode → decode round-trips canonically');
  ok(simSnap(SIM.replay(back)) === simSnap(SIM.replay(env)), 'decoded DNA replays identically');
  ok(await SIM.dnaEncode(back) === code, 'the code itself is byte-stable through a round-trip');
  const plain = '0' + Buffer.from(SIM.canonical(env)).toString('base64url');
  ok(SIM.canonical(await SIM.dnaDecode(plain)) === SIM.canonical(env), 'uncompressed fallback codec decodes too');
  if (typeof CompressionStream === 'function') {
    ok(code[0] === '1' && code.length < SIM.canonical(env).length + 2, 'deflate codec engaged');
  }

  console.log('chain module (pure parts only — no network, no wallet)');
  {
    require(path.join(__dirname, '..', 'js', 'chain.js'));
    const C = B.Chain;
    ok(C.CFG.CHAIN_ID === 84532 && C.CFG.CHAIN_ID_HEX === '0x14a34', 'chain config targets Base Sepolia');
    ok(C.CFG.CONTRACT === '' || /^0x[0-9a-fA-F]{40}$/.test(C.CFG.CONTRACT),
      `contract address well-formed or pending deploy (${C.CFG.CONTRACT || 'unset'})`);
    ok(C.CFG.CHAIN_PARAMS.rpcUrls.length > 0 && C.CFG.ABI.some(f => /^function mint\(/.test(f)),
      'wallet add-chain params + mint ABI present');
    const CONTRACT = '0x' + 'ab'.repeat(20);
    const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const pad = (hex) => '0x' + hex.replace(/^0x/, '').padStart(64, '0');
    const logs = [
      { address: '0x' + 'cd'.repeat(20), topics: [TRANSFER, pad('0'), pad('1'), pad('7')] },  // other contract
      { address: CONTRACT, topics: ['0x' + 'ee'.repeat(32), pad('0'), pad('1'), pad('7')] },  // other event
      { address: CONTRACT.toUpperCase().replace('0X', '0x'), topics: [TRANSFER, pad('0'), pad('beef'), pad('2a')] }, // the mint
    ];
    ok(C.parseTokenId(logs, CONTRACT) === 42, 'parseTokenId finds the mint Transfer log (case-insensitive)');
    ok(C.parseTokenId(logs.slice(0, 2), CONTRACT) === null, 'parseTokenId returns null when absent');
    ok(C.parseTokenId([{ address: CONTRACT, topics: [TRANSFER, pad('9'), pad('1'), pad('7')] }], CONTRACT) === null,
      'non-zero-from Transfer (a later resale) is not mistaken for the mint');

    // wallet-free provenance codecs (badge path — plain fetch, never ethers)
    ok(C.encodeUint(C.SEL.dnaOf, 1) === '0x3e39d638' + '0'.repeat(63) + '1',
      'encodeUint builds exact dnaOf(1) calldata');
    const abiStr = (s) => {   // ABI-encode a single string return value
      const hex = [...s].map(ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
      const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
      return '0x' + (32).toString(16).padStart(64, '0') + s.length.toString(16).padStart(64, '0') + padded;
    };
    ok(C.decodeString(abiStr('hello bonsai')) === 'hello bonsai', 'decodeString round-trips an ABI string');
    ok(C.decodeAddress('0x' + '0'.repeat(24) + 'ab'.repeat(20)) === '0x' + 'ab'.repeat(20),
      'decodeAddress strips the padding');
    const envA = { v: 2, seed: 777, g: G0, s: 0, t: 86400, e: [] };
    const envB = { v: 2, seed: 777, g: G0, s: 0, t: 5 * 86400, e: [['W', 2 * 86400]] };  // same tree, older/newer
    const envC = { v: 2, seed: 778, g: G0, s: 0, t: 86400, e: [] };                      // different tree
    const codeA = await SIM.dnaEncode(envA);
    ok(await C.tokenMatches(envB, codeA) === true, 'tokenMatches: same seed+genesis = same tree, even at different ages');
    ok(await C.tokenMatches(envC, codeA) === false, 'tokenMatches: a different seed is a different tree');
    ok(await C.tokenMatches(envA, 'garbage!!') === false, 'tokenMatches: junk on-chain data never matches');
  }

  console.log('replay performance');
  {
    const yearEnv = { v: 2, seed: 2027, g: G0, s: 0, t: 366 * 86400, e: [] };
    for (let d = 0; d < 366; d++) {   // twice-daily watering keeps up with the drain
      yearEnv.e.push(['W', d * 86400], ['M', d * 86400]);
      if (d % 3 === 0) yearEnv.e.push(['F', d * 86400]);
      yearEnv.e.push(['W', d * 86400 + 43200]);
    }
    const t0 = Date.now();
    const yr = SIM.replay(yearEnv);
    const ms = Date.now() - t0;
    ok(!yr.res.dead && yr.tree.segs.size > 60, `a cared-for year replays alive (${yr.tree.segs.size} segs)`);
    ok(ms < 2000, `one sim-year (35k steps, ${yearEnv.e.length} events) replays in ${ms}ms`);
  }

  console.log(`\nPASS — ${passed} checks. Tree: ${t.segs.size} segs, height ${t.stats().height.toFixed(1)}, ${t.stats().blossoms} blossoms, ${built.voxels.length} voxels.`);
})().catch((e) => { console.error('FAIL —', e); process.exit(1); });
