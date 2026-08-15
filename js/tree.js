/* Pixel Bonsai — pure tree model: segment graph + generative growth.
   No DOM/THREE dependencies: runs as a classic browser script and in Node for tests. */
(function (root) {
  'use strict';
  const B = root.Bonsai = root.Bonsai || {};

  // Deterministic RNG whose entire state is one uint32 (persisted in saves,
  // so reloading never rerolls growth).
  function makeRng(state) {
    return {
      state: (state === undefined ? (Math.random() * 0xffffffff) : state) >>> 0,
      next() {
        this.state = (this.state + 0x6D2B79F5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), 1 | t);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
    };
  }

  const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    cross: (a, b) => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ],
    norm(a) {
      const l = Math.hypot(a[0], a[1], a[2]);
      return l < 1e-9 ? [0, 1, 0] : [a[0] / l, a[1] / l, a[2] / l];
    },
    rotate(u, axis, ang) { // Rodrigues
      const a = V.norm(axis), c = Math.cos(ang), s = Math.sin(ang);
      const cr = V.cross(a, u), k = V.dot(a, u) * (1 - c);
      return [
        u[0] * c + cr[0] * s + a[0] * k,
        u[1] * c + cr[1] * s + a[1] * k,
        u[2] * c + cr[2] * s + a[2] * k,
      ];
    },
  };

  const CFG = {
    maxSegments: 150,
    maxTips: 24,
    maxOrder: 4,
    maxHeight: 44,   // tree-space units above the soil line (y=0)
    maxRadius: 24,   // horizontal spread cap so the canopy fits the viewport
    growStep: 1.0,
    branchProb: 0.34,
    minBendY: 1.5,   // bends may not push any joint below this
    wireSetHours: 48, // wired branches "set" after ~2 real days, then release
  };

  class TreeModel {
    constructor(save) {
      this.rev = 0;
      if (save) this._load(save);
      else {
        this.rng = makeRng();
        this.ageHours = 48;
        this._seed();
      }
      this.recompute();
    }

    _add(parent, dir, len, maxLen, order) {
      const s = {
        id: this.nextId++, pid: parent ? parent.id : null,
        dir: V.norm(dir), len, maxLen, order,
        wired: false, wireAge: 0, cut: false, tipAge: 0, budBoost: 0,
        children: [], start: [0, 0, 0], end: [0, 0, 0], thick: 1, tipCount: 1,
      };
      this.segs.set(s.id, s);
      return s;
    }

    // Hand-tuned informal-upright S-curve starter — carries the reference silhouette.
    _seed() {
      this.segs = new Map();
      this.nextId = 1;
      const r = () => this.rng.next();
      const m = r() < 0.5 ? 1 : -1;                 // random mirror
      const j = () => (r() - 0.5) * 0.12;
      const t0 = this._add(null, [0.32 * m + j(), 0.94, j()], 7, 9, 0);
      const t1 = this._add(t0, [-0.30 * m + j(), 0.94, 0.08 + j()], 6.5, 8, 0);
      const t2 = this._add(t1, [0.40 * m + j(), 0.90, -0.10 + j()], 6, 7.5, 0);
      const t3 = this._add(t2, [-0.12 * m + j(), 0.98, 0.06 + j()], 4.5, 6.5, 0);
      const b1 = this._add(t1, [-0.88 * m, 0.28, 0.18], 6, 7, 1);
      const b1c = this._add(b1, [-0.68 * m, 0.55, -0.22], 3.5, 5, 1);
      const b2 = this._add(t2, [0.88 * m, 0.22, -0.24], 5, 6.5, 1);
      const b3 = this._add(t2, [0.16 * m, 0.45, 0.88], 4, 5.5, 1);
      for (const s of [t3, b1c, b2, b3]) s.tipAge = 20 + r() * 14;
    }

    root() { for (const s of this.segs.values()) if (s.pid === null) return s; return null; }
    tips() { return [...this.segs.values()].filter(s => !s.children.length); }

    // Rebuild children links, derived positions and pipe-model thickness.
    recompute() {
      for (const s of this.segs.values()) { s.children = []; }
      for (const s of this.segs.values()) {
        if (s.pid !== null) {
          const p = this.segs.get(s.pid);
          if (p) p.children.push(s);
        }
      }
      const rootSeg = this.root();
      if (!rootSeg) return;
      const walk = (s, start) => {
        s.start = start;
        s.end = [start[0] + s.dir[0] * s.len, start[1] + s.dir[1] * s.len, start[2] + s.dir[2] * s.len];
        for (const c of s.children) walk(c, s.end);
      };
      walk(rootSeg, [0, 0, 0]);
      const count = (s) => {
        s.tipCount = s.children.length ? s.children.reduce((n, c) => n + count(c), 0) : 1;
        return s.tipCount;
      };
      count(rootSeg);
      // girth keeps building over months and years (log curve: fast at first, slow forever)
      const trunkBonus = Math.min(2.6, 0.9 * Math.log10(1 + this.ageHours / 150));
      // truly old trees (3y+) get stockier: the thickness ceiling itself rises 6 → 8 by year nine
      const thickCap = 6 + Math.min(2, Math.max(0, (this.ageHours - 26280) / 52560) * 2);
      for (const s of this.segs.values()) {
        const midY = Math.max(0, (s.start[1] + s.end[1]) / 2);
        const taper = 1 - 0.32 * Math.min(1, midY / CFG.maxHeight);   // crowns stay slender
        s.thick = Math.min(thickCap, (0.9 + Math.sqrt(s.tipCount) * 0.85 + (s.order === 0 ? 0.5 + trunkBonus : 0)) * taper);
      }
    }

    // Old trees carry fuller pads (+ up to 1.5 over ~1.5 years).
    leafRadius(s) {
      if (s.children.length || s.cut) return 0;
      const ageBonus = Math.min(1.5, this.ageHours / 12000);
      const cap = (s.order === 0 ? 3.2 : Math.max(3, Math.min(6.5, 8 - s.order))) + ageBonus;
      return Math.min(cap, 1.2 + s.tipAge * 0.11);
    }

    // capBoost (not persisted) lifts structural caps — used by future previews.
    capTips() { return CFG.maxTips + (this.capBoost || 0); }
    capSegs() { return CFG.maxSegments + (this.capBoost || 0) * 6; }

    ageTips(dtH) {
      this.ageHours += dtH;
      for (const s of this.segs.values()) if (!s.children.length && !s.cut) s.tipAge += dtH;
    }

    grow(points) {
      const ev = [];
      let guard = 300;
      while (points >= 1 && guard-- > 0) {
        points -= 1;
        const candidates = this.tips();
        if (!candidates.length) break;
        for (const s of candidates) {
          s._w = 0.6 + Math.sqrt(Math.max(0, s.end[1]) / CFG.maxHeight) * 0.9
            + s.budBoost + (s.cut ? 1.4 : 0) + this.rng.next() * 0.9;
        }
        candidates.sort((a, b) => b._w - a._w);
        let e = null;
        for (const s of candidates) {           // capped tips pass the point down —
          e = this._growTip(s, candidates.length); // growth flows wherever it still can
          if (e) break;
        }
        if (e) ev.push(e); else this._redirect();
      }
      if (ev.length) this.rev++;
      this.recompute();
      return ev;
    }

    _growTip(s, tipsNow) {
      if (tipsNow === undefined) tipsNow = this.tips().length;
      const atSegCap = this.segs.size >= this.capSegs();
      if (s.cut) {                       // back-bud: a fresh shoot from a pruned stub
        if (atSegCap) return null;
        const d = V.norm([
          s.dir[0] + (this.rng.next() - 0.5) * 1.0,
          Math.abs(s.dir[1]) * 0.4 + 0.6,
          s.dir[2] + (this.rng.next() - 0.5) * 1.0,
        ]);
        const c = this._add(s, d, 0.8, Math.max(3.5, s.maxLen * 0.8), s.order);
        s.cut = false;
        s.budBoost = Math.max(0, s.budBoost - 1.5);
        this.recompute();
        return { type: 'sprout', at: c.end.slice() };
      }
      if (s.len < s.maxLen) {
        if (s.end[1] >= CFG.maxHeight && s.dir[1] > 0) return null;   // over the cap: stop climbing
        const er0 = Math.hypot(s.end[0], s.end[2]);
        if (er0 >= CFG.maxRadius && (s.dir[0] * s.end[0] + s.dir[2] * s.end[2]) > 0) return null; // stop sprawling
        s.len = Math.min(s.maxLen, s.len + CFG.growStep);
        this.recompute();
        return { type: 'grow', at: s.end.slice() };
      }
      if (atSegCap || s.end[1] >= CFG.maxHeight) return null;
      const er = Math.hypot(s.end[0], s.end[2]);
      if (er >= CFG.maxRadius) return null;

      const high = s.end[1] > CFG.maxHeight * 0.82;
      const upBias = high ? -0.05 : Math.max(0.02, 0.15 - s.order * 0.03);
      let out = [s.end[0], 0, s.end[2]];
      const ol = Math.hypot(out[0], out[2]);
      if (ol < 0.5) { const a = this.rng.next() * Math.PI * 2; out = [Math.cos(a), 0, Math.sin(a)]; }
      else out = [out[0] / ol, 0, out[2] / ol];
      const ob = er > CFG.maxRadius * 0.8 ? -0.25 : (high ? 0.24 : 0.06); // near the edge: curl back inward
      const jit = 0.30;
      let nd = V.norm([
        s.dir[0] + out[0] * ob + (this.rng.next() - 0.5) * jit,
        s.dir[1] + upBias,
        s.dir[2] + out[2] * ob + (this.rng.next() - 0.5) * jit,
      ]);
      if (s.end[1] < 5 && nd[1] < 0.05) nd = V.norm([nd[0], 0.05 + (5 - s.end[1]) * 0.05, nd[2]]);
      const cont = this._add(s, nd, CFG.growStep, Math.max(3, s.maxLen * 0.88), s.order);
      cont.tipAge = s.tipAge * 0.35;

      let branched = false;
      const p = CFG.branchProb + Math.min(0.4, s.budBoost * 0.15);
      if (tipsNow < this.capTips() && s.order < CFG.maxOrder && this.segs.size < this.capSegs() && this.rng.next() < p) {
        let perp = V.cross(s.dir, [this.rng.next() - 0.5, this.rng.next() - 0.5, this.rng.next() - 0.5]);
        if (V.len(perp) < 1e-4) perp = V.cross(s.dir, [1, 0, 0]);
        if (V.len(perp) < 1e-4) perp = [0, 0, 1];
        const ang = (0.6 + this.rng.next() * 0.55) * (this.rng.next() < 0.5 ? 1 : -1);
        let bd = V.rotate(s.dir, V.norm(perp), ang);
        if (bd[1] < -0.25) { bd[1] = -0.25; }        // pads droop, never point straight down
        const b = this._add(s, V.norm(bd), CFG.growStep, Math.max(3, s.maxLen * 0.7), Math.min(CFG.maxOrder, s.order + 1));
        b.tipAge = s.tipAge * 0.25;
        branched = true;
      }
      s.budBoost = Math.max(0, s.budBoost - 0.8);
      s.tipAge = 0;
      this.recompute();
      return { type: branched ? 'branch' : 'grow', at: cont.end.slice() };
    }

    // Every tip is capped: growth goes to girth, pad swell, and — like a real
    // mature bonsai — occasional interior back-budding so the canopy densifies.
    _redirect() {
      this.ageHours += 0.3;
      const tips = this.tips().filter(t => !t.cut);
      if (tips.length) tips[(this.rng.next() * tips.length) | 0].tipAge += 0.6;
      if (this.tips().length >= this.capTips() || this.segs.size >= this.capSegs()) return;
      if (this.rng.next() > 0.25) return;
      const interior = [...this.segs.values()].filter(s =>
        s.children.length && s.children.length < 3 && s.order < CFG.maxOrder &&
        s.end[1] < CFG.maxHeight * 0.9 && Math.hypot(s.end[0], s.end[2]) < CFG.maxRadius * 0.85);
      if (!interior.length) return;
      const p = interior[(this.rng.next() * interior.length) | 0];
      const d = V.norm([
        p.dir[0] + (this.rng.next() - 0.5) * 1.2,
        Math.abs(p.dir[1]) * 0.3 + 0.35,
        p.dir[2] + (this.rng.next() - 0.5) * 1.2,
      ]);
      const b = this._add(p, d, 0.8, Math.max(3, p.maxLen * 0.6), Math.min(CFG.maxOrder, p.order + 1));
      b.tipAge = 0;
      this.rev++;
      this.recompute();
    }

    _plain(s) {
      return {
        id: s.id, pid: s.pid,
        dir: [s.dir[0], s.dir[1], s.dir[2]],
        len: s.len, maxLen: s.maxLen, order: s.order,
        wired: s.wired ? 1 : 0, wireAge: s.wireAge || 0, cut: s.cut ? 1 : 0,
        tipAge: s.tipAge, budBoost: s.budBoost,
      };
    }
    _revive(d) {
      return {
        id: d.id, pid: d.pid, dir: V.norm(d.dir), len: d.len, maxLen: d.maxLen,
        order: d.order, wired: !!d.wired, wireAge: d.wireAge || 0, cut: !!d.cut,
        tipAge: d.tipAge || 0, budBoost: d.budBoost || 0,
        children: [], start: [0, 0, 0], end: [0, 0, 0], thick: 1, tipCount: 1,
      };
    }

    cut(id) {
      const s = this.segs.get(id);
      if (!s) return { ok: false, reason: 'missing' };
      if (s.pid === null) return { ok: false, reason: 'trunk' };
      if (s.order === 0 && s.thick > 5) return { ok: false, reason: 'thick' };
      const removed = [];
      const collect = (x) => { for (const c of x.children) { collect(c); removed.push(this._plain(c)); } };
      collect(s);
      for (const r of removed) this.segs.delete(r.id);
      const undo = {
        stubId: s.id, len: s.len, wired: s.wired, budBoost: s.budBoost,
        parentBoost: null, segs: removed,
      };
      const at = s.end.slice();
      s.len = Math.max(0.8, s.len * 0.3);
      s.cut = true; s.wired = false; s.tipAge = 0; s.budBoost += 2.5;
      const p = this.segs.get(s.pid);
      if (p) { undo.parentBoost = { id: p.id, budBoost: p.budBoost }; p.budBoost += 2; }
      this.rev++;
      this.recompute();
      return { ok: true, removed: removed.length + 1, at, undo };
    }

    restore(undo) {
      const s = this.segs.get(undo.stubId);
      if (!s) return false;
      s.len = undo.len; s.cut = false; s.wired = undo.wired; s.budBoost = undo.budBoost;
      if (undo.parentBoost) {
        const p = this.segs.get(undo.parentBoost.id);
        if (p) p.budBoost = undo.parentBoost.budBoost;
      }
      for (const d of undo.segs) this.segs.set(d.id, this._revive(d));
      this.rev++;
      this.recompute();
      return true;
    }

    wire(id, on) {
      const s = this.segs.get(id);
      if (!s || s.pid === null || s.cut) return null;
      s.wired = on === undefined ? !s.wired : !!on;
      s.wireAge = 0;
      this.rev++;
      return s.wired;
    }

    // Wire sets over REAL sim time; a released wire keeps the bent shape.
    ageWires(dtH) {
      const released = [];
      for (const s of this.segs.values()) {
        if (!s.wired) continue;
        s.wireAge += dtH;
        if (s.wireAge >= CFG.wireSetHours) {
          s.wired = false;
          s.wireAge = 0;
          released.push({ id: s.id, at: s.end.slice() });
        }
      }
      if (released.length) this.rev++;
      return released;
    }

    bend(id, axis, ang) {
      const s = this.segs.get(id);
      if (!s || !s.wired || !isFinite(ang) || ang === 0) return false;
      const rot = (x, a) => { x.dir = V.rotate(x.dir, axis, a); for (const c of x.children) rot(c, a); };
      rot(s, ang);
      this.recompute();
      let minY = Infinity;
      const scan = (x) => { minY = Math.min(minY, x.end[1]); for (const c of x.children) scan(c); };
      scan(s);
      if (minY < CFG.minBendY) {           // would dip below the soil: revert
        rot(s, -ang);
        this.recompute();
        return false;
      }
      const renorm = (x) => { x.dir = V.norm(x.dir); for (const c of x.children) renorm(c); };
      renorm(s);
      this.recompute();
      this.rev++;
      return true;
    }

    stats() {
      let tips = 0, height = 0, blossoms = 0, minX = 0, maxX = 0;
      for (const s of this.segs.values()) {
        height = Math.max(height, s.end[1]);
        minX = Math.min(minX, s.end[0]);
        maxX = Math.max(maxX, s.end[0]);
        if (!s.children.length) {
          tips++;
          if (this.leafRadius(s) >= 2) blossoms++;
        }
      }
      return { segments: this.segs.size, tips, height, width: maxX - minX, blossoms, ageHours: this.ageHours };
    }

    serialize() {
      return {
        rngState: this.rng.state,
        nextId: this.nextId,
        ageHours: Math.round(this.ageHours * 100) / 100,
        // dir/len/budBoost stay full-precision: ANY rounding lets a height/radius
        // growth gate flip on reload, breaking determinism. tipAge is visual-only.
        segs: [...this.segs.values()].map(s => {
          const d = this._plain(s);
          d.tipAge = Math.round(d.tipAge * 10) / 10;
          d.wireAge = Math.round(d.wireAge * 10) / 10;
          return d;
        }),
      };
    }

    _load(save) {
      this.rng = makeRng(save.rngState);
      this.nextId = save.nextId || 1;
      this.ageHours = save.ageHours || 0;
      this.segs = new Map();
      for (const d of save.segs || []) this.segs.set(d.id, this._revive(d));
      if (!this.root()) { this.ageHours = 48; this._seed(); }
    }
  }

  // What-if: grow a CLONE of a serialized tree through `years` of good care.
  // Deterministic (clone inherits the RNG state) and never touches the original.
  function growFuture(serialized, years) {
    const clone = new TreeModel(serialized);
    clone.capBoost = years * 3;            // more years → more ramification allowed
    let stale = 0, lastRev = clone.rev;
    const rounds = Math.min(420, years * 160);
    for (let i = 0; i < rounds && stale < 15; i++) {
      clone.ageTips(40);
      clone.grow(40);
      if (clone.rev === lastRev) stale++; else { stale = 0; lastRev = clone.rev; }
    }
    for (const s of clone.segs.values()) { s.wired = false; s.wireAge = 0; }  // long since set
    clone.rev++;
    clone.ageHours = (serialized.ageHours || 0) + years * 8760;
    clone.recompute();
    return clone;
  }

  B.TreeModel = TreeModel;
  B.TreeCFG = CFG;
  B.Vec = V;
  B.makeRng = makeRng;
  B.growFuture = growFuture;

  if (typeof module !== 'undefined' && module.exports) module.exports = B;
})(typeof window !== 'undefined' ? window : globalThis);
