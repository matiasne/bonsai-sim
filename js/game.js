/* Pixel Bonsai — game integrator: Three.js scene, sim tick, input, FX, UI, persistence. */
(function () {
  'use strict';
  const B = window.Bonsai;
  const GEO = B.Voxels.GEO;
  const PAL = B.Voxels.PAL;
  const SIM = B.Sim;

  // ---------- constants
  const WALLPAPER = /[?#&]wallpaper/.test(location.search + location.hash);
  // running inside the native menu-bar app (electron/preload.js sets this marker) —
  // the panel exists to tend the tree, so its care dock never fades out
  const DESKTOP_APP = typeof window !== 'undefined' && !!window.bonsaiDesktop;
  const DNA_HASH = /[#&]dna=([^&\s]+)/.exec(location.hash);
  const VIEWER = !!DNA_HASH;   // #dna=… — read-only view of a shared bonsai
  // #wallpaper&seed=<dna>[&nft=<id>] — one-time seed for a fresh wallpaper install:
  // the tree it starts as before it grows (and, same-origin, syncs) on its own.
  const SEED_HASH = WALLPAPER ? /[#&]seed=([^&\s]+)/.exec(location.hash) : null;
  const SEED_NFT = WALLPAPER ? /[#&]nft=(\d+)/.exec(location.hash) : null;
  let viewerStatus = '🧬 viewing a shared bonsai — read-only · drag the pot to rotate';
  let BUFH = 176;                   // backbuffer height (pixel density × 176; CSS upscales)
  let BUFW = 176;                   // width follows the screen in wallpaper mode
  let aspect = 1;
  const RES_SCALES = [1, 1.5, 2];   // pixel-density steps for the ▦ button
  let resIdx = 0;
  let savedPix = 2;                 // the page's stored density choice — wallpaper mode is pinned to 2× but must not clobber it (file:// hosts can share localStorage)
  const HALF = 44;                  // ortho half-HEIGHT in world units → 2 buffer px per voxel
  const LOOK_Y = 31;
  const ELEV = 0.165;               // camera elevation (rad)
  const KEY = 'pixel-bonsai-v1';
  const SLOP = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];

  // ---------- tiny helpers
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  // ---------- DOM refs
  const view = $('#view'), fxCanvas = $('#fx'), fatalEl = $('#fatal');
  const statusEl = $('#status-line'), toastsEl = $('#toasts');
  const chipClock = $('#chip-clock'), chipWeather = $('#chip-weather');

  function fatal(msg) {
    fatalEl.textContent = msg;
    fatalEl.classList.remove('hidden');
  }

  const lastPointer = { x: 0, y: 0, t: 0 };
  document.addEventListener('pointermove', (e) => { lastPointer.x = e.clientX; lastPointer.y = e.clientY; lastPointer.t = performance.now(); }, { passive: true });
  document.addEventListener('pointerdown', (e) => { lastPointer.x = e.clientX; lastPointer.y = e.clientY; lastPointer.t = performance.now(); }, { capture: true, passive: true });

  function toast(msg, opts) {
    opts = opts || {};
    if (!opts.action) {
      // the same message is already up: keep it, don't re-pop it
      for (const old of toastsEl.children) {
        if (!old.classList.contains('has-action') && old.textContent === msg) {
          clearTimeout(old._t);
          old._t = setTimeout(() => old.remove(), opts.ms || 3400);
          return;
        }
      }
    }
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    if (opts.action) {
      el.classList.add('has-action');
      const b = document.createElement('button');
      b.textContent = opts.action.label;
      b.onclick = () => { el.remove(); opts.action.fn(); };
      el.appendChild(b);
    }
    if (!opts.action) {   // plain messages never stack — the new one replaces the old
      for (const old of [...toastsEl.children]) if (!old.classList.contains('has-action')) old.remove();
    }
    toastsEl.appendChild(el);
    while (toastsEl.children.length > 3) toastsEl.firstChild.remove();
    // plain messages: one slot at the bottom of the scene; actionable
    // toasts appear near the pointer (bottom-center when it's unknown)
    const idx = toastsEl.children.length - 1;
    const w = el.offsetWidth, h = el.offsetHeight;
    const fresh = lastPointer.t > 0 && performance.now() - lastPointer.t < 15000;
    let x, y;
    if (!opts.action) {
      const r = view.getBoundingClientRect();
      x = clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8);
      y = clamp(r.bottom - h - (WALLPAPER ? 64 : 10), 8, window.innerHeight - h - 8);
    } else if (fresh) {
      x = clamp(lastPointer.x + 14, 8, window.innerWidth - w - 8);
      y = clamp(lastPointer.y - h - 16 - idx * (h + 8), 8, window.innerHeight - h - 8);
    } else {
      x = Math.max(8, (window.innerWidth - w) / 2);
      y = window.innerHeight - h - (WALLPAPER ? 72 : 28) - idx * (h + 8);
    }
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el._t = setTimeout(() => el.remove(), opts.ms || 3400);
  }

  const store = {
    mem: {}, warned: false,
    get(k) { try { return localStorage.getItem(k); } catch (e) { return this.mem[k] || null; } },
    set(k, v) {
      try { localStorage.setItem(k, v); } catch (e) {
        this.mem[k] = v;
        if (!this.warned) { this.warned = true; toast("⚠ storage unavailable — progress won't persist"); }
      }
    },
    del(k) { try { localStorage.removeItem(k); } catch (e) { delete this.mem[k]; } },
  };

  // ---------- state
  let S = null;       // deterministic sim state (B.Sim): tree, res, gp, burnH, soggy, trimBoost, dyingH, simT
  let dna = null;     // the envelope {v:2, seed, g, s, t, e, snap?} — S is always replay(dna) + live steps
  let nft = null;     // minted-token record {tokenId, contract, chain, txHash, simT, ts} — save cosmetics, NEVER in the envelope
  // A tree is "kept" (persisted + owned) only once it is minted. Until then it is a
  // free demo that lives only in memory — see save() and the KEEP button.
  const isMinted = () => !!(nft && nft.tokenId);
  let atts = [];      // notary attestations {ts, simT, n, sig} — provable history age; save cosmetics, NEVER in the envelope
  let attInFlight = false, attLastTry = 0;
  let tree = null;    // alias of S.tree — rebound on boot/freshTree/log rewind
  let res = null;     // alias of S.res
  let pendingSec = 0; // wall-clock time not yet folded into the sim (sub-quantum remainder)
  let theta = -0.55, thetaVel = 0;
  let zoom = 1, panY = 0;
  let mode = 'view';
  let previewTree = null, previewYears = 0, futureBarOpen = false;
  const previewCache = new Map();
  let decals = [], decalsDirty = true;
  let lastEnv = null, statsCache = null;
  let keepNudged = false;   // one-shot: nudge to KEEP at the first attachment moment
  let bg = 'classic';       // selected background preset key (cosmetic; rides the save)
  // ---- same-origin live sync (browser ⇄ desktop wallpaper share one tree)
  const CLIENT_ID = ((Math.random() * 1e9) >>> 0).toString(36) + '-' + ((Math.random() * 1e9) >>> 0).toString(36);
  let syncCh = null;        // BroadcastChannel or null (unsupported)
  let isLeader = true;      // sole context is the leader; only the leader advances time
  let sawPeer = false;      // another same-origin context is alive
  let applyingRemote = false; // guard: don't rebroadcast a save we just applied
  let lastTick = Date.now(), lastSaveAt = Date.now();
  let drag = null, lastInteract = 0, dockWake = 0;
  const fxRng = B.makeRng((Math.random() * 0xffffffff) >>> 0);

  // ---------- Three.js scene
  let scene, camera, renderer, rotGroup, potMesh, treeMesh, decalMesh, starPts, starMat;
  const SAND_S = 29, SAND_TEX = 128;   // zen sand: half-extent (world units), texture px
  let sandCanvas, sandCtx, sandTexture, sandMesh, sandFade = 0;
  let m4, q4, v3, sc3, col;
  const treeSegByInst = [], treeKindByInst = [];
  let potVox = null, canopy = null;
  let treeKey = '', potKey = '';

  function makeInstMesh(cap) {
    const g = new THREE.BoxGeometry(1, 1, 1);
    const m = new THREE.MeshBasicMaterial();
    const mesh = new THREE.InstancedMesh(g, m, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    return mesh;
  }

  function setupScene() {
    m4 = new THREE.Matrix4(); q4 = new THREE.Quaternion(); v3 = new THREE.Vector3();
    sc3 = new THREE.Vector3(); col = new THREE.Color();

    if (WALLPAPER) aspect = Math.min(3.4, Math.max(0.5, window.innerWidth / Math.max(1, window.innerHeight)));
    renderer = new THREE.WebGLRenderer({ canvas: view, antialias: false });
    renderer.setSize(BUFW, BUFH, false);
    renderer.setClearColor(0xf4f1ea);

    scene = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-HALF, HALF, HALF, -HALF, 1, 400);
    camera.position.set(0, LOOK_Y + Math.sin(ELEV) * 120, Math.cos(ELEV) * 120);
    camera.lookAt(0, LOOK_Y, 0);
    camera.updateMatrixWorld();

    rotGroup = new THREE.Group();
    scene.add(rotGroup);

    potMesh = makeInstMesh(4096);
    treeMesh = makeInstMesh(40960);
    decalMesh = makeInstMesh(64);
    rotGroup.add(potMesh, treeMesh, decalMesh);

    // zen sand tray: rakeable canvas-textured square under the pot, wooden frame
    sandCanvas = document.createElement('canvas');
    sandCanvas.width = sandCanvas.height = SAND_TEX;
    sandCtx = sandCanvas.getContext('2d');
    drawSandBase();
    drawStarterPattern();
    sandTexture = new THREE.CanvasTexture(sandCanvas);
    sandTexture.magFilter = THREE.NearestFilter;
    sandTexture.minFilter = THREE.NearestFilter;
    sandMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(SAND_S * 2, SAND_S * 2),
      new THREE.MeshBasicMaterial({ map: sandTexture })
    );
    sandMesh.rotation.x = -Math.PI / 2;
    sandMesh.position.y = 0;
    rotGroup.add(sandMesh);
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(SAND_S * 2, 2, SAND_S * 2),
      new THREE.MeshBasicMaterial({ color: 0xcfc4a6 })
    );
    slab.position.y = -1.05;
    rotGroup.add(slab);
    const frameMat = new THREE.MeshBasicMaterial({ color: 0x54392a });
    for (const [fx, fz, fw, fd] of [
      [0, -(SAND_S + 1), SAND_S * 2 + 4, 2], [0, SAND_S + 1, SAND_S * 2 + 4, 2],
      [-(SAND_S + 1), 0, 2, SAND_S * 2], [SAND_S + 1, 0, 2, SAND_S * 2],
    ]) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(fw, 3, fd), frameMat);
      f.position.set(fx, -0.6, fz);
      rotGroup.add(f);
    }

    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 24),
      new THREE.MeshBasicMaterial({ color: 0x1a2430, transparent: true, opacity: 0.10 })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.set(GEO.potRx + 5, GEO.potRz + 4, 1);
    shadow.position.y = 0.04;
    scene.add(shadow);

    // faint night stars on a far plane (outside rotGroup — the sky doesn't spin)
    const starPos = [];
    for (let i = 0; i < 42; i++) {
      starPos.push(
        (B.Voxels.hash3(i, 7, 1) - 0.5) * 2 * (HALF * aspect - 4),
        14 + B.Voxels.hash3(i, 13, 5) * 54,
        -80
      );
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    starMat = new THREE.PointsMaterial({ color: 0x9fb0d0, size: 2, sizeAttenuation: false, transparent: true, opacity: 0 });
    starPts = new THREE.Points(sg, starMat);
    scene.add(starPts);

    potVox = B.Voxels.buildPot();
  }

  // ---------- zen sand drawing
  function drawSandBase() {
    sandCtx.globalAlpha = 1;
    sandCtx.fillStyle = '#e3dabe';
    sandCtx.fillRect(0, 0, SAND_TEX, SAND_TEX);
    for (let i = 0; i < 2400; i++) {
      sandCtx.fillStyle = pick(['#ded4b4', '#eae2c9', '#d6cba9']);
      sandCtx.fillRect((fxRng.next() * SAND_TEX) | 0, (fxRng.next() * SAND_TEX) | 0, 1, 1);
    }
  }
  function ringRake(r) {
    const k = SAND_TEX / (2 * SAND_S);
    sandCtx.strokeStyle = '#c6b995'; sandCtx.lineWidth = 1.3;
    sandCtx.beginPath(); sandCtx.arc(SAND_TEX / 2, SAND_TEX / 2, r * k, 0, 7); sandCtx.stroke();
    sandCtx.strokeStyle = '#f4eeda'; sandCtx.lineWidth = 1;
    sandCtx.beginPath(); sandCtx.arc(SAND_TEX / 2, SAND_TEX / 2 - 1, r * k, 0, 7); sandCtx.stroke();
  }
  function drawStarterPattern() {
    for (const r of [14, 18.5, 23, 27.5]) ringRake(r);   // classic rings around the "rock"
  }
  function drawRakeSegment(a, b) {  // 4-tooth rake stroke, in texture px
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.8) return false;
    const px = -dy / len, py = dx / len;
    sandCtx.lineCap = 'round';
    for (const o of [-3.4, -1.15, 1.15, 3.4]) {
      sandCtx.strokeStyle = '#c6b995'; sandCtx.lineWidth = 1.3;
      sandCtx.beginPath();
      sandCtx.moveTo(a.x + px * o, a.y + py * o);
      sandCtx.lineTo(b.x + px * o, b.y + py * o);
      sandCtx.stroke();
      sandCtx.strokeStyle = '#f4eeda'; sandCtx.lineWidth = 0.9;
      sandCtx.beginPath();
      sandCtx.moveTo(a.x + px * o, a.y + py * o - 1);
      sandCtx.lineTo(b.x + px * o, b.y + py * o - 1);
      sandCtx.stroke();
    }
    sandTexture.needsUpdate = true;
    return true;
  }
  function drawDimple(p) {
    sandCtx.strokeStyle = '#c6b995'; sandCtx.lineWidth = 1.2;
    sandCtx.beginPath(); sandCtx.arc(p.x, p.y, 2.2, 0, 7); sandCtx.stroke();
    sandCtx.strokeStyle = '#f4eeda'; sandCtx.lineWidth = 1;
    sandCtx.beginPath(); sandCtx.arc(p.x, p.y - 1, 2.2, 0, 7); sandCtx.stroke();
    sandTexture.needsUpdate = true;
  }

  // ---------- voxel → instance sync
  function colorFor(o, tier, frost, wet) {
    if (o.kind === 'wood') return (res.dead ? PAL.trunkDead : PAL.trunk)[o.ci];
    if (o.kind === 'wire') return PAL.wire[o.ci];
    if (o.kind === 'leaf') {
      if (frost && o.ci === 0) return PAL.leafFrostTop;
      const pal = tier === 'dull' ? PAL.leafDull
        : tier === 'green' ? PAL.leafGreen
        : tier === 'autumn' ? PAL.leafAutumn
        : PAL.leaf;
      return pal[o.ci];
    }
    if (o.kind === 'pebble') return (wet ? PAL.pebbleWet : PAL.pebble)[o.ci];
    return PAL.pot[o.ci];
  }

  function writeInstances(mesh, list, colorOf) {
    const cap = mesh.instanceMatrix.count;
    const n = Math.min(list.length, cap);
    q4.identity();
    for (let i = 0; i < n; i++) {
      const o = list[i];
      m4.compose(v3.set(o.x, o.y, o.z), q4, sc3.set(o.s, o.sy === undefined ? o.s : o.sy, o.s));
      mesh.setMatrixAt(i, m4);
      mesh.setColorAt(i, col.set(colorOf(o)));
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  function leafSum(t) {
    let s = 0;
    for (const seg of t.segs.values()) if (!seg.children.length && !seg.cut) s += t.leafRadius(seg);
    return s;
  }

  let lastTier = 'pink';
  function foliageTier() {
    if (res.dead) return 'bare';                       // 🪦
    if (previewTree) return 'pink';                    // visions bloom eternally
    if (res.health < 25) return 'bare';
    if (res.health < 55) return 'dull';
    const season = lastEnv ? lastEnv.season : 'spring';
    if (season === 'winter') return 'bare';            // deciduous: bare in dormancy
    if (lastEnv && lastEnv.bloom) return 'pink';       // ~3 weeks of hanami
    if (season === 'autumn') return 'autumn';
    return 'green';
  }

  function syncTree(force) {
    const rt = previewTree || tree;                              // 🔮 vision renders instead
    const tier = foliageTier();
    lastTier = tier;
    const frost = !previewTree && !!(lastEnv && (lastEnv.frost || lastEnv.snowing));
    const puffScale = mode === 'wire' ? 0.6 : 1;
    const key = [rt.rev, previewYears, Math.round(leafSum(rt) * 2), puffScale, tier, frost ? 1 : 0, res.dead ? 1 : 0].join('|');
    if (!force && key === treeKey) return;
    treeKey = key;
    const built = B.Voxels.buildTree(rt, { puffScale });
    canopy = built.canopy;
    let list = built.voxels;
    if (tier === 'bare') list = list.filter(o => o.kind !== 'leaf');
    writeInstances(treeMesh, list, o => colorFor(o, tier, frost, false));
    treeSegByInst.length = 0; treeKindByInst.length = 0;
    for (let i = 0; i < list.length; i++) { treeSegByInst[i] = list[i].seg; treeKindByInst[i] = list[i].kind; }
  }

  function syncPot(force) {
    const wet = res.water > 65;
    const key = wet ? 'wet' : 'dry';
    if (!force && key === potKey) return;
    potKey = key;
    writeInstances(potMesh, potVox, o => colorFor(o, 'pink', false, wet));
  }

  function syncDecals() {
    if (!decalsDirty) return;
    decalsDirty = false;
    const list = B.Voxels.buildDecals(decals, Date.now());
    writeInstances(decalMesh, list, o => o.color);
  }

  // ---------- projection + picking
  function projectTreePt(p) { // tree-space point (soil at y=0) → backbuffer px
    scene.updateMatrixWorld();
    v3.set(p[0], p[1] + GEO.soilY, p[2]);
    rotGroup.localToWorld(v3);
    v3.project(camera);
    return { x: (v3.x * 0.5 + 0.5) * BUFW, y: (-v3.y * 0.5 + 0.5) * BUFH };
  }
  function projectLocalPt(x, y, z) { // rotGroup-space point → backbuffer px
    scene.updateMatrixWorld();
    v3.set(x, y, z);
    rotGroup.localToWorld(v3);
    v3.project(camera);
    return { x: (v3.x * 0.5 + 0.5) * BUFW, y: (-v3.y * 0.5 + 0.5) * BUFH };
  }

  let ray = null;

  // Wallpaper mode: the backbuffer width tracks the screen's aspect so the scene
  // fills any monitor without distortion (height stays density × 176 → same pixel scale).
  function applyViewport() {
    if (!WALLPAPER) return;
    aspect = Math.min(3.4, Math.max(0.5, window.innerWidth / Math.max(1, window.innerHeight)));
    BUFW = Math.round(BUFH * aspect);
    renderer.setSize(BUFW, BUFH, false);
    fxCanvas.width = BUFW;
    fxCanvas.height = BUFH;
    camera.left = -HALF * aspect;
    camera.right = HALF * aspect;
    camera.updateProjectionMatrix();
  }

  // Pixel density: same view, more (or fewer) pixels — see how the art reads.
  function applyRes(i) {
    resIdx = ((i % RES_SCALES.length) + RES_SCALES.length) % RES_SCALES.length;
    const k = RES_SCALES[resIdx];
    BUFH = Math.round(176 * k);
    if (WALLPAPER) {
      applyViewport();
    } else {
      BUFW = BUFH;
      renderer.setSize(BUFW, BUFH, false);
      fxCanvas.width = BUFW;
      fxCanvas.height = BUFH;
    }
    const label = k === 1 ? '1×' : k === 1.5 ? '1.5×' : '2×';
    const b = $('#btn-res');
    if (b) b.textContent = label;
  }

  function applyZoom(z) {
    zoom = clamp(z, 0.6, 3.2);
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
    applyPan(panY);              // zooming out re-centers via the pan clamp
  }

  function applyPan(p) {
    const maxPan = Math.max(0, HALF * (1 - 1 / zoom));   // never pan past the un-zoomed frame
    panY = clamp(p, -maxPan, maxPan);
    camera.position.set(0, LOOK_Y + panY + Math.sin(ELEV) * 120, Math.cos(ELEV) * 120);
    camera.lookAt(0, LOOK_Y + panY, 0);
    camera.updateMatrixWorld();
  }

  // Raycast the whole scene (tree + pot). Returns the front-most acceptable hit as
  // {target: 'pot'|'pebble'|'leaf'|'wood'|'wire', segId?}. No preview guard here —
  // the pot must stay grabbable for rotation inside 🔮 visions.
  function pickScene(clientX, clientY, opts) {
    opts = opts || {};
    scene.updateMatrixWorld();
    if (!ray) ray = new THREE.Raycaster();
    const rect = view.getBoundingClientRect();
    const bx = (clientX - rect.left) / rect.width;
    const by = (clientY - rect.top) / rect.height;
    for (const [ox, oy] of SLOP) {
      const nx = (bx + ox / BUFW) * 2 - 1;
      const ny = -((by + oy / BUFH) * 2 - 1);
      ray.setFromCamera({ x: nx, y: ny }, camera);
      const hits = ray.intersectObjects([treeMesh, potMesh, sandMesh]);
      for (const h of hits) {
        if (h.object === sandMesh) {
          if (opts.treeOnly) continue;
          return { target: 'sand' };
        }
        if (h.instanceId === undefined) continue;
        if (h.object === potMesh) {
          if (opts.treeOnly) continue;
          const v = potVox[h.instanceId];
          return { target: v ? v.kind : 'pot' };
        }
        const kind = treeKindByInst[h.instanceId];
        if (opts.skipLeaf && kind === 'leaf') continue;
        const segId = treeSegByInst[h.instanceId];
        if (segId !== undefined && segId >= 0) return { target: kind, segId };
      }
    }
    return null;
  }

  // Where does the pointer land on the sand? → texture px, or null.
  function sandHit(clientX, clientY) {
    scene.updateMatrixWorld();
    if (!ray) ray = new THREE.Raycaster();
    const rect = view.getBoundingClientRect();
    ray.setFromCamera({
      x: ((clientX - rect.left) / rect.width) * 2 - 1,
      y: -(((clientY - rect.top) / rect.height) * 2 - 1),
    }, camera);
    const h = ray.intersectObject(sandMesh)[0];
    if (!h) return null;
    v3.copy(h.point);
    rotGroup.worldToLocal(v3);
    const k = SAND_TEX / (2 * SAND_S);
    return { x: clamp((v3.x + SAND_S) * k, 0, SAND_TEX), y: clamp((v3.z + SAND_S) * k, 0, SAND_TEX) };
  }

  // Branch picking for the ✂️/➰ tools (tree only, blocked during visions).
  function pickAt(clientX, clientY) {
    if (previewTree) return null;
    const s = pickScene(clientX, clientY, { treeOnly: true, skipLeaf: mode === 'wire' });
    if (!s || s.segId === undefined) return null;
    return { segId: s.segId, kind: s.target };
  }

  function bendAxisLocal() {
    camera.getWorldDirection(v3);
    rotGroup.getWorldQuaternion(q4);
    v3.applyQuaternion(q4.invert());
    return [v3.x, v3.y, v3.z];
  }
  function pitchAxisLocal() { // camera's screen-x axis, in pot-local space
    v3.setFromMatrixColumn(camera.matrixWorld, 0);
    rotGroup.getWorldQuaternion(q4);
    v3.applyQuaternion(q4.invert());
    return [v3.x, v3.y, v3.z];
  }

  // ---------- input
  const touches = new Map();
  function touchDist() {
    const p = [...touches.values()];
    return p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  }

  function bindInput() {
    view.addEventListener('contextmenu', e => e.preventDefault());

    view.addEventListener('wheel', (e) => {
      e.preventDefault();
      lastInteract = performance.now();
      applyZoom(zoom * Math.exp(-e.deltaY * 0.0016));
    }, { passive: false });

    view.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button === 2) {
        // right-click: cancel whatever is in progress and put the tools away
        const hadTool = drag !== null || branchMenuSeg !== null || mode !== 'view';
        drag = null;
        closeBranchMenu();
        if (mode !== 'view') setMode('view');
        else if (!hadTool && futureBarOpen) toggleFuture();
        return;
      }
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      lastInteract = performance.now();
      view.setPointerCapture(e.pointerId);
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) { drag = { type: 'pinch', d: touchDist() }; return; }
      const menuWasOpen = branchMenuSeg !== null;   // dismissal swallows only background taps
      if (menuWasOpen && mode !== 'view') closeBranchMenu();
      const start = { x: e.clientX, y: e.clientY };
      if (mode === 'prune') {
        const hit = pickAt(e.clientX, e.clientY);
        if (hit) { drag = { type: 'maybePrune', hit, start }; return; }
      } else if (mode === 'trim') {
        const hit = pickAt(e.clientX, e.clientY);
        if (hit) { drag = { type: 'maybeTrim', hit, start }; return; }
      } else if (mode === 'wire') {
        const hit = pickAt(e.clientX, e.clientY);
        if (hit) {
          const seg = tree.segs.get(hit.segId);
          if (seg && !seg.wired && doWire(hit.segId)) {
            const mo = Math.max(1, Math.round(tree.wireSetHours(seg) / 720));
            toast(`➰ wire on — drag to bend · needs ~${mo} month${mo > 1 ? 's' : ''} to set`);
          }
          drag = beginBend(hit.segId, e);
          return;
        }
      }
      // the scene is the interface: pot = rotate handle, pebbles = feed,
      // blossoms = mist, open air (outside the branches / above) = water
      const s = pickScene(e.clientX, e.clientY);
      if (menuWasOpen && mode === 'view') {
        // taps heading toward a pad/branch retarget the menu in place (no blink);
        // anything else dismisses it right away
        const keeps = s && (s.target === 'leaf' || s.target === 'wood' || s.target === 'wire');
        if (!keeps) closeBranchMenu();
      }
      if (s && (s.target === 'pot' || s.target === 'pebble')) {
        drag = { type: 'rotate', lastX: e.clientX, lastY: e.clientY, moved: 0, tap: s.target };
      } else if (mode === 'view') {
        if (s && s.target === 'leaf') drag = { type: 'maybeTap', action: 'mist', segId: s.segId, start };
        else if (!s) {
          // pour from above — unless this tap was just dismissing an open menu
          if (!menuWasOpen) drag = { type: 'maybeTap', action: 'water', start };
        }
        else if (s && s.target === 'wire' && !previewTree && !VIEWER) {
          // grab a placed wire: bend its branch right away (tap still opens the menu)
          drag = beginBend(s.segId, e, true);
        } else if (s && s.target === 'wood' && !previewTree) {
          drag = { type: 'maybeBranch', segId: s.segId, start };            // tap → ✂️/➰ menu
        } else if (s && s.target === 'sand') {
          drag = { type: 'rake', last: sandHit(e.clientX, e.clientY), moved: 0 };
        }
      } else if (WALLPAPER) {
        setMode('view');   // no toolbar on the desktop: tap empty space to put the tool away
      }
    });

    // hover: in view mode the cursor becomes the action a tap would perform
    let hoverAt = 0;
    view.addEventListener('pointermove', (e) => {
      if (drag || e.pointerType === 'touch') return;
      const now = performance.now();
      if (now - hoverAt < 70) return;
      hoverAt = now;
      let h = '';
      if (mode === 'view' && !previewTree) {
        const s = pickScene(e.clientX, e.clientY);
        h = s ? s.target : 'sky';
      }
      if (view.dataset.hover !== h) view.dataset.hover = h;
    });
    view.addEventListener('pointerleave', () => { view.dataset.hover = ''; });

    view.addEventListener('pointermove', (e) => {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!drag) return;
      if (drag.type === 'pinch') {
        if (touches.size >= 2) {
          const d = touchDist();
          if (drag.d > 12) applyZoom(zoom * (d / drag.d));
          drag.d = d;
        }
        return;
      }
      if (drag.type === 'maybePrune' || drag.type === 'maybeTrim' || drag.type === 'maybeTap' || drag.type === 'maybeBranch') {
        if (Math.hypot(e.clientX - drag.start.x, e.clientY - drag.start.y) > 6) drag = null;
        return;
      }
      if (drag.type === 'rake') {
        const p = sandHit(e.clientX, e.clientY);
        if (p && drag.last) {
          if (drawRakeSegment(drag.last, p)) {
            drag.moved += Math.hypot(p.x - drag.last.x, p.y - drag.last.y);
            drag.last = p;
            if (fxRng.next() < 0.4) {                       // kicked-up sand grains
              const rect = view.getBoundingClientRect();
              addPart({
                kind: 'spark',
                x: ((e.clientX - rect.left) / rect.width) * BUFW,
                y: ((e.clientY - rect.top) / rect.height) * BUFH - 1,
                vx: (fxRng.next() - 0.5) * 16, vy: -8 - fxRng.next() * 10, g: 140,
                ttl: 0.35, t: 0, c: pick(['#d8cdaa', '#eae2c9']), w: 1, h: 1,
              });
            }
          }
        } else if (p) drag.last = p;
        return;
      }
      if (drag.type === 'rotate') {
        const dx = e.clientX - drag.lastX;
        const dy = e.clientY - drag.lastY;
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        drag.moved = (drag.moved || 0) + Math.abs(dx) + Math.abs(dy);
        theta += dx * 0.011;
        thetaVel = dx * 0.011;
        if (dy && zoom > 1.01) {                // vertical drag pans when zoomed in
          const rect = view.getBoundingClientRect();
          applyPan(panY + dy * (2 * HALF / zoom) / rect.height);
        }
        return;
      }
      if (drag.type === 'bend') {
        const rect = view.getBoundingClientRect();
        const k = BUFW / rect.width;
        const dx = (e.clientX - drag.lastX) * k;
        const dy = (e.clientY - drag.lastY) * k;
        drag.lastX = e.clientX; drag.lastY = e.clientY;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        const seg = tree.segs.get(drag.segId);
        if (!seg || !seg.wired) return;
        const base = projectTreePt(seg.start);
        const tip = projectTreePt(seg.end);
        const gx = tip.x - base.x, gy = tip.y - base.y;
        const g2 = gx * gx + gy * gy;
        let axis, ang;
        if (g2 < 120) {   // branch foreshortened (points at the camera): pitch it instead
          axis = pitchAxisLocal();
          ang = clamp(dy * 0.012, -0.12, 0.12);
        } else {
          axis = bendAxisLocal();
          ang = clamp((gx * dy - gy * dx) / Math.max(400, g2), -0.12, 0.12);
        }
        // micro-bends give live feedback; the drag's NET rotation is what gets
        // logged (and snapped to) when the drag ends
        if (ang && tree.bend(drag.segId, axis, ang)) {
          drag.q = B.Vec.qMul(B.Vec.qFromAxisAngle(axis, ang), drag.q);
        }
      }
    });

    const endDrag = (e) => {
      touches.delete(e.pointerId);
      if (!drag) return;
      if (drag.type === 'pinch') { if (touches.size < 2) drag = null; return; }
      if (drag.type === 'maybePrune' && drag.hit) doCut(drag.hit.segId);
      else if (drag.type === 'maybeTrim' && drag.hit) {
        if (drag.hit.kind === 'leaf') doTrim(drag.hit.segId);
        else toast('🍃 aim for the blossom pads');
      }
      else if (drag.type === 'maybeTap') {
        if (drag.action === 'water') doWater();
        else {
          // mist right away — and offer a lone 🍃 button on that pad for 5s
          doMist();
          const id = drag.segId;
          const seg = id !== undefined ? tree.segs.get(id) : null;
          // always OFFER the pinch — doTrim explains if the tree/pad can't take it
          if (seg && !seg.children.length && !seg.cut &&
              tree.leafRadius(seg) >= 1.6 && !previewTree) {
            openBranchMenu(id, e.clientX, e.clientY, 'pad');
          }
        }
      }
      else if (drag.type === 'maybeBranch') openBranchMenu(drag.segId, e.clientX, e.clientY);
      else if (drag.type === 'rake') {
        if (drag.moved < 3 && drag.last) drawDimple(drag.last);
        save();
      }
      else if (drag.type === 'rotate' && (drag.moved || 0) < 6 && drag.tap === 'pebble' && mode === 'view') doFeed();
      else if (drag.type === 'bend' && drag.moved < 3) {
        finishBend(drag, false);
        if (drag.fromView) openBranchMenu(drag.segId, e.clientX, e.clientY);   // tap on coil → menu (unwire lives there)
        else toast('➰ drag the branch to bend it');
      }
      else if (drag.type === 'bend') {
        finishBend(drag, true);
        if (mode === 'wire') {                 // bend finished: the tool puts itself away
          setMode('view');
          toast('➰ shaped — grab the copper coil anytime to re-bend');
        }
      }
      drag = null;
    };
    view.addEventListener('pointerup', endDrag);
    view.addEventListener('pointercancel', (e) => { touches.delete(e.pointerId); drag = null; });

    view.addEventListener('dblclick', (e) => {
      if (mode !== 'wire') return;
      const hit = pickAt(e.clientX, e.clientY);
      if (hit) {
        const seg = tree.segs.get(hit.segId);
        if (seg && seg.wired) requestUnwire(hit.segId);
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      lastInteract = performance.now();
      if (e.key === 'ArrowLeft') { thetaVel = 0; theta -= 0.09; }
      else if (e.key === 'ArrowRight') { thetaVel = 0; theta += 0.09; }
      else if (e.key === 'ArrowUp') applyPan(panY + 3);
      else if (e.key === 'ArrowDown') applyPan(panY - 3);
      else if (e.key === '+' || e.key === '=') applyZoom(zoom * 1.15);
      else if (e.key === '-' || e.key === '_') applyZoom(zoom / 1.15);
      else if (e.key === 'Escape') {
        if (branchMenuSeg !== null) closeBranchMenu();
        else if (futureBarOpen) toggleFuture();
        else setMode('view');
      }
    });

    window.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
    window.addEventListener('pagehide', save);

    // A demo tree isn't saved — warn before it's lost, but only once it has some
    // progress worth keeping (any care action logged). Minted trees persist, so no warning.
    window.addEventListener('beforeunload', (e) => {
      if (!VIEWER && !isMinted() && dna && dna.e && dna.e.length > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  // ---------- the action log
  // Every state-changing user action goes through SIM.applyAction and, if the
  // sim accepted it, is appended here. The envelope (seed + this log) is the
  // bonsai — saves, undo and DNA sharing all replay it.
  function appendEvent(ev) {
    dna.e.push(ev);
    // On a follower, the leader owns the shared log — forward the action so it lands
    // there exactly once. Our local push is optimistic and will be replaced when the
    // leader's authoritative save comes back (applyRemoteSave). Time ops (O/L) are
    // never forwarded — only the leader generates those.
    if (!isLeader && !applyingRemote && ev && ev[0] !== 'O' && ev[0] !== 'L') {
      syncPost({ type: 'action', from: CLIENT_ID, ev });
    }
  }

  // Rebuild the sim state from the envelope (after an undo edited the log).
  function rebuildFromLog() {
    dna.t = S.simT;
    S = SIM.replay(dna);
    tree = S.tree; res = S.res;
    springAnim = null;   // the tree it was swinging is gone; replay already has the final pose
    statsCache = tree.stats();
    previewCache.clear();
    treeKey = '';
    updateAll();
  }

  function doWire(segId) {
    if (guardViewer()) return false;
    const ev = ['w', S.simT, segId];
    if (!SIM.applyAction(S, ev).ok) return false;
    appendEvent(ev);
    save();
    return true;
  }

  // ---------- wire removal + spring-back
  // Removing an unset wire is a decision: warn first (the wire needs time on
  // the branch for the shape to hold), remove only on confirmation.
  function requestUnwire(id) {
    const seg = tree.segs.get(id);
    if (!seg || !seg.wired) return;
    const Vv = B.Vec;
    const need = tree.wireSetHours(seg);
    const setFrac = clamp(seg.wireAge / need, 0, 1);
    let springAngle = 0;
    if (seg.dir0) {
      const dot = clamp(Vv.dot(Vv.norm(seg.dir), Vv.norm(seg.dir0)), -1, 1);
      springAngle = Math.acos(dot) * (1 - setFrac);
    }
    if (springAngle > 0.02) {
      const daysLeft = Math.max(1, Math.ceil((need - seg.wireAge) / 24));
      toast(`⚠ not set yet — it needs the wire ~${daysLeft} more day${daysLeft > 1 ? 's' : ''} or the branch will spring back`, {
        ms: 7000,
        action: { label: 'REMOVE', fn: () => doUnwire(id) },
      });
    } else {
      doUnwire(id);
    }
  }

  // Unwire a branch. If the wire wasn't on long enough for the branch to
  // stabilize (1–3 months by thickness), it springs back toward its pre-wiring
  // direction — proportionally to how unset it still is (canonical, instant).
  function doUnwire(id) {
    if (guardViewer()) return;
    const seg = tree.segs.get(id);
    // Capture the bent pose + spring axis/angle BEFORE the sim rotates the model,
    // so we can replay that rotation as a cosmetic swing-back (see startSpringAnim).
    let startDirs = null, springAxis = null, springTotal = 0;
    if (seg && seg.dir0 && !previewTree) {
      const V = B.Vec;
      startDirs = new Map();
      const walk = (s) => { startDirs.set(s.id, s.dir.slice()); for (const c of s.children) walk(c); };
      walk(seg);
      const axis = V.cross(seg.dir, seg.dir0);
      const dot = clamp(V.dot(V.norm(seg.dir), V.norm(seg.dir0)), -1, 1);
      const setFrac = clamp(seg.wireAge / tree.wireSetHours(seg), 0, 1);
      springTotal = Math.acos(dot) * (1 - setFrac);
      if (V.len(axis) > 1e-4) springAxis = V.norm(axis);
    }
    const ev = ['u', S.simT, id];
    const out = SIM.applyAction(S, ev);
    if (!out.ok) return;
    appendEvent(ev);
    treeKey = '';
    if (out.sprung && springAxis && springTotal > 0.02) {
      startSpringAnim(id, springAxis, springTotal, startDirs);   // swing back visually
    }
    toast(out.sprung
      ? (out.setFrac > 0.5 ? '➰ wire off — mostly set, it springs back a little' : '➰ wire off — not set yet, the branch springs back')
      : '➰ wire removed');
    save();
  }

  // ---------- bend drags → one logged net rotation
  function beginBend(segId, e, fromView) {
    const dirs = new Map();
    const seg = tree.segs.get(segId);
    if (seg) {
      const walk = (s) => { dirs.set(s.id, s.dir.slice()); for (const c of s.children) walk(c); };
      walk(seg);
    }
    return {
      type: 'bend', segId, lastX: e.clientX, lastY: e.clientY, moved: 0,
      fromView: !!fromView, q: [0, 0, 0, 1], dirs,
    };
  }

  // End of a drag: rewind the micro-bends, then apply (and log) the single
  // quantized net rotation — so live play lands exactly where a replay will.
  function finishBend(drag, commit) {
    let changed = false;
    for (const [id, dir] of drag.dirs) {
      const s = tree.segs.get(id);
      if (s) { s.dir = dir; changed = true; }
    }
    if (changed) { tree.recompute(); tree.rev++; treeKey = ''; }
    if (!commit) return;
    const net = B.Vec.qToAxisAngle(drag.q);
    if (net.ang < 1e-3) return;
    const q = SIM.quantBend(net.axis, net.ang);
    const ev = ['B', S.simT, drag.segId, q.ax, q.ay, q.az, q.a];
    if (SIM.applyAction(S, ev).ok) {
      appendEvent(ev);
      save();
    }
  }

  // ---------- branch context menu (tap a branch → ✂️/➰; tap a pad → lone 🍃)
  let branchMenuSeg = null, branchMenuTimer = null;
  const branchMenuEl = $('#branch-menu');

  function openBranchMenu(segId, clientX, clientY, kind) {
    const seg = tree.segs.get(segId);
    if (!seg || previewTree || VIEWER) return;
    if (guardDead()) return;
    clearTimeout(branchMenuTimer);
    branchMenuTimer = null;
    branchMenuSeg = segId;
    const pad = kind === 'pad';
    $('#bm-cut').classList.toggle('hidden', pad);
    $('#bm-wire').classList.toggle('hidden', pad);
    $('#bm-trim').classList.toggle('hidden', !pad);
    if (!pad) {
      $('#bm-wire').textContent = seg.wired ? '➰ UNWIRE' : '➰ WIRE';
      $('#bm-wire').classList.toggle('unwire', !!seg.wired);
    }
    const stack = $('#canvas-stack').getBoundingClientRect();
    branchMenuEl.classList.remove('hidden');
    const mw = branchMenuEl.offsetWidth || 130, mh = branchMenuEl.offsetHeight || 34;
    if (pad && canopy) {
      // the TRIM button lives in one predictable spot: right above the tree
      const a = projectLocalPt(canopy.x, canopy.maxY + 3, canopy.z);
      const r = view.getBoundingClientRect();
      const ax = (r.left - stack.left) + (a.x / BUFW) * r.width;
      const ay = (r.top - stack.top) + (a.y / BUFH) * r.height;
      branchMenuEl.style.left = clamp(ax - mw / 2, 4, stack.width - mw - 4) + 'px';
      branchMenuEl.style.top = clamp(ay - mh - 6, 4, stack.height - mh - 4) + 'px';
    } else {
      // branch ✂️/➰ menu: near the tap, with daylight from the cursor
      branchMenuEl.style.left = clamp(clientX - stack.left - mw / 2 + 18, 4, stack.width - mw - 4) + 'px';
      branchMenuEl.style.top = clamp(clientY - stack.top - mh - 28, 4, stack.height - mh - 4) + 'px';
    }
    if (pad) branchMenuTimer = setTimeout(closeBranchMenu, 5000);   // fades back to normal
  }
  function closeBranchMenu() {
    clearTimeout(branchMenuTimer);
    branchMenuTimer = null;
    branchMenuSeg = null;
    branchMenuEl.classList.add('hidden');
  }

  // ---------- care actions
  function doCut(segId) {
    if (guardViewer() || guardPreview() || guardDead()) return;
    const ev = ['C', S.simT, segId];
    const r = SIM.applyAction(S, ev);
    if (!r.ok) {
      if (r.reason === 'trunk') toast("🚫 that's the trunk base — too thick to cut");
      else if (r.reason === 'thick') toast('🚫 too thick for scissors — prune the thinner branches');
      return;
    }
    appendEvent(ev);
    const evIndex = dna.e.length - 1;
    debrisFX(projectTreePt(r.at));
    toast(`✂️ snip! it will bud back denser (−${r.removed})`, {
      ms: 9000,
      action: {
        label: 'UNDO',
        // undo = remove the cut from the log and replay — the log IS the tree
        fn: () => {
          if (dna.e[evIndex] !== ev) return;
          dna.e.splice(evIndex, 1);
          rebuildFromLog();
          revalidateAtts();
          toast('🌱 phew — branch restored');
          save();
        },
      },
    });
    save();
  }

  // ---------- future preview (🔮)
  function setPreview(years) {
    if (!years) {
      previewTree = null; previewYears = 0;
    } else {
      const key = tree.rev + '|' + years;
      if (!previewCache.has(key)) {
        previewCache.set(key, B.growFuture(tree.serialize(), years));
        if (previewCache.size > 14) previewCache.delete(previewCache.keys().next().value);
      }
      previewTree = previewCache.get(key);
      previewYears = years;
    }
    for (const b of document.querySelectorAll('#future-bar button')) {
      b.classList.toggle('active', +b.dataset.years === previewYears);
    }
    $('#btn-future').classList.toggle('active', !!previewTree);
    view.dataset.hover = '';
    closeBranchMenu();
    treeKey = '';                 // force a resync next frame
    updateAll();
  }

  function toggleFuture() {
    if (!futureBarOpen && guardDead()) return;   // no visions for a departed tree
    futureBarOpen = !futureBarOpen;
    $('#future-bar').classList.toggle('hidden', !futureBarOpen);
    if (futureBarOpen) {
      setMode('view');
      setPreview(2);
      toast('🔮 gazing ahead — assuming years of loving care…', { ms: 4200 });
    } else {
      setPreview(0);
    }
  }

  function guardPreview() {
    if (!previewTree) return false;
    toast('🔮 just a vision — press NOW to tend the real tree');
    return true;
  }

  function guardDead() {
    if (!res.dead) return false;
    if (VIEWER) return true;
    toast('🪦 the tree has passed away — plant a new one?', { ms: 9000, action: { label: '🌱 NEW TREE', fn: freshTree } });
    return true;
  }

  function guardViewer() {
    if (!VIEWER) return false;
    toast('🧬 a shared bonsai — look, but do not touch');
    return true;
  }

  function doWater() {
    if (guardViewer() || guardPreview() || guardDead()) return;
    const ev = ['W', S.simT];
    const out = SIM.applyAction(S, ev);
    if (!out.ok) return;
    appendEvent(ev);
    toast(out.soggy ? '🫧 soggy! the soil is already drenched…'
      : pick(['💧 a good soak', '💧 glug glug…', '💧 the roots drink deep']));
    waterFX(); updateAll(); save();
  }

  function doMist(quiet) {
    if (guardViewer() || guardPreview() || guardDead()) return;
    const ev = ['M', S.simT];
    if (!SIM.applyAction(S, ev).ok) return;
    appendEvent(ev);
    if (!quiet) toast(pick(['🌫 psssst — the leaves glisten', '🌫 a fine morning mist', '🌫 mountain air vibes']));
    mistFX(); updateAll(); save();
  }

  function doFeed() {
    if (guardViewer() || guardPreview() || guardDead()) return;
    const ev = ['F', S.simT];
    const out = SIM.applyAction(S, ev);
    if (!out.ok) return;
    appendEvent(ev);
    toast(out.burned ? '🔥 fertilizer burn! go easy for a while…'
      : pick(['🧪 nom nom — growth boost!', '🧪 pellets sprinkled on the soil']));
    for (let i = 0; i < 6; i++) {
      const p = B.Voxels.pebbleSpot(() => fxRng.next());
      decals.push({ u: p.u, v: p.v, type: 'pellet', ts: Date.now() });
    }
    decals = decals.slice(-48);
    decalsDirty = true;
    feedFX(); updateAll(); save();
  }

  // Pinch a blossom pad: it regrows finer, ramifies denser, and the opened
  // crown catches more light (a temporary growth boost). Costs a little vigor.
  function doTrim(segId) {
    if (guardViewer() || guardPreview() || guardDead()) return;
    const ev = ['P', S.simT, segId];
    const r = SIM.applyAction(S, ev);
    if (!r.ok) {
      if (r.reason === 'stressed') toast('🍃 the tree is too stressed to trim right now');
      else if (r.reason === 'small') toast('🍃 that pad is already tender');
      return;
    }
    appendEvent(ev);
    const p = projectTreePt(r.at);
    for (let i = 0; i < 7; i++) {
      addPart({
        kind: 'petal', x: p.x + (fxRng.next() - 0.5) * 6, y: p.y + (fxRng.next() - 0.5) * 4,
        vx: (fxRng.next() - 0.5) * 12, vy: 14 + fxRng.next() * 10, ttl: 3, t: 0,
        c: pick([PAL.leaf[1], PAL.leaf[2], '#9ec98b']), w: 2, h: 1, drift: fxRng.next() * 6.3,
      });
    }
    toast(pick(['🍃 snip — finer shoots will come', '🍃 pinched — light reaches the crown', '🍃 trimmed — denser pads ahead']));
    updateAll(); save();
  }

  function setMode(m) {
    if (VIEWER && m !== 'view') { guardViewer(); return; }
    if (previewTree && m !== 'view') { guardPreview(); return; }
    if (res.dead && m !== 'view') { guardDead(); return; }
    mode = (mode === m) ? 'view' : m;
    view.dataset.mode = mode;
    view.dataset.hover = '';
    closeBranchMenu();
    syncDock();
    updateStatus();
  }

  function doTimeLapse() {
    if (guardViewer() || guardPreview()) return;
    appendEvent(['L', S.simT, 3600]);
    renderStepFx(SIM.advance(S, 3600, false), true);
    toast('⏩ one hour passes…');
    statsCache = tree.stats();
    updateAll(); save();
  }

  function freshTree() {
    if (guardViewer()) return;
    if (futureBarOpen) toggleFuture();
    previewCache.clear();
    drawSandBase();
    drawStarterPattern();
    sandTexture.needsUpdate = true;
    dna = {
      v: 2,
      seed: (Math.random() * 0xffffffff) >>> 0,
      g: Date.now(),
      s: B.Weather.st.lat !== null && B.Weather.st.lat < 0 ? 1 : 0,
      t: 0,
      e: [],
    };
    S = SIM.replay(dna);
    tree = S.tree; res = S.res;
    pendingSec = 0;
    nft = null;   // a new tree is a new (unminted) identity
    atts = [];    // …with no notarized history yet
    statsCache = tree.stats();
    decals = []; decalsDirty = true; treeKey = '';
    toast('🌱 a brand-new bonsai arrives!');
    updateAll(); save();
  }

  // ---------- simulation (the deterministic core lives in js/sim.js — game.js
  // only schedules wall-clock time into fixed quanta and renders the outcomes)
  function renderStepFx(out, fx) {
    if (fx) {
      for (const e of out.grow) sparkleFX(projectTreePt(e.at));
      for (const r of out.newlySet) {
        sparkleFX(projectTreePt(r.at));
        toast('✅ the branch has set — remove the wire whenever you like');
      }
    }
    if (out.startedDying && !res.dead) toast('🥀 the tree is fading — it needs water and care, fast!');
    if (out.died) {
      treeKey = '';
      closeBranchMenu();
      if (mode !== 'view') setMode('view');
      toast('🪦 the little tree has withered away…', { ms: 14000, action: { label: '🌱 NEW TREE', fn: freshTree } });
      save();
    }
  }

  function runPending(fx) {
    while (pendingSec >= SIM.STEP_S) {
      pendingSec -= SIM.STEP_S;
      renderStepFx(SIM.step(S, false), fx);
    }
  }

  // A long absence (machine slept, tab frozen, app closed): capped, half-pace
  // offline catch-up in whole quanta; the remainder joins the live accumulator.
  function offlineAdvance(rawSec) {
    const adv = Math.min(rawSec, SIM.OFFLINE_CAP_S);
    const offS = Math.floor(adv / SIM.STEP_S) * SIM.STEP_S;
    if (offS > 0) {
      appendEvent(['O', S.simT, offS]);
      renderStepFx(SIM.advance(S, offS, true), false);
    }
    pendingSec += adv - offS;
    runPending(false);
    return offS;
  }

  function tick() {
    const now = Date.now();
    // Followers do not advance sim-time — the leader owns the monotonic log and
    // broadcasts growth to us. We just keep rendering the mirrored tree.
    if (!isLeader) { lastTick = now; lastEnv = B.Weather.env(new Date()); return; }
    const dtSec = clamp((now - lastTick) / 1000, 0, 72 * 3600);
    lastTick = now;
    if (dtSec > 3600) offlineAdvance(dtSec);
    else {
      pendingSec += dtSec;
      // never step mid-bend: live micro-bends are provisional, and growth off a
      // provisionally-bent branch would diverge from what the log replays
      if (!drag || drag.type !== 'bend') runPending(true);
    }
    lastEnv = B.Weather.env(new Date());
    if (lastEnv.raining && sandCtx) {           // rain slowly smooths the raked sand
      sandFade += dtSec / 3600;
      if (sandFade > 0.03) {
        sandFade = 0;
        sandCtx.globalAlpha = 0.05;
        sandCtx.fillStyle = '#e3dabe';
        sandCtx.fillRect(0, 0, SAND_TEX, SAND_TEX);
        sandCtx.globalAlpha = 1;
        sandTexture.needsUpdate = true;
      }
    }
    statsCache = tree.stats();
    updateAll();
    maybeAttest();
    if (now - lastSaveAt > 45000) save();
  }

  // ---------- persistence
  // v2: the envelope (seed + action log) IS the tree — no geometry is stored.
  // Everything else here is cosmetic or non-canonical local scheduling state.
  function save() {
    if (VIEWER) return;   // a shared bonsai never touches this browser's save
    if (!isMinted()) return;   // demo trees live only in memory — mint to keep
    // Followers never write the shared log — the leader owns it (their edits were
    // forwarded via appendEvent). They may still update cosmetics only in memory.
    if (!isLeader && !applyingRemote) return;
    lastSaveAt = Date.now();
    dna.t = S.simT;
    store.set(KEY, JSON.stringify({
      v: 2, ts: Date.now(), pendingSec: Math.floor(pendingSec),
      dna,
      theta: Math.round(theta * 1000) / 1000, zoom: Math.round(zoom * 100) / 100,
      pan: Math.round(panY * 100) / 100, pix2: WALLPAPER ? savedPix : resIdx,
      decals: decals.slice(-48),
      sand: sandCanvas ? sandCanvas.toDataURL() : undefined,
      wx: B.Weather.serialize(),
      nft: nft || undefined,
      atts: atts.length ? atts : undefined,
      bg: bg !== 'classic' ? bg : undefined,
    }));
    if (!applyingRemote) syncPost({ type: 'saved', from: CLIENT_ID });   // tell peers to re-read
  }

  // ---------- same-origin live sync
  // Browser tab and desktop wallpaper (same origin) share the one KEY. Only the
  // LEADER advances sim-time and writes the log; FOLLOWERS mirror it and forward the
  // user's care actions to the leader, so the monotonic event log stays single-writer.
  function syncPost(msg) { if (syncCh) { try { syncCh.postMessage(msg); } catch (e) {} } }

  // Re-read the shared save and rebuild the live tree from it (a peer changed it).
  function applyRemoteSave() {
    let data = null;
    try { data = JSON.parse(store.get(KEY) || 'null'); } catch (e) { return; }
    if (!data || !data.dna || data.dna.v !== 2) return;
    applyingRemote = true;
    try {
      dna = data.dna;
      rebuildFromLog();                 // S = SIM.replay(dna) + updateAll()
      pendingSec = typeof data.pendingSec === 'number' ? data.pendingSec : 0;
      nft = data.nft || nft;
      atts = Array.isArray(data.atts) ? data.atts : atts;
      if (typeof data.bg === 'string' || data.bg === undefined) setBackground(data.bg || 'classic', false);
    } finally { applyingRemote = false; }
  }

  // Presence-based leadership: every context defaults to leader and pings peers. When
  // two are live, the one with the lexicographically-smaller CLIENT_ID leads; the other
  // steps down. A peer that stops pinging (closed) is forgotten, so leadership recovers
  // automatically. No localStorage record → no stale-leader hazard across reloads.
  const peers = new Map();   // id → last-seen ms
  function refreshLeadership() {
    const now = Date.now();
    for (const [id, ts] of peers) if (now - ts > 7000) peers.delete(id);
    sawPeer = peers.size > 0;
    let minId = CLIENT_ID;
    for (const id of peers.keys()) if (id < minId) minId = id;
    const nowLeader = (minId === CLIENT_ID);
    if (nowLeader && !isLeader) lastTick = Date.now();   // resuming time: don't fold the gap
    isLeader = nowLeader;
  }

  function initSync() {
    if (VIEWER || typeof BroadcastChannel !== 'function') return;
    try { syncCh = new BroadcastChannel('pixel-bonsai'); } catch (e) { syncCh = null; return; }
    syncCh.onmessage = (e) => {
      const m = e.data || {};
      if (m.from === CLIENT_ID) return;
      if (m.type === 'ping' || m.type === 'hello') {
        peers.set(m.from, Date.now());
        if (m.type === 'hello') syncPost({ type: 'ping', from: CLIENT_ID });   // announce back
        refreshLeadership();
      } else if (m.type === 'saved') { peers.set(m.from, Date.now()); applyRemoteSave(); }
      else if (m.type === 'action' && isLeader) { applyForwardedAction(m.ev); }
    };
    // storage events fire in OTHER same-origin contexts even without BroadcastChannel
    window.addEventListener('storage', (e) => {
      if (e.key === KEY) { sawPeer = true; applyRemoteSave(); }
    });
    syncPost({ type: 'hello', from: CLIENT_ID });
    setInterval(() => { syncPost({ type: 'ping', from: CLIENT_ID }); refreshLeadership(); }, 2500);
  }

  // The leader applies a care action forwarded from a follower, through the SAME
  // path a local action uses, so it is logged and saved exactly once.
  function applyForwardedAction(ev) {
    if (!ev || guardViewer() || res.dead) return;
    const out = SIM.applyAction(S, ev);
    if (!out || !out.ok) return;
    appendEvent(ev);
    statsCache = tree.stats();
    updateAll();
    save();   // broadcasts {saved} → the follower mirrors it
  }

  // ---------- timestamp notary (opportunistic — the game never blocks on it)
  // An attestation proves this exact history prefix existed no later than its
  // server timestamp. Once a day, silently; failures are invisible.
  function maybeAttest() {
    if (VIEWER || attInFlight || !/^https?:$/.test(location.protocol)) return;
    if (dna.e.length === 0 || S.simT < 86400) return;   // outside the hemisphere re-mint window
    const now = Date.now();
    if (atts.length && now - atts[atts.length - 1].ts < 864e5) return;
    if (now - attLastTry < 600e3) return;
    attLastTry = now;
    attInFlight = true;
    dna.t = S.simT;
    B.Notary.attest(dna)
      .then((a) => {
        if (!a) return;
        atts.push(a);
        // cap storage; the FIRST attestation carries the whole age claim
        while (atts.length > 32) atts.splice(1 + ((atts.length / 2) | 0), 1);
        save();
      })
      .catch(() => {})
      .finally(() => { attInFlight = false; });
  }

  // After an undo rewrote the log, attestations covering the spliced region
  // no longer match any prefix — quietly drop them (older ones survive).
  function revalidateAtts() {
    if (!atts.length) return;
    dna.t = S.simT;
    Promise.all(atts.map(a => B.Notary.verify(dna, a)))
      .then((oks) => {
        const kept = atts.filter((_, i) => oks[i]);
        if (kept.length !== atts.length) { atts = kept; save(); }
      })
      .catch(() => {});
  }

  // A v1 save carries stored geometry — wrap it as a genesis snapshot so the
  // envelope stays the single source of truth from here on.
  function migrateV1(data) {
    return {
      v: 2,
      seed: 0,
      g: data.ts || Date.now(),
      s: data.wx && typeof data.wx.lat === 'number' && data.wx.lat < 0 ? 1 : 0,
      t: 0,
      e: [],
      snap: {
        tree: data.tree,
        res: data.res || undefined,
        gp: data.gp || 0,
        burnH: typeof data.burnH === 'number' ? data.burnH
          : data.burnUntil ? Math.max(0, (data.burnUntil - Date.now()) / 3600e3) : 0,
        soggy: data.soggy || 0,
        trim: data.trim || 0,
        dying: data.dying || 0,
      },
    };
  }

  // ---------- FX overlay (screen-space pixel particles)
  const fxCtx = fxCanvas.getContext('2d');
  const parts = [];
  let canAnim = null, glintUntil = 0;

  function addPart(p) { if (parts.length < 420) parts.push(p); }

  const ease = (k) => 1 - Math.pow(1 - clamp(k, 0, 1), 3);

  // tin watering can, origin at the spout mouth, pouring to the left
  const CAN_RECTS = [
    [8, -7, 11, 1, '#22303f'],   // rim
    [8, -6, 11, 9, '#9fb0c0'],   // body
    [8, -6, 11, 1, '#c4d2dd'],   // top highlight
    [8, 1, 11, 2, '#6b7a8a'],    // bottom shade
    [1, -1, 3, 2, '#9fb0c0'],    // spout pipe
    [3, -3, 3, 2, '#9fb0c0'],
    [5, -5, 3, 3, '#9fb0c0'],
    [-2, -2, 3, 4, '#6b7a8a'],   // sprinkler head
    [10, -11, 8, 1, '#6b7a8a'],  // handle
    [9, -10, 1, 3, '#6b7a8a'],
    [18, -10, 1, 3, '#6b7a8a'],
  ];
  function drawSprite(ctx, x, y, rects, k) {
    k = k || 1;
    for (const [dx, dy, w, h, c] of rects) {
      ctx.fillStyle = c;
      ctx.fillRect(Math.round(x + dx * k), Math.round(y + dy * k), Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
    }
  }

  function canopyScreen() {
    if (!canopy) return { x: BUFW / 2, y: BUFH / 2 - 20, w: 40, h: 30 };
    const c = projectLocalPt(canopy.x, canopy.y, canopy.z);
    const ppu = BUFH / (2 * HALF);
    return {
      x: c.x, y: c.y,
      w: Math.max(24, (canopy.maxX - canopy.minX) * ppu * zoom),
      h: Math.max(16, (canopy.maxY - canopy.minY) * ppu * zoom),
    };
  }
  function floorScreenY() {
    return projectLocalPt(0, GEO.potTopY + 1, 0).y;
  }

  function waterFX() {
    // a small watering can pours briefly; re-watering mid-pour extends it
    if (canAnim && canAnim.t > 0.25 && canAnim.t < 0.95) canAnim.t = 0.35;
    else canAnim = { t: 0 };
    glintUntil = Date.now() + 40000;   // wet pebbles sparkle for a while
  }
  function mistFX() {
    const c = canopyScreen();
    for (let i = 0; i < 10; i++) {
      addPart({
        kind: 'puff', x: c.x + (fxRng.next() - 0.5) * (c.w + 16), y: c.y + (fxRng.next() - 0.5) * c.h,
        vx: (fxRng.next() - 0.5) * 6, vy: -3 - fxRng.next() * 4, ttl: 1.4, t: 0, c: '#ffffff', r: 2 + fxRng.next() * 3,
      });
    }
  }
  function feedFX() {
    const fy = floorScreenY();
    for (let i = 0; i < 7; i++) {
      addPart({
        kind: 'pellet', x: BUFW / 2 + 30 + fxRng.next() * 10, y: fy - 55 - fxRng.next() * 10,
        vx: -26 - fxRng.next() * 22, vy: -12 + fxRng.next() * 8, g: 150, floor: fy - 2 + fxRng.next() * 4,
        ttl: 3, t: 0, c: PAL.decalPellet, w: 2, h: 2,
      });
    }
  }
  function sparkleFX(p) {
    for (let i = 0; i < 4; i++) {
      addPart({
        kind: 'spark', x: p.x + (fxRng.next() - 0.5) * 4, y: p.y + (fxRng.next() - 0.5) * 4,
        vx: (fxRng.next() - 0.5) * 12, vy: -8 - fxRng.next() * 8, ttl: 0.55, t: 0,
        c: pick(['#ffffff', '#f7c9d6', '#f1a7bf']), w: 1, h: 1,
      });
    }
  }
  function debrisFX(p) {
    const fy = floorScreenY();
    for (let i = 0; i < 10; i++) {
      addPart({
        kind: 'pellet', x: p.x, y: p.y,
        vx: (fxRng.next() - 0.5) * 60, vy: -30 - fxRng.next() * 40, g: 220, floor: fy + fxRng.next() * 3,
        ttl: 2.4, t: 0, c: pick([PAL.trunk[1], PAL.trunk[2], PAL.leaf[1], PAL.leaf[2]]), w: 2, h: 2,
      });
    }
  }

  function fxFrame(dt, tms) {
    fxCtx.clearRect(0, 0, BUFW, BUFH);
    const env = lastEnv;
    const fy = floorScreenY();

    if (env && env.raining) {
      const n = env.kind === 'storm' ? 3 : 2;
      for (let i = 0; i < n; i++) {
        addPart({ kind: 'rain', x: fxRng.next() * BUFW, y: -4, vx: -env.wind * 0.25, vy: 150 + fxRng.next() * 60, ttl: 2, t: 0, c: '#8fb4d9', w: 1, h: 3, floor: fy + (fxRng.next() - 0.5) * 8 });
      }
    }
    if (env && env.snowing && fxRng.next() < 0.5) {
      addPart({ kind: 'snow', x: fxRng.next() * BUFW, y: -3, vx: 0, vy: 14 + fxRng.next() * 8, ttl: 14, t: 0, c: '#ffffff', w: 2, h: 2, drift: fxRng.next() * 6.3 });
    }
    if (env && res.health > 60 && canopy && lastTier !== 'bare') {
      const shedRate = lastTier === 'pink' && env.bloom ? 0.02
        : lastTier === 'autumn' ? 0.016
        : 0.005;
      if (fxRng.next() < shedRate + env.wind * 0.0006) {
        const c = canopyScreen();
        const cols = lastTier === 'autumn' ? [PAL.leafAutumn[1], PAL.leafAutumn[2]]
          : lastTier === 'green' ? [PAL.leafGreen[1], PAL.leafGreen[2]]
          : [PAL.leaf[1], PAL.leaf[2]];
        addPart({
          kind: 'petal', x: c.x + (fxRng.next() - 0.5) * c.w, y: c.y + (fxRng.next() - 0.5) * c.h,
          vx: env.wind * 0.15 * (fxRng.next() < 0.3 ? -1 : 1), vy: 10 + fxRng.next() * 8,
          ttl: 8, t: 0, c: pick(cols), w: 2, h: 1, drift: fxRng.next() * 6.3,
        });
      }
    }

    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.t += dt;
      if (p.t > p.ttl) { parts.splice(i, 1); continue; }
      if (p.g) p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.drift !== undefined) p.x += Math.sin(tms / 400 + p.drift) * 14 * dt;

      if (p.kind === 'rain' || p.kind === 'drop') {
        const limit = p.floor === undefined ? fy : p.floor;
        if (p.y >= limit) {
          parts.splice(i, 1);
          if (fxRng.next() < 0.7) addPart({ kind: 'spark', x: p.x, y: limit - 1, vx: (fxRng.next() - 0.5) * 34, vy: -22 - fxRng.next() * 16, g: 200, ttl: 0.3, t: 0, c: p.c, w: 1, h: 1 });
          if (fxRng.next() < 0.22) addPart({ kind: 'ring', x: p.x, y: limit, vx: 0, vy: 0, ttl: 0.5, t: 0, c: '#8fc4e8', w: 1, h: 1 });
          continue;
        }
      }
      if (p.kind === 'pellet' && p.y >= p.floor) { p.y = p.floor; p.vx *= 0.6; p.vy = 0; p.g = 0; }
      if (p.kind === 'petal' && p.y >= fy) {
        parts.splice(i, 1);
        if (fxRng.next() < 0.35) {
          const spot = B.Voxels.pebbleSpot(() => fxRng.next());
          decals.push({ u: spot.u, v: spot.v, type: 'petal', ts: Date.now(), c: p.c });
          decals = decals.slice(-48);
          decalsDirty = true;
        }
        continue;
      }

      if (p.kind === 'puff') {
        const k = p.t / p.ttl;
        fxCtx.globalAlpha = 0.42 * (1 - k);
        const r = Math.round(p.r + k * 5);
        fxCtx.fillStyle = p.c;
        fxCtx.fillRect(Math.round(p.x - r), Math.round(p.y - r / 2), r * 2, r);
        fxCtx.globalAlpha = 1;
      } else if (p.kind === 'ring') {   // splash ripple on the soil
        const k = p.t / p.ttl;
        fxCtx.globalAlpha = 0.7 * (1 - k);
        fxCtx.fillStyle = p.c;
        const r = 1.5 + k * 5;
        for (let a = 0; a < 8; a++) {
          const ang = a * Math.PI / 4;
          fxCtx.fillRect(Math.round(p.x + Math.cos(ang) * r), Math.round(p.y + Math.sin(ang) * r * 0.35), 1, 1);
        }
        fxCtx.globalAlpha = 1;
      } else if (p.kind === 'spark') {
        if ((tms / 80 | 0) % 2 === 0) { fxCtx.fillStyle = p.c; fxCtx.fillRect(p.x | 0, p.y | 0, p.w, p.h); }
      } else {
        fxCtx.fillStyle = p.c;
        fxCtx.fillRect(p.x | 0, p.y | 0, p.w, p.h);
      }
    }

    // freshly watered soil glints for a while (world-anchored, spins with the pot)
    if (Date.now() < glintUntil && fxRng.next() < 0.07) {
      const spot = B.Voxels.pebbleSpot(() => fxRng.next());
      const g = projectLocalPt(spot.u, GEO.potTopY + 1.6, spot.v);
      if (g.x > 0 && g.x < BUFW) {
        addPart({ kind: 'spark', x: g.x, y: g.y, vx: 0, vy: 0, ttl: 0.45, t: 0, c: pick(['#cfe9f5', '#ffffff']), w: 1, h: 1 });
      }
    }

    // the small watering can: quick in, brief pour, quick out (feed-scale)
    if (canAnim) {
      canAnim.t += dt;
      const T = canAnim.t;
      const c = canopyScreen();
      const tx = clamp(c.x + c.w * 0.18, 24, BUFW - 18);
      const ty = Math.max(12, c.y - c.h / 2 - 8);
      let x;
      if (T < 0.25) x = BUFW + 14 - (BUFW + 14 - tx) * ease(T / 0.25);
      else if (T < 0.95) x = tx;
      else x = tx + (BUFW + 14 - tx) * ease((T - 0.95) / 0.3);
      const y = ty;
      if (T > 0.25 && T < 0.95) {
        for (let i = 0; i < 2; i++) {
          if (fxRng.next() < 0.6) {
            addPart({
              kind: 'drop', x: x - 1 + (fxRng.next() - 0.5) * 2, y: y + 1,
              vx: -10 - fxRng.next() * 14, vy: 8 + fxRng.next() * 16, g: 220,
              ttl: 2, t: 0, c: pick(['#5ea7d8', '#8fc4e8', '#cfe9f5']), w: 1, h: 2,
            });
          }
        }
        if (fxRng.next() < 0.3) {
          addPart({ kind: 'spark', x: x - 4 - fxRng.next() * 6, y: y + 2 + fxRng.next() * 4, vx: -6, vy: 8, ttl: 0.4, t: 0, c: '#cfe9f5', w: 1, h: 1 });
        }
      }
      drawSprite(fxCtx, x, y, CAN_RECTS, 0.65);
      if (T > 1.3) canAnim = null;
    }
  }

  // ---------- sky / day-night / backgrounds
  // The default living sky: a time-of-day color ramp, tinted by weather.
  const SKY_STOPS = [
    [0, 0x10141f], [5, 0x10141f], [6.5, 0xc9909a], [8, 0xf4f1ea],
    [17.5, 0xf4f1ea], [19, 0xf0cfa6], [20.5, 0x4a4a6e], [21.5, 0x10141f], [24, 0x10141f],
  ];
  // Selectable backgrounds. `ramp` (a SKY_STOPS-shaped array) or `flat` (a fixed hex);
  // `weather` gates the storm-gray blend; `stars` = 'auto' | 'always' | 'never'.
  const BACKGROUNDS = {
    classic:     { label: '🌤 Classic', ramp: SKY_STOPS, weather: true,  stars: 'auto' },
    'night-sky': { label: '🌌 Night sky', flat: 0x0b1020, weather: false, stars: 'always' },
    'sakura':    { label: '🌸 Sakura', flat: 0xf3d7e2, weather: false, stars: 'never' },
    'zen-mist':  { label: '🌫 Zen mist', flat: 0xd8dee4, weather: false, stars: 'never' },
    'dusk':      { label: '🌇 Dusk', flat: 0x40324f, weather: false, stars: 'auto' },
    'void':      { label: '⬛ Void', flat: 0x05070a, weather: false, stars: 'never' },
  };
  function bgDef() { return BACKGROUNDS[bg] || BACKGROUNDS.classic; }

  // Apply a background preset. `persist` writes+syncs it; false = just apply (boot/remote).
  function setBackground(key, persist) {
    if (!BACKGROUNDS[key]) key = 'classic';
    bg = key;
    document.querySelectorAll('#bg-picker .bg-swatch').forEach((el) => {
      el.classList.toggle('active', el.dataset.bg === key);
    });
    if (persist) save();
  }

  let cSky, cTmp, cGray, nightClass = false;

  function rampAt(ramp, h) {
    let i = 0;
    while (i < ramp.length - 1 && ramp[i + 1][0] < h) i++;
    const [h0, c0] = ramp[i], [h1, c1] = ramp[Math.min(i + 1, ramp.length - 1)];
    const t = h1 === h0 ? 0 : clamp((h - h0) / (h1 - h0), 0, 1);
    return cSky.setHex(c0).lerp(cTmp.setHex(c1), t);
  }

  function skyFrame(tms) {
    if (!cSky) { cSky = new THREE.Color(); cTmp = new THREE.Color(); cGray = new THREE.Color(); }
    const now = new Date();
    const h = now.getHours() + now.getMinutes() / 60;
    const def = bgDef();
    if (def.ramp) rampAt(def.ramp, h);
    else cSky.setHex(def.flat);

    const env = lastEnv;
    if (def.weather && env && env.ok) {
      const grayAmt = { clouds: 0.3, fog: 0.5, rain: 0.42, storm: 0.55, snow: 0.28 }[env.kind] || 0;
      if (grayAmt) cSky.lerp(cGray.setHex(env.night ? 0x171c26 : 0xb9bec6), grayAmt);
    }
    if (previewTree) cSky.lerp(cGray.setHex(0xd9c8ec), 0.28);   // dreamy tint for visions
    renderer.setClearColor(cSky);

    const clearNight = env ? env.night : (h < 6.5 || h >= 20);
    let starTarget = 0;
    if (def.stars === 'always') starTarget = 0.5 + 0.18 * Math.sin(tms / 900);
    else if (def.stars === 'auto') starTarget = clearNight && (!env || env.kind === 'clear' || env.kind === 'none') ? 0.5 + 0.18 * Math.sin(tms / 900) : 0;
    starMat.opacity += (starTarget - starMat.opacity) * 0.04;
    // Night CSS class still follows real time-of-day (button/gutter theming), not the preset.
    if (clearNight !== nightClass) {
      nightClass = clearNight;
      document.body.classList.toggle('night', clearNight);
    }
  }

  // ---------- wallpaper care dock (desktop: tend the tree without the full toolbar)
  // water/mist/feed fire the same care actions as tapping the scene; prune/wire/trim
  // enter their mode, then a click on a branch/pad does the work via the usual path.
  const wpDock = $('#wp-dock');
  function wireDock() {
    if (!wpDock || !WALLPAPER) return;
    $('#wp-water').onclick = () => { lastInteract = performance.now(); doWater(); };
    $('#wp-mist').onclick = () => { lastInteract = performance.now(); doMist(); };
    $('#wp-feed').onclick = () => { lastInteract = performance.now(); doFeed(); };
    $('#wp-prune').onclick = () => { lastInteract = performance.now(); setMode('prune'); };
    $('#wp-wire').onclick = () => { lastInteract = performance.now(); setMode('wire'); };
    $('#wp-trim').onclick = () => { lastInteract = performance.now(); setMode('trim'); };
    $('#wp-ff').onclick = () => { lastInteract = performance.now(); doTimeLapse(); };
    wpDock.classList.remove('hidden');
    // any pointer movement over the desktop wakes the dock; it fades out when idle
    // (see the frame loop). Kept separate from lastInteract so the idle turntable is
    // still governed only by real interaction, not by the cursor passing over.
    window.addEventListener('pointermove', () => { dockWake = performance.now(); }, { passive: true });
    dockWake = performance.now();
    syncDock();
  }
  // reflect the active tool so the desktop shows which mode is armed
  function syncDock() {
    if (!wpDock || wpDock.classList.contains('hidden')) return;
    $('#wp-prune').classList.toggle('active', mode === 'prune');
    $('#wp-wire').classList.toggle('active', mode === 'wire');
    $('#wp-trim').classList.toggle('active', mode === 'trim');
  }

  // ---------- UI
  function buildUI() {
    for (const id of ['#bar-water', '#bar-mist', '#bar-food', '#bar-health']) {
      const el = $(id);
      for (let i = 0; i < 10; i++) el.appendChild(document.createElement('i'));
    }
    $('#bm-cut').onclick = () => {
      const id = branchMenuSeg;
      closeBranchMenu();
      if (id !== null) doCut(id);
    };
    $('#bm-trim').onclick = () => {
      closeBranchMenu();
      if (mode !== 'trim') setMode('trim');   // pick up the shears, then choose pads
    };
    $('#bm-wire').onclick = () => {
      const id = branchMenuSeg;
      closeBranchMenu();
      const seg = id !== null && tree.segs.get(id);
      if (!seg) return;
      if (seg.wired) {
        requestUnwire(id);
      } else if (doWire(id)) {
        const mo = Math.max(1, Math.round(tree.wireSetHours(seg) / 720));
        toast(`➰ wire on — drag the branch to bend · needs ~${mo} month${mo > 1 ? 's' : ''} to set` + (WALLPAPER ? ' · tap empty space to finish' : ''));
        if (mode !== 'wire') setMode('wire');   // ready to bend right away
      }
    };
    document.addEventListener('pointerdown', (e) => {
      if (branchMenuSeg !== null && e.target !== view && !branchMenuEl.contains(e.target)) closeBranchMenu();
    }, true);
    $('#btn-future').onclick = toggleFuture;
    for (const b of document.querySelectorAll('#future-bar button')) {
      b.onclick = () => setPreview(+b.dataset.years);
    }
    $('#zoom-in').onclick = () => applyZoom(zoom * 1.25);
    $('#zoom-out').onclick = () => applyZoom(zoom / 1.25);
    $('#btn-res').onclick = () => { applyRes(resIdx + 1); save(); };
    $('#btn-ff').onclick = doTimeLapse;
    $('#btn-help').onclick = () => $('#modal-help').classList.remove('hidden');
    $('#btn-settings').onclick = openSettings;
    chipWeather.onclick = openSettings;
    for (const b of document.querySelectorAll('.modal-close')) {
      b.onclick = () => b.closest('.modal').classList.add('hidden');
    }
    for (const m of document.querySelectorAll('.modal')) {
      m.addEventListener('pointerdown', (e) => { if (e.target === m) m.classList.add('hidden'); });
    }
    $('#btn-city-search').onclick = citySearch;
    $('#city-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') citySearch(); });
    $('#btn-geo').onclick = async () => {
      toast('📍 asking your browser for location…');
      const ok = await B.Weather.geolocate();
      toast(ok ? '📍 location set!' : '📍 no luck — try searching your city instead');
      if (ok) { updateChips(); save(); }
    };
    $('#btn-dna').onclick = async () => {
      dna.t = S.simT;
      try {
        const code = await SIM.dnaEncode(dna);
        let url = location.href.split('#')[0] + '#dna=' + code;
        if (nft && nft.tokenId) url += '&nft=' + nft.tokenId;   // viewer verifies the claim on-chain
        if (atts.length) url += '&att=' + B.Notary.encodeAtts(B.Notary.pickShareSubset(atts));   // …and the age proof offline
        await navigator.clipboard.writeText(url);
        toast('🧬 DNA link copied — it opens a read-only view of this exact tree');
      } catch (e) {
        toast('🧬 could not copy the link (' + (e && e.message || e) + ')');
      }
    };
    $('#btn-mint').onclick = mintOrUpdate;
    $('#btn-keep').onclick = mintOrUpdate;   // same flow — mint converts this demo into a kept, owned NFT
    $('#btn-wallpaper').onclick = offerWallpaper;

    // Build the background swatches once.
    const picker = $('#bg-picker');
    if (picker && !picker.childElementCount) {
      for (const key of Object.keys(BACKGROUNDS)) {
        const b = document.createElement('button');
        b.className = 'btn small bg-swatch' + (key === bg ? ' active' : '');
        b.dataset.bg = key;
        b.textContent = BACKGROUNDS[key].label;
        b.onclick = () => setBackground(key, true);
        picker.appendChild(b);
      }
    }
    let resetArmed = 0;
    $('#btn-reset').onclick = (e) => {
      if (Date.now() - resetArmed < 3000) {
        e.target.textContent = '🌱 NEW TREE';
        $('#modal-settings').classList.add('hidden');
        freshTree();
      } else {
        resetArmed = Date.now();
        e.target.textContent = '⚠ REALLY? CLICK AGAIN';
        setTimeout(() => { e.target.textContent = '🌱 NEW TREE'; }, 3000);
      }
    };
  }

  function openSettings() {
    const st = B.Weather.st;
    $('#loc-current').textContent = st.lat === null
      ? 'location: not set — search a city below'
      : `location: ${st.city || 'unknown'} (${st.lat.toFixed(2)}, ${st.lon.toFixed(2)})`;
    $('#city-results').innerHTML = '';
    renderMintState();
    renderSyncStatus();
    $('#modal-settings').classList.remove('hidden');
  }

  function renderSyncStatus() {
    const el = $('#sync-status'); if (!el) return;
    if (!isMinted()) { el.textContent = ''; return; }
    el.textContent = sawPeer
      ? (isLeader ? '🔗 synced live with your desktop — this window is tending the tree'
                  : '🔗 synced live — your desktop is tending the tree')
      : '🖼 on your desktop, the wallpaper syncs live with this page (same site).';
  }

  // Copy a personalized wallpaper URL carrying THIS tree, so it opens as the same
  // tree on the desktop. A minted tree syncs live (same-origin); a demo tree isn't
  // saved and doesn't sync, so its link is a static snapshot at copy time. Reuses
  // the DNA encoder.
  async function offerWallpaper() {
    dna.t = S.simT;
    try {
      const code = await SIM.dnaEncode(dna);
      const base = location.href.split('#')[0].replace(/index\.html$/, '');
      let url = base + 'wallpaper.html#wallpaper&seed=' + code;
      if (nft && nft.tokenId) url += '&nft=' + nft.tokenId;
      await navigator.clipboard.writeText(url);
      toast(isMinted()
        ? '🖼 wallpaper link copied! In Plash/Lively (macOS/Windows) add it as a website — your tree lives on your desktop and syncs with this page.'
        : "🖼 wallpaper link copied! It's a snapshot of your bonsai as it looks now — add it in Plash/Lively as a website. 🌱 It won't sync or keep growing until you 🪙 KEEP (mint) it.",
        { ms: 9000 });
    } catch (e) {
      toast('🖼 could not copy the link (' + (e && e.message || e) + ')');
    }
  }

  // ---------- optional NFT mint (Base Sepolia testnet, lazy — see js/chain.js)
  let chainLoad = null;
  function loadChain() {
    if (B.Chain) return Promise.resolve(B.Chain);
    if (chainLoad) return chainLoad;
    chainLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'js/chain.js';
      s.onload = () => B.Chain ? resolve(B.Chain) : reject(new Error('chain module failed to load'));
      s.onerror = () => reject(new Error('chain module failed to load'));
      document.head.appendChild(s);
    });
    return chainLoad;
  }

  function renderMintState() {
    const btn = $('#btn-mint'), status = $('#mint-status'), keep = $('#btn-keep');
    if (!btn) return;
    if (isMinted()) {
      btn.textContent = '⛓ UPDATE ON-CHAIN';
      status.classList.remove('hidden');
      status.innerHTML = `🪙 kept · Pixel Bonsai token #${nft.tokenId} · ` +
        `<a href="https://sepolia.basescan.org/tx/${nft.txHash}" target="_blank" rel="noopener">tx</a>` +
        ` · last on-chain age ${Math.floor((nft.simT || 0) / 86400)}d`;
      if (keep) keep.classList.add('hidden');   // already kept — no CTA needed
    } else {
      btn.textContent = '🪙 KEEP THIS BONSAI';
      status.classList.remove('hidden');
      status.textContent = '🌱 demo — not saved yet · mint to keep it forever';
      // The KEEP CTA only makes sense once the tree has some progress worth keeping.
      if (keep) keep.classList.toggle('hidden', !(dna && dna.e && dna.e.length > 0));
      // One-shot nudge at the first real attachment moment (first blossom).
      if (!keepNudged && !VIEWER && statsCache && statsCache.blossoms > 0) {
        keepNudged = true;
        toast('🌸 your bonsai is blooming — 🪙 KEEP it to mint & own it forever', {
          ms: 9000, action: { label: '🪙 KEEP', fn: mintOrUpdate },
        });
      }
    }
  }

  async function mintOrUpdate() {
    if (guardViewer()) return;
    const btns = [$('#btn-mint'), $('#btn-keep')].filter(Boolean);
    btns.forEach((b) => { b.disabled = true; });
    try {
      const C = await loadChain();
      if (!C.CFG.CONTRACT) {
        toast('🪙 the contract is not deployed yet — coming soon');
        return;
      }
      if (!C.hasWallet()) {
        toast('🪙 to keep your bonsai you need a browser wallet (MetaMask) — the demo plays without one', { ms: 8000 });
        return;
      }
      await C.loadEthers();
      await C.connect();
      await C.ensureNetwork();
      dna.t = S.simT;
      const code = await SIM.dnaEncode(dna);
      const simTNow = Math.floor(S.simT);
      if (nft) {
        toast('⛓ confirm the update in your wallet…', { ms: 12000 });
        const r = await C.update(nft.tokenId, code, simTNow);
        nft.simT = simTNow; nft.txHash = r.txHash; nft.ts = Date.now();
        toast('⛓ your on-chain bonsai is up to date!');
      } else {
        const treeId = C.treeIdOf(dna.seed, dna.g);
        const existing = await C.readTokenOfTree(treeId);
        if (existing) {
          nft = { tokenId: existing, contract: C.CFG.CONTRACT, chain: C.CFG.CHAIN_ID, txHash: '', simT: simTNow, ts: Date.now() };
          toast(`🪙 this tree is already minted — token #${existing}`);
        } else {
          toast('🪙 confirm the mint in your wallet…', { ms: 12000 });
          const r = await C.mint({ treeId, dnaCode: code, simT: simTNow });
          nft = { tokenId: r.tokenId, contract: C.CFG.CONTRACT, chain: C.CFG.CHAIN_ID, txHash: r.txHash, simT: simTNow, ts: Date.now() };
          toast(`🪙 kept! Pixel Bonsai token #${r.tokenId} is now yours on Base Sepolia`, { ms: 8000 });
        }
      }
      save();              // now that it's minted, this actually persists the tree
      renderMintState();
      updateStatus();      // clear the "demo — not saved" hint
    } catch (e) {
      if (e && (e.code === 4001 || e.code === 'ACTION_REJECTED')) {
        toast('🪙 no worries — nothing was sent');
      } else {
        toast('🪙 ' + (((e && (e.shortMessage || e.message)) || 'something went wrong') + '').slice(0, 120), { ms: 7000 });
      }
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  }

  async function citySearch() {
    const q = $('#city-input').value.trim();
    if (!q) return;
    const box = $('#city-results');
    box.textContent = 'searching…';
    try {
      const results = await B.Weather.searchCity(q);
      box.innerHTML = '';
      if (!results.length) { box.textContent = 'no matches found'; return; }
      for (const r of results) {
        const b = document.createElement('button');
        b.className = 'btn';
        b.textContent = `${r.name}${r.admin ? ', ' + r.admin : ''} ${r.country ? '(' + r.country + ')' : ''}`;
        b.onclick = async () => {
          await B.Weather.setLocation(r.lat, r.lon, r.name);
          $('#modal-settings').classList.add('hidden');
          toast(`🌍 weather set to ${r.name}`);
          updateChips(); save();
        };
        box.appendChild(b);
      }
    } catch (e) {
      box.textContent = 'search failed — are you online?';
    }
  }

  function setBar(id, v) {
    const el = $(id);
    const on = Math.round(clamp(v, 0, 100) / 10);
    const cells = el.children;
    for (let i = 0; i < 10; i++) cells[i].classList.toggle('on', i < on);
    el.classList.toggle('low', v < 20);
  }

  function careNote() {
    if (res.dead) return '🪦 the tree has passed away — ⚙ NEW TREE plants another';
    if (S.dyingH > 0 && res.health <= 20) return `🥀 the tree is dying — about ${Math.max(1, Math.ceil((SIM.DEATH_H - S.dyingH) / 24))}d to save it!`;
    if (res.water < 15) return '💧 the soil is dry — water me!';
    if (S.burnH > 0) return '🔥 burnt roots — let the fertilizer fade';
    if (S.soggy > 30) return '🫧 soggy roots — ease off the watering';
    if (res.mist < 15) return '🌫 dry air — a misting would be lovely';
    if (res.food < 10 && (!lastEnv || lastEnv.season !== 'winter')) return '🧪 hungry — a little fertilizer?';
    if (statsCache && statsCache.tips >= 20) return '✂️ getting bushy — pruning helps it bloom';
    if (statsCache && statsCache.blossoms >= 14 && S.trimBoost < 2) return '🍃 dense crown — a trim lets light inside';
    let wireLeft = Infinity, anySet = false;
    for (const s of tree.segs.values()) {
      if (!s.wired) continue;
      const left = tree.wireSetHours(s) - s.wireAge;
      if (left <= 0) anySet = true;
      else wireLeft = Math.min(wireLeft, left);
    }
    if (anySet) return '➰ a wire has set — tap the coil to remove it';
    if (wireLeft !== Infinity) return `➰ wire training — the branch sets in ~${Math.max(1, Math.ceil(wireLeft / 24))}d`;
    if (res.health > 85 && statsCache && statsCache.blossoms >= 8) return '🌸 thriving!';
    return null;
  }

  function updateStatus() {
    let txt;
    if (VIEWER) txt = viewerStatus;
    else if (previewTree) txt = `🔮 your bonsai after ${previewYears} years of loving care — press NOW to return`;
    else if (mode === 'prune') txt = '✂️ click a branch or blossom to cut — esc to exit';
    else if (mode === 'trim') txt = '🍃 click a blossom pad to pinch it — esc to exit';
    else if (mode === 'wire') txt = '➰ click a branch, drag to bend · dbl-click unwires · esc exits';
    else txt = careNote() || (lastEnv && lastEnv.note) || 'drag the pot 🌀 · rake the sand · tap: blossoms=mist, air=water, pebbles=feed, branch=✂️➰';
    // Demo trees aren't saved — keep a gentle, persistent reminder in the status line.
    if (!VIEWER && !previewTree && !isMinted() && dna && dna.e && dna.e.length > 0) {
      txt = '🌱 demo — not saved · 🪙 KEEP to mint & own it · ' + txt;
    }
    if (statusEl.textContent !== txt) statusEl.textContent = txt;
  }

  function updateChips() {
    const now = new Date();
    const env = lastEnv || B.Weather.env(now);
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    chipClock.textContent = `${env.night ? '🌙' : '☀️'} ${hh}:${mm}`;
    const st = B.Weather.st;
    if (st.lat === null) chipWeather.textContent = '📍 SET CITY';
    else if (env.ok) chipWeather.textContent = `${env.emoji} ${Math.round(env.temp)}° · ${(env.city || '?').slice(0, 14)}`;
    else chipWeather.textContent = `${env.emoji} ${(env.city || '…').slice(0, 14)}`;
  }

  function updateFacts() {
    if (previewTree) {
      const p = previewTree.stats();
      $('#fact-stage').textContent = `🔮 +${previewYears}y vision`;
      $('#fact-age').textContent = `age ${Math.floor(p.ageHours / 24)}d · ${p.segments} segs`;
      $('#fact-bloom').textContent = `🌸 ${p.blossoms}`;
      return;
    }
    const s = statsCache || tree.stats();
    if (res.dead) {
      $('#fact-stage').textContent = '🪦 Departed';
      $('#fact-age').textContent = `age ${Math.floor(s.ageHours / 24)}d · ${s.segments} segs`;
      $('#fact-bloom').textContent = '🥀 0';
      return;
    }
    const stage = s.segments < 20 ? 'Sapling' : s.segments < 45 ? 'Young' : s.segments < 80 ? 'Shaped' : s.segments < 120 ? 'Mature' : 'Ancient';
    $('#fact-stage').textContent = `${stage} bonsai`;
    $('#fact-age').textContent = `age ${Math.floor(s.ageHours / 24)}d · ${s.segments} segs`;
    const winterNow = lastEnv && lastEnv.season === 'winter';
    const padEmoji = winterNow || (lastEnv && lastEnv.season === 'autumn') ? '🍂'
      : lastEnv && !lastEnv.bloom ? '🍃' : '🌸';
    $('#fact-bloom').textContent = `${padEmoji} ${winterNow ? 0 : s.blossoms}`;
  }

  function updateAll() {
    setBar('#bar-water', res.water);
    setBar('#bar-mist', res.mist);
    setBar('#bar-food', Math.min(100, res.food));
    setBar('#bar-health', res.health);
    updateStatus();
    updateChips();
    updateFacts();
    renderMintState();   // keep the KEEP/demo CTA in sync as the tree grows
  }

  // ---------- cosmetic spring-back animation (unwire)
  // The canonical model already jumps to the sprung-back pose (see SIM op 'u');
  // this replays that single rigid subtree rotation visually — the branch swings
  // from its bent pose to rest with a slight overshoot. Purely display: it only
  // mutates seg.dir + tree.rev (exactly how bends do), and the final frame lands
  // on the same rotation the sim produced, so replay/save stay authoritative.
  let springAnim = null;   // {segId, axis, total, startDirs:Map, t, dur}

  // ease-out-back: overshoots above 1 mid-flight, resolves to exactly 1 at k=1.
  function springEase(k) { const c1 = 1.70158, c3 = c1 + 1, p = k - 1; return 1 + c3 * p * p * p + c1 * p * p; }

  // Place the subtree at its captured pre-spring dirs rotated by `ang`, then rebuild.
  function applySpringPose(ang) {
    const seg = tree.segs.get(springAnim.segId);
    if (!seg) { springAnim = null; return; }
    const V = B.Vec;
    const walk = (s) => {
      const d0 = springAnim.startDirs.get(s.id);
      if (d0) s.dir = V.norm(V.rotate(d0, springAnim.axis, ang));
      for (const c of s.children) walk(c);
    };
    walk(seg);
    tree.recompute();
    tree.rev++;   // forces syncTree() to rebuild this frame
  }

  function startSpringAnim(segId, axis, total, startDirs) {
    if (springAnim) applySpringPose(springAnim.total);   // finalize any in-flight spring
    springAnim = { segId, axis, total, startDirs, t: 0, dur: 0.45 };
    applySpringPose(0);   // show the bent pose immediately, then swing from it
  }

  function stepSpringAnim(dt) {
    if (!springAnim) return;
    if (previewTree) { springAnim = null; return; }   // vision replaces the live tree — drop it
    springAnim.t += dt;
    const k = Math.min(1, springAnim.t / springAnim.dur);
    applySpringPose(springAnim.total * springEase(k));
    if (k >= 1) { applySpringPose(springAnim.total); springAnim = null; }   // land exactly on target
  }

  // ---------- main loop
  let lastFrameT = 0;
  function frame(tms) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.06, lastFrameT ? (tms - lastFrameT) / 1000 : 0.016);
    lastFrameT = tms;
    if (!drag || drag.type !== 'rotate') {
      theta += thetaVel;
      thetaVel *= 0.93;
      if (Math.abs(thetaVel) < 0.0001) thetaVel = 0;
    }
    if (WALLPAPER && !drag && tms - lastInteract > 30000) theta += dt * 0.02;  // idle: slow turntable
    if (wpDock && !wpDock.classList.contains('hidden')) {
      // fade the care dock out after ~4s of no cursor movement — but keep it up while a
      // tool is armed or a drag is in flight, so you never lose the active-mode cue mid-tend.
      // In the menu-bar app the panel is *for* tending, so the dock stays put.
      const awake = DESKTOP_APP || drag || mode !== 'view' || tms - dockWake < 4000;
      wpDock.classList.toggle('dimmed', !awake);
    }
    rotGroup.rotation.y = theta;
    const swayA = lastEnv ? lastEnv.sway : 0.3;
    treeMesh.rotation.z = Math.sin(tms / 625) * 0.012 * swayA;
    treeMesh.rotation.x = Math.sin(tms / 900 + 2) * 0.008 * swayA;
    stepSpringAnim(dt);
    syncTree();
    syncPot();
    syncDecals();
    skyFrame(tms);
    renderer.render(scene, camera);
    fxFrame(dt, tms);
  }

  // ---------- dev/test hooks
  function exposeDev() {
    window.__bonsai = {
      get tree() { return tree; },
      get res() { return res; },
      get sim() { return S; },
      get viewer() { return VIEWER; },
      get nft() { return nft; },
      get atts() { return atts; },
      get bg() { return bg; },
      get isLeader() { return isLeader; },
      get sawPeer() { return sawPeer; },
      setBg: (k) => setBackground(k, true),
      get clearColor() { return renderer ? '#' + renderer.getClearColor(new THREE.Color()).getHexString() : null; },
      dna: () => { dna.t = S.simT; return JSON.parse(SIM.canonical(dna)); },
      dnaCode: () => { dna.t = S.simT; return SIM.dnaEncode(dna); },
      verifyReplay: () => {   // replay the envelope and diff it against the live state
        dna.t = S.simT;
        const r = SIM.replay(JSON.parse(SIM.canonical(dna)));
        const pick = (st) => ({
          rng: st.tree.rng.state, segs: st.tree.segs.size, tree: JSON.stringify(st.tree.serialize()),
          res: JSON.stringify(st.res), gp: st.gp, burnH: st.burnH, soggy: st.soggy,
          trim: st.trimBoost, dying: st.dyingH, simT: st.simT,
        });
        const a = pick(S), b = pick(r);
        const diffs = Object.keys(a).filter(k => a[k] !== b[k]);
        return { ok: diffs.length === 0, diffs, live: { rng: a.rng, segs: a.segs }, replay: { rng: b.rng, segs: b.segs } };
      },
      simulate: (seconds, opts) => {   // dev/test time injection — logged so replay stays truthful
        if (VIEWER) return;
        const off = !!(opts && opts.offline);
        const quanta = Math.ceil(seconds / SIM.STEP_S) * SIM.STEP_S;
        appendEvent([off ? 'O' : 'L', S.simT, quanta]);
        renderStepFx(SIM.advance(S, quanta, off), false);
        statsCache = tree.stats();
        updateAll();
      },
      setPreview, toggleFuture, applyZoom,
      // care hooks: the scene is the interface (tap air/blossoms/pebbles/branch), so
      // there are no care buttons to click — tests and the wallpaper dock drive these.
      water: () => doWater(),
      mist: () => doMist(),
      feed: () => doFeed(),
      setMode: (m) => setMode(m),
      timeLapse: () => doTimeLapse(),
      get env() { return lastEnv; },
      get mode() { return mode; },
      get zoom() { return zoom; },
      get pix() { return { idx: resIdx, bufW: BUFW, bufH: BUFH }; },
      get foliage() { return lastTier; },
      get dying() { return S.dyingH; },
      get panY() { return panY; },
      get theta() { return theta; },
      get preview() { return previewTree ? previewYears : 0; },
      projectLocal: (x, y, z) => projectLocalPt(x, y, z),
      previewStats: () => previewTree && previewTree.stats(),
      weather: B.Weather,
      project: projectTreePt,
      pick: pickAt,
      sceneAt: (x, y) => pickScene(x, y),
      sandSum: () => {
        const d = sandCtx.getImageData(0, 0, SAND_TEX, SAND_TEX).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 97) s = (s + d[i]) % 1e9;
        return s;
      },
      isMinted: () => isMinted(),
      // Test hook: simulate a successful KEEP/mint without a wallet, so the
      // demo→persist path can be exercised headlessly. Mirrors what mintOrUpdate sets.
      keep: (tokenId) => {
        if (VIEWER) return null;
        nft = { tokenId: tokenId || 1, contract: 'test', chain: 0, txHash: 'test', simT: Math.floor(S.simT), ts: Date.now() };
        save();
        renderMintState();
        updateStatus();
        return nft;
      },
    };
  }

  // ---------- read-only DNA viewer (#dna=…): replay someone else's envelope,
  // render it, touch nothing — no sim tick, no save, no weather fetches.
  async function bootViewer(code) {
    let env = null;
    try { env = await SIM.dnaDecode(code); } catch (e) { env = null; }
    if (!env || env.v !== 2 || typeof env.g !== 'number') {
      return fatal('🧬 this DNA link is damaged or from a newer version — ask for a fresh one.');
    }
    dna = env;
    S = SIM.replay(dna);
    tree = S.tree; res = S.res;
    statsCache = tree.stats();
    try { setupScene(); } catch (e) {
      return fatal('😢 WebGL is unavailable in this browser, and the bonsai needs it. (' + e.message + ')');
    }
    document.body.classList.add('viewer');
    exposeDev();
    buildUI();
    bindInput();
    applyZoom(1);
    applyPan(0);
    applyRes(2);
    // The viewer has no location — its foliage must follow the TREE's
    // hemisphere (from the envelope), or a southern tree shared in August
    // would wrongly show summer leaves instead of its winter dormancy.
    const si = SIM.seasonInfo(Date.now(), !!dna.s);
    B.Weather.forceSeason = { season: si.season, bloom: si.bloom };
    lastEnv = B.Weather.env(new Date());
    updateAll();
    requestAnimationFrame(frame);

    // If the link carries notary attestations, verify them OFFLINE (WebCrypto
    // + committed public keys) — any that pass prove the history's age.
    const attHash = /[#&]att=([^&\s]+)/.exec(location.hash);
    if (attHash) {
      try {
        const shared = B.Notary.decodeAtts(attHash[1]);
        const oks = await Promise.all(shared.map(a => B.Notary.verify(dna, a)));
        const verified = shared.filter((_, i) => oks[i]);
        if (verified.length) {
          const oldest = verified.reduce((m, a) => a.ts < m.ts ? a : m);
          const days = Math.max(0, Math.floor((Date.now() - oldest.ts) / 864e5));
          const el = $('#fact-notary');
          el.textContent = `⏱ on record since ${new Date(oldest.ts).toLocaleDateString()} · ≥${days}d`;
          el.classList.remove('hidden');
        }
      } catch (e) { /* damaged att param — the badge just stays off */ }
    }

    // If the link claims this tree is minted, verify it against the chain
    // (public RPC, no wallet) — the badge only shows when the chain agrees.
    const nftHash = /[#&]nft=(\d+)/.exec(location.hash);
    if (nftHash) {
      try {
        const C = await loadChain();
        const v = await C.verifyToken(dna, parseInt(nftHash[1], 10));
        if (v.ok) {
          const el = $('#fact-chain');
          el.innerHTML = `<a href="https://sepolia.basescan.org/token/${C.CFG.CONTRACT}?a=${nftHash[1]}" ` +
            `target="_blank" rel="noopener">⛓ token #${nftHash[1]}</a>`;
          el.classList.remove('hidden');
          viewerStatus = '🧬 viewing a shared bonsai · ⛓ minted on Base Sepolia — read-only';
          statusEl.textContent = viewerStatus;
        }
      } catch (e) { /* network optional — the badge just stays off */ }
    }
  }

  // ---------- boot
  function boot() {
    if (typeof THREE === 'undefined') {
      return fatal('🌸 Pixel Bonsai needs internet the first time it loads (the 3D library comes from a CDN). Reconnect and refresh.');
    }
    if (VIEWER) { bootViewer(DNA_HASH[1]); return; }
    let data = null;
    try { data = JSON.parse(store.get(KEY) || 'null'); } catch (e) { data = null; }
    if (data && data.v === 1) data.dna = migrateV1(data);
    if (data && (!data.dna || data.dna.v !== 2)) data = null;

    if (data) {
      dna = data.dna;
      B.Weather.hydrate(data.wx);
    } else {
      dna = { v: 2, seed: (Math.random() * 0xffffffff) >>> 0, g: Date.now(), s: 0, t: 0, e: [] };
    }
    // Boot IS a replay — the envelope is the only authority on the tree.
    S = SIM.replay(dna);
    tree = S.tree; res = S.res;
    pendingSec = data && typeof data.pendingSec === 'number' ? data.pendingSec : 0;
    statsCache = tree.stats();
    const hashTheta = /theta=(-?[\d.]+)/.exec(location.hash);
    if (hashTheta) theta = parseFloat(hashTheta[1]);
    if (data) {
      if (!hashTheta) theta = typeof data.theta === 'number' ? data.theta : -0.55;
      decals = Array.isArray(data.decals) ? data.decals : [];
      nft = data.nft || null;
      atts = Array.isArray(data.atts) ? data.atts : [];
      if (typeof data.bg === 'string') bg = data.bg;
    }

    try { setupScene(); } catch (e) {
      return fatal('😢 WebGL is unavailable in this browser, and the bonsai needs it to grow. (' + e.message + ')');
    }
    if (data && typeof data.sand === 'string') {
      const img = new Image();
      img.onload = () => {
        sandCtx.globalAlpha = 1;
        sandCtx.drawImage(img, 0, 0, SAND_TEX, SAND_TEX);
        sandTexture.needsUpdate = true;
      };
      img.src = data.sand;
    }
    if (WALLPAPER) {
      document.documentElement.classList.add('wallpaper');
      applyViewport();
      let rt;
      window.addEventListener('resize', () => {
        clearTimeout(rt);
        rt = setTimeout(() => { applyViewport(); applyZoom(zoom); }, 200);
      });
      lastInteract = performance.now();
    }
    applyZoom(data && typeof data.zoom === 'number' ? data.zoom : 1);
    applyPan(data && typeof data.pan === 'number' ? data.pan : 0);
    savedPix = data && typeof data.pix2 === 'number' ? data.pix2 : 2;
    applyRes(WALLPAPER ? 2 : savedPix);   // the wallpaper always renders fine — there's no ▦ button to fix a coarse save

    exposeDev();
    const hashFF = /ff=(\d+)/.exec(location.hash);   // #ff=N — dev: fast-forward N hours
    if (hashFF) {
      const secs = parseInt(hashFF[1], 10) * 3600;
      appendEvent(['L', S.simT, secs]);
      SIM.advance(S, secs, false);
    }
    buildUI();
    bindInput();
    wireDock();
    lastEnv = B.Weather.env(new Date());

    if (data && data.ts) {
      const gapSec = Math.max(0, (Date.now() - data.ts) / 1000);
      if (gapSec > 60) {
        const before = tree.stats().segments;
        offlineAdvance(gapSec);
        const grew = tree.stats().segments - before;
        if (gapSec > 2 * 3600) {
          toast(`🌙 while you were away (${Math.round(Math.min(gapSec, SIM.OFFLINE_CAP_S) / 3600)}h): ` +
            (grew > 0 ? `the tree grew ${grew} new shoots` : 'the tree waited patiently'), { ms: 6000 });
        }
      }
    } else {
      toast('🌸 your bonsai has arrived! drag the pot to rotate — try ⏩ to watch it grow', { ms: 6500 });
    }

    B.Weather.onUpdate = () => {
      lastEnv = B.Weather.env(new Date());
      updateChips(); updateStatus();
      // Hemisphere is frozen at genesis, but a brand-new tree that only now
      // learned its real location (first weather fix) re-mints with the right
      // seasons — only while its history is still empty and young.
      const south = B.Weather.st.lat !== null && B.Weather.st.lat < 0;
      if (!dna.snap && dna.e.length === 0 && S.simT < 86400 && (dna.s === 1) !== south) {
        dna.s = south ? 1 : 0;
        rebuildFromLog();
        save();
      }
    };
    B.Weather.init();

    setBackground(bg, false);   // apply any restored background preset
    updateAll();
    save();
    lastTick = Date.now();
    setInterval(tick, 1000);
    requestAnimationFrame(frame);
    initSync();   // same-origin live sync with a peer (browser ⇄ wallpaper)

    // Safety net: a tree with real history but no local mint record might still be
    // owned on-chain (e.g. localStorage was cleared). Ask the public RPC — no wallet —
    // and rehydrate `nft` so the player keeps ownership without re-minting.
    if (!isMinted() && dna.e && dna.e.length > 0) {
      recoverMintFromChain();
    }
  }

  async function recoverMintFromChain() {
    try {
      const C = await loadChain();
      if (!C.CFG.CONTRACT) return;
      const existing = await C.readTokenOfTree(C.treeIdOf(dna.seed, dna.g));
      if (existing && !isMinted()) {
        nft = { tokenId: existing, contract: C.CFG.CONTRACT, chain: C.CFG.CHAIN_ID,
                txHash: '', simT: Math.floor(S.simT), ts: Date.now() };
        save();
        renderMintState();
        updateStatus();
        toast(`🪙 welcome back — this bonsai is yours, token #${existing}`);
      }
    } catch (e) { /* network optional — stays a demo until minted */ }
  }

  // One-time seed of a fresh wallpaper install from #seed=<dna>: decode the tree
  // and stash it under KEY so the normal boot() load path picks it up. Runs only in
  // wallpaper mode, only when there is no existing save (so it never clobbers a tree
  // that has already started growing/syncing here).
  async function seedFromHash() {
    if (!SEED_HASH) return;
    try {
      if (store.get(KEY)) return;                 // this install already has a tree
      const env = await SIM.dnaDecode(SEED_HASH[1]);
      if (!env || env.v !== 2 || typeof env.g !== 'number') return;
      const seededNft = SEED_NFT
        ? { tokenId: parseInt(SEED_NFT[1], 10), contract: '', chain: 0, txHash: '', simT: Math.floor(env.t || 0), ts: Date.now() }
        : null;
      store.set(KEY, JSON.stringify({ v: 2, ts: Date.now(), pendingSec: 0, dna: env, nft: seededNft || undefined }));
    } catch (e) { /* bad seed → boot() just starts a fresh tree */ }
  }

  async function start() { await seedFromHash(); boot(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
