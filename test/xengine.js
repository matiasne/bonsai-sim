/* Cross-engine bit-identity test for v3 envelopes.

   Concats fmath.js + tree.js + sim.js with a scripted-care driver into one
   plain script, runs it under Node (V8) and — when available — Apple's jsc
   (JavaScriptCore), and asserts the two engines produce BYTE-IDENTICAL
   serialized trees. This is the actual claim behind "the envelope IS the
   tree": anyone can re-derive your bonsai from its DNA on any engine.

   Run: node test/xengine.js  (jsc auto-detected on macOS; skipped elsewhere) */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// The driver hash must never drift: same fixture, same tree, forever.
// If this breaks, sim math changed — bump Sim.ENV_V and gate it instead.
const GOLDEN_FNV = '7c6ee433';

const JS = (f) => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');

const DRIVER = `
(function () {
  var B = globalThis.Bonsai;
  var SIM = B.Sim;
  var env = { v: 3, seed: 424242, g: 1755000000000, s: 0, t: 0, e: [] };
  var st = SIM.newState({ seed: env.seed, g: env.g, v: 3 });
  var act = function (ev) { var r = SIM.applyAction(st, ev); if (r.ok) env.e.push(ev); return r; };
  var pass = function (sec, off) { if (off) env.e.push(['O', st.simT, sec]); SIM.advance(st, sec, !!off); };
  var careDay = function (i) {
    act(['W', st.simT]); if (i % 3 === 0) act(['F', st.simT]);
    pass(43200);
    act(['W', st.simT]); act(['M', st.simT]);
    pass(43200);
  };
  for (var d = 0; d < 10; d++) careDay(d);
  var segs = function () { var a = []; st.tree.segs.forEach(function (s) { a.push(s); }); return a; };
  var branch = segs().filter(function (s) { return s.pid !== null && s.children.length && !(s.order === 0 && s.thick > 5); })[0];
  if (branch) act(['C', st.simT, branch.id]);
  pass(2 * 86400, true);                       // offline gap
  for (d = 0; d < 4; d++) careDay(d);
  var wirable = segs().filter(function (s) { return s.pid !== null && !s.cut && s.order >= 1; })[0];
  if (wirable) {
    act(['w', st.simT, wirable.id]);
    var qb = SIM.quantBend([0.2, 0.1, 0.97], 0.31);
    act(['B', st.simT, wirable.id, qb.ax, qb.ay, qb.az, qb.a]);
  }
  for (d = 0; d < 6; d++) careDay(d);
  if (wirable) act(['u', st.simT, wirable.id]);  // early unwire → acos spring-back
  var pad = segs().filter(function (s) { return !s.children.length && !s.cut && st.tree.leafRadius(s) >= 2; })[0];
  if (pad) act(['P', st.simT, pad.id]);
  for (d = 0; d < 4; d++) careDay(d);
  env.t = st.simT;

  var rep = SIM.replay(env);
  var snapOf = function (s) {
    return JSON.stringify({ tree: s.tree.serialize(), res: s.res, gp: s.gp, simT: s.simT });
  };
  var snap = snapOf(rep), liveSnap = snapOf(st);
  var h = 0x811c9dc5;
  for (var i = 0; i < snap.length; i++) { h ^= snap.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  var out = (typeof print === 'function' && typeof process === 'undefined')
    ? print : function (s) { console.log(s); };
  out('LIVE_EQ_REPLAY=' + (snap === liveSnap));
  out('FNV=' + ('0000000' + h.toString(16)).slice(-8));
  out('SNAP=' + snap);
})();
`;

const script = [JS('fmath.js'), JS('tree.js'), JS('sim.js'), DRIVER].join('\n;\n');
const tmp = path.join(os.tmpdir(), 'bonsai-xengine-' + process.pid + '.js');
fs.writeFileSync(tmp, script);

function runWith(cmd, label) {
  const r = spawnSync(cmd, [tmp], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(label + ' failed: ' + (r.stderr || r.error));
  const out = r.stdout;
  const get = (k) => { const m = out.match(new RegExp('^' + k + '=(.*)$', 'm')); return m && m[1]; };
  if (get('LIVE_EQ_REPLAY') !== 'true') throw new Error(label + ': live ≠ replay');
  return { fnv: get('FNV'), snap: get('SNAP') };
}

function findJsc() {
  const candidates = [
    process.env.JSC,
    '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const x = spawnSync('xcrun', ['-f', 'jsc'], { encoding: 'utf8' });
  if (x.status === 0 && x.stdout.trim() && fs.existsSync(x.stdout.trim())) return x.stdout.trim();
  return null;
}

try {
  const node = runWith(process.execPath, 'node');
  console.log('  ✓ node (V8): live ≡ replay, snap ' + node.snap.length + ' bytes, fnv ' + node.fnv);
  if (node.fnv !== GOLDEN_FNV) {
    throw new Error('golden hash drifted: expected ' + GOLDEN_FNV + ', got ' + node.fnv +
      ' — sim math changed; bump Sim.ENV_V and version-gate it.');
  }
  console.log('  ✓ golden v3 hash unchanged (' + GOLDEN_FNV + ')');

  const jsc = findJsc();
  if (!jsc) {
    console.log('  – jsc not found: cross-engine check SKIPPED (V8-only run)');
  } else {
    const j = runWith(jsc, 'jsc');
    if (j.snap !== node.snap) {
      let at = 0;
      while (at < j.snap.length && j.snap[at] === node.snap[at]) at++;
      throw new Error('ENGINES DIVERGE at byte ' + at + ': …' +
        node.snap.slice(Math.max(0, at - 40), at + 40) + '… vs …' +
        j.snap.slice(Math.max(0, at - 40), at + 40) + '…');
    }
    console.log('  ✓ jsc (JavaScriptCore): byte-identical to V8 — v3 replay is cross-engine');
  }
  console.log('PASS — cross-engine bit-identity holds.');
} finally {
  try { fs.unlinkSync(tmp); } catch (e) {}
}
