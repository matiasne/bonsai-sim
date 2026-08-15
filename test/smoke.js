/* Headless smoke test for the pure modules (no browser, no network).
   Run: node test/smoke.js */
'use strict';
const path = require('path');
const assert = require('assert');

require(path.join(__dirname, '..', 'js', 'tree.js'));
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
ok(t.wire(branch.id, false) === false, 'unwire works');

console.log('wire auto-release (branch sets)');
t.wire(branch.id, true);
let rel = t.ageWires(47);
ok(rel.length === 0 && t.segs.get(branch.id).wired === true, 'wire still on at 47h');
const serMid = new B.TreeModel(t.serialize());
ok(Math.abs(serMid.segs.get(branch.id).wireAge - 47) < 0.2, 'wireAge survives save round-trip');
rel = t.ageWires(2);
ok(rel.length === 1 && t.segs.get(branch.id).wired === false, 'wire auto-released at ~48h (branch set)');
ok(!B.Voxels.buildTree(t).voxels.some(v => v.kind === 'wire'), 'coils gone after release');

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
ok([...f4.segs.values()].every(s => !s.wired), 'future visions carry no wire (long since set)');
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
ok(typeof envDay.emoji === 'string', 'weather emoji present');

console.log(`\nPASS — ${passed} checks. Tree: ${t.segs.size} segs, height ${t.stats().height.toFixed(1)}, ${t.stats().blossoms} blossoms, ${built.voxels.length} voxels.`);
