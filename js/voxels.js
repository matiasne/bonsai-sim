/* Pixel Bonsai — palette + voxel-list generation (pot, pebbles, wood, blossom puffs, wire).
   Pure data: no DOM/THREE. Voxels are {x,y,z, s(cube scale), ci(palette index), kind, seg}. */
(function (root) {
  'use strict';
  const B = root.Bonsai = root.Bonsai || {};

  // Stable per-voxel hash so colors never flicker across rebuilds/rotation.
  function hash3(x, y, z) {
    const xi = Math.round(x * 2), yi = Math.round(y * 2), zi = Math.round(z * 2);
    let h = (Math.imul(xi, 73856093) ^ Math.imul(yi, 19349663) ^ Math.imul(zi, 83492791)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  const PAL = {
    trunk: ['#8a684a', '#66492f', '#4c3524', '#372218'],
    leaf: ['#f7c9d6', '#f1a7bf', '#e287a6', '#c9688e'],
    leafDull: ['#d9c3a8', '#c4a98a', '#a98d6f', '#8a7057'],
    leafFrostTop: '#eef3f7',
    pot: ['#7fa3bd', '#31465c', '#263a4d', '#17242f'],
    pebble: ['#f2efe6', '#dedacb', '#c4bfae'],
    pebbleWet: ['#d8d4c6', '#beb9a9', '#a29d8d'],
    wire: ['#a8adb5', '#7b8087'],
    decalPetal: '#f1a7bf',
    decalPellet: '#e3cf6b',
    decalPelletOld: '#b7a552',
  };

  const GEO = {
    potRx: 15, potRz: 9.5,   // superellipse half-extents at the rim
    potTopY: 9, feetH: 2, potN: 4,
    soilY: 10,               // tree-space y=0 sits at this world height
    pebbleInset: 1.5,
  };

  const inSuper = (x, z, rx, rz, n) =>
    Math.pow(Math.abs(x / rx), n) + Math.pow(Math.abs(z / rz), n) <= 1;

  function buildPot() {
    const out = [];
    const N = GEO.potN;
    // feet: four posts under the corners
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        for (let y = 0.5; y < GEO.feetH; y += 1) {
          out.push({ x: sx * (GEO.potRx - 4), y, z: sz * (GEO.potRz - 3), s: 2, ci: 3, kind: 'pot', seg: -1 });
        }
      }
    }
    // body: grid-rasterized hollow superellipse shell (gap-proof), tapering to the base
    for (let y = GEO.feetH; y <= GEO.potTopY; y++) {
      const t = (y - GEO.feetH) / (GEO.potTopY - GEO.feetH);
      const rx = GEO.potRx - (1 - t) * 1.8;
      const rz = GEO.potRz - (1 - t) * 1.4;
      for (let x = -Math.ceil(rx); x <= Math.ceil(rx); x++) {
        for (let z = -Math.ceil(rz); z <= Math.ceil(rz); z++) {
          if (!inSuper(x, z, rx, rz, N)) continue;
          if (inSuper(x, z, rx - 1.4, rz - 1.4, N)) continue;   // hollow interior
          let ci;
          if (y >= GEO.potTopY - 1) ci = 0;                     // light rim band
          else if (y <= GEO.feetH + 1) ci = 3;                  // dark base
          else ci = hash3(x, y, z) < 0.82 ? 1 : 2;
          out.push({ x, y, z, s: 1, ci, kind: 'pot', seg: -1 });
        }
      }
    }
    // white pebbles filling the top
    const prx = GEO.potRx - GEO.pebbleInset, prz = GEO.potRz - GEO.pebbleInset;
    for (let x = -Math.ceil(prx); x <= prx; x++) {
      for (let z = -Math.ceil(prz); z <= prz; z++) {
        if (!inSuper(x, z, prx, prz, N)) continue;
        const h = hash3(x, 99, z);
        out.push({ x, y: GEO.potTopY + 0.6, z, s: 1, ci: h < 0.55 ? 0 : h < 0.85 ? 1 : 2, kind: 'pebble', seg: -1 });
      }
    }
    return out;
  }

  // Baked key light for wood shading (tree-local, upper front-left) — gives the
  // bark a lit side and a shadow side like classic voxel art.
  const WOOD_LIGHT = (() => {
    const l = Math.hypot(-0.55, 0.35, 0.8);
    return [-0.55 / l, 0.35 / l, 0.8 / l];
  })();

  function woodShade(nx, ny, nz, wx, wy, wz) {
    const dl = nx * WOOD_LIGHT[0] + ny * WOOD_LIGHT[1] + nz * WOOD_LIGHT[2];
    let ci = dl > 0.4 ? 0 : dl > -0.1 ? 1 : dl > -0.55 ? 2 : 3;
    // coarse patch variation (quantized lattice — no per-step striping)
    const hp = hash3(Math.round(wx / 2.5), Math.round(wy / 2.5), Math.round(wz / 2.5));
    if (hp > 0.88 && ci < 3) ci++;
    else if (hp < 0.1 && ci > 0) ci--;
    return ci;
  }

  // One branch cross-section: a disc of small voxels perpendicular to the axis,
  // shaded by the surface normal, with vertical bark-fissure streaks.
  function emitWood(out, s, px, py, pz, r, u, v, cutFace) {
    if (r < 1.05) {                            // thin twig: single chunky voxel
      const hp = hash3(Math.round(px / 2.5), Math.round(py / 2.5), Math.round(pz / 2.5));
      const ci = cutFace ? 3 : hp > 0.8 ? 0 : hp < 0.25 ? 2 : 1;
      out.push({ x: px, y: py + GEO.soilY, z: pz, s: Math.max(1, r * 2), ci, kind: 'wood', seg: s.id });
      return;
    }
    const step = 1.15, n = Math.ceil(r / step);
    for (let a = -n; a <= n; a++) {
      for (let b = -n; b <= n; b++) {
        const ox = a * step, oz = b * step;
        const d2 = ox * ox + oz * oz;
        if (d2 > r * r + 0.25) continue;
        const wx = px + u[0] * ox + v[0] * oz;
        const wy = py + u[1] * ox + v[1] * oz;
        const wz = pz + u[2] * ox + v[2] * oz;
        if (r > 2 && d2 < (r - 1.25) * (r - 1.25) && hash3(wx, wy, wz) < 0.85) continue; // hollow core
        let ci;
        if (cutFace) ci = 3;
        else {
          const inv = d2 > 0.01 ? 1 / Math.sqrt(d2) : 0;
          ci = woodShade(
            (u[0] * ox + v[0] * oz) * inv, (u[1] * ox + v[1] * oz) * inv, (u[2] * ox + v[2] * oz) * inv,
            wx, wy, wz
          );
          const sector = ((Math.atan2(b, a) / (Math.PI * 2) + 0.5) * 8) | 0;
          if (hash3(s.id * 13, sector * 7, 3) < 0.22 && ci < 3) ci++;   // fissure streak
        }
        out.push({ x: wx, y: wy + GEO.soilY, z: wz, s: 1.35, ci, kind: 'wood', seg: s.id });
      }
    }
  }

  // Rounded collar at an angled joint so elbows have no notches.
  function emitKnob(out, s, c, rc) {
    const R = Math.ceil(rc);
    for (let dx = -R; dx <= R; dx++) {
      for (let dy = -R; dy <= R; dy++) {
        for (let dz = -R; dz <= R; dz++) {
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > rc * rc + 0.3) continue;
          if (rc > 1.8 && d2 < (rc - 1.2) * (rc - 1.2)) continue;      // shell only
          const inv = d2 > 0.01 ? 1 / Math.sqrt(d2) : 0;
          const ci = woodShade(dx * inv, dy * inv, dz * inv, c[0] + dx, c[1] + dy, c[2] + dz);
          out.push({ x: c[0] + dx, y: c[1] + dy + GEO.soilY, z: c[2] + dz, s: 1.2, ci, kind: 'wood', seg: s.id });
        }
      }
    }
  }

  // puffScale shrinks blossoms (wire mode needs clickable wood).
  function buildTree(model, opts) {
    opts = opts || {};
    const puffScale = opts.puffScale === undefined ? 1 : opts.puffScale;
    const Vv = B.Vec;
    const out = [];
    const segs = [...model.segs.values()];

    for (const s of segs) {
      const childTh = s.children.length
        ? Math.max.apply(null, s.children.map(c => c.thick))
        : Math.max(0.9, s.thick * 0.6);
      let wu = Vv.cross(s.dir, Math.abs(s.dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
      wu = Vv.norm(wu);
      const wv = Vv.norm(Vv.cross(s.dir, wu));
      const steps = Math.max(2, Math.ceil(s.len / 0.7));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const px = s.start[0] + s.dir[0] * s.len * t;
        const py = s.start[1] + s.dir[1] * s.len * t;
        const pz = s.start[2] + s.dir[2] * s.len * t;
        const r = Math.max(0.55, (s.thick * (1 - t) + childTh * t) / 2);
        emitWood(out, s, px, py, pz, r, wu, wv, s.cut && i === steps);
      }
      if (s.pid !== null) {                     // collar knob fills angled joints
        const par = model.segs.get(s.pid);
        if (par && Vv.dot(par.dir, s.dir) < 0.92) {
          emitKnob(out, s, s.start, Math.max(par.thick, s.thick) / 2);
        }
      }
      if (s.wired) {
        let perp = Vv.cross(s.dir, Math.abs(s.dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
        const u = Vv.norm(perp), v = Vv.norm(Vv.cross(s.dir, u));
        const rr = Math.max(1, s.thick) / 2 + 0.55;
        const wsteps = Math.max(6, Math.ceil(s.len / 0.45));
        const turns = Math.max(2, s.len * 0.5);
        for (let i = 0; i <= wsteps; i++) {
          const t = i / wsteps, a = t * turns * Math.PI * 2;
          const ox = (Math.cos(a) * u[0] + Math.sin(a) * v[0]) * rr;
          const oy = (Math.cos(a) * u[1] + Math.sin(a) * v[1]) * rr;
          const oz = (Math.cos(a) * u[2] + Math.sin(a) * v[2]) * rr;
          const px = s.start[0] + s.dir[0] * s.len * t + ox;
          const py = s.start[1] + s.dir[1] * s.len * t + oy;
          const pz = s.start[2] + s.dir[2] * s.len * t + oz;
          out.push({
            x: px, y: py + GEO.soilY, z: pz, s: 0.8,
            ci: hash3(px, py, pz) < 0.6 ? 0 : 1, kind: 'wire', seg: s.id,
          });
        }
      }
    }

    // blossom puffs: flattened ellipsoids, hollow core, hash-fluffed edges
    const canopy = { sx: 0, sy: 0, sz: 0, n: 0, minX: 0, maxX: 0, maxY: GEO.soilY, minY: 999 };
    for (const s of segs) {
      if (out.length > 38000) break;
      const r0 = model.leafRadius(s);
      if (r0 < 1.2) continue;
      const r = Math.max(1.2, r0 * puffScale);
      const cx = s.end[0] + s.dir[0] * 0.8;
      const cy = s.end[1] + s.dir[1] * 0.8 + r * 0.18;
      const cz = s.end[2] + s.dir[2] * 0.8;
      const ry = Math.max(1.3, r * 0.62);
      const R = Math.ceil(r), RY = Math.ceil(ry);
      for (let dx = -R; dx <= R; dx++) {
        for (let dy = -RY; dy <= RY; dy++) {
          for (let dz = -R; dz <= R; dz++) {
            const q = (dx * dx + dz * dz) / (r * r) + (dy * dy) / (ry * ry);
            if (q > 1.12) continue;
            const hh = hash3(cx + dx, cy + dy, cz + dz);
            if (q < 0.5 && hh < 0.72) continue;                 // hollow the hidden core
            if (hh < 0.28) continue;                            // fluffy edge
            const topness = dy / (ry + 0.001);
            let ci = topness > 0.35 ? 0 : topness > -0.15 ? 1 : topness > -0.6 ? 2 : 3;
            if (hh > 0.86 && ci < 3) ci++;
            else if (hh < 0.37 && ci > 0) ci--;
            const wy = cy + dy + GEO.soilY;
            out.push({ x: cx + dx, y: wy, z: cz + dz, s: 1, ci, kind: 'leaf', seg: s.id });
            canopy.sx += cx + dx; canopy.sy += wy; canopy.sz += cz + dz; canopy.n++;
            canopy.minX = Math.min(canopy.minX, cx + dx);
            canopy.maxX = Math.max(canopy.maxX, cx + dx);
            canopy.maxY = Math.max(canopy.maxY, wy);
            canopy.minY = Math.min(canopy.minY, wy);
          }
        }
      }
    }
    const c = canopy.n
      ? { x: canopy.sx / canopy.n, y: canopy.sy / canopy.n, z: canopy.sz / canopy.n,
          minX: canopy.minX, maxX: canopy.maxX, maxY: canopy.maxY, minY: canopy.minY }
      : { x: 0, y: GEO.soilY + 18, z: 0, minX: -8, maxX: 8, maxY: GEO.soilY + 24, minY: GEO.soilY + 10 };
    return { voxels: out, canopy: c };
  }

  // Fallen petals / fertilizer pellets resting on the pebbles (rotate with the pot).
  function buildDecals(decals, nowMs) {
    const out = [];
    for (const d of decals) {
      const ageH = (nowMs - d.ts) / 3.6e6;
      if (d.type === 'petal') {
        if (ageH > 36) continue;
        out.push({ x: d.u, y: GEO.potTopY + 1.25, z: d.v, s: 0.9, sy: 0.35, color: PAL.decalPetal });
      } else {
        if (ageH > 12) continue;
        out.push({ x: d.u, y: GEO.potTopY + 1.25, z: d.v, s: 0.9, sy: 0.5, color: ageH > 6 ? PAL.decalPelletOld : PAL.decalPellet });
      }
    }
    return out;
  }

  // Random point on the pebble disc (for decals).
  function pebbleSpot(rand) {
    const prx = GEO.potRx - GEO.pebbleInset - 1, prz = GEO.potRz - GEO.pebbleInset - 1;
    for (let i = 0; i < 12; i++) {
      const u = (rand() * 2 - 1) * prx, v = (rand() * 2 - 1) * prz;
      if (Math.pow(Math.abs(u / prx), GEO.potN) + Math.pow(Math.abs(v / prz), GEO.potN) <= 1) return { u, v };
    }
    return { u: 0, v: 0 };
  }

  B.Voxels = { buildPot, buildTree, buildDecals, pebbleSpot, PAL, GEO, hash3 };

  if (typeof module !== 'undefined' && module.exports) module.exports = B;
})(typeof window !== 'undefined' ? window : globalThis);
