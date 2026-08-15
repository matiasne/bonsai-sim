/* End-to-end browser test: drives the real page in installed Chrome via puppeteer-core.
   Run: npm install && npm run e2e
   Override the browser with CHROME=/path/to/chrome. */
'use strict';
const path = require('path');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'file://' + path.join(__dirname, '..', 'index.html');
const results = [];
const okAll = { n: 0, fail: false };
function check(cond, label) {
  results.push((cond ? '  ✓ ' : '  ✗ FAIL ') + label);
  if (cond) okAll.n++; else okAll.fail = true;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=720,980'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 720, height: 980 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  // network-resource failures (geo/weather API hiccups) are tolerated by the app's fallback chain
  page.on('console', m => { if (m.type() === 'error' && !/net::|favicon|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

  await page.goto(URL + '#ff=48', { waitUntil: 'load' });
  await page.waitForFunction('window.__bonsai && window.__bonsai.tree', { timeout: 12000 });
  await sleep(1200);

  const t0 = await page.evaluate(() => ({ segs: __bonsai.tree.segs.size, water: __bonsai.res.water, blossoms: __bonsai.tree.stats().blossoms }));
  check(t0.segs > 8, `48h fast-forward grew the tree (${t0.segs} segs, ${t0.blossoms} blossoms)`);

  // --- WATER button
  await page.click('#btn-water');
  await sleep(150);
  const w1 = await page.evaluate(() => __bonsai.res.water);
  check(w1 > t0.water, `WATER button raised moisture ${t0.water.toFixed(1)} → ${w1.toFixed(1)}`);

  // --- rotation: only the pot is a rotate handle
  const rect = await page.evaluate(() => {
    const r = document.querySelector('#view').getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const toCss = (p) => ({ x: rect.left + (p.x / 176) * rect.w, y: rect.top + (p.y / 176) * rect.h });
  const th0 = await page.evaluate(() => __bonsai.theta);
  const potPt = toCss(await page.evaluate(() => __bonsai.projectLocal(0, 5, 0)));
  await page.mouse.move(potPt.x, potPt.y);
  await page.mouse.down();
  await page.mouse.move(potPt.x + rect.w * 0.12, potPt.y, { steps: 8 });
  await page.mouse.up();
  await sleep(400);
  const th1 = await page.evaluate(() => __bonsai.theta);
  check(Math.abs(th1 - th0) > 0.15, `pot drag rotates the tree (θ ${th0.toFixed(2)} → ${th1.toFixed(2)})`);

  await page.keyboard.press('ArrowLeft');   // zeroes rotation inertia
  await sleep(200);
  const thB0 = await page.evaluate(() => __bonsai.theta);
  await page.mouse.move(rect.left + 12, rect.top + 12);
  await page.mouse.down();
  await page.mouse.move(rect.left + 90, rect.top + 12, { steps: 5 });
  await page.mouse.up();
  await sleep(400);
  const thB1 = await page.evaluate(() => __bonsai.theta);
  check(Math.abs(thB1 - thB0) < 0.05, 'background drag does NOT rotate');

  // --- scene taps: pebbles feed
  const foodT0 = await page.evaluate(() => __bonsai.res.food);
  const pebPt = toCss(await page.evaluate(() => __bonsai.projectLocal(8, 10.1, 0)));
  await page.mouse.click(pebPt.x, pebPt.y);
  await sleep(250);
  const foodT1 = await page.evaluate(() => __bonsai.res.food);
  check(foodT1 > foodT0, `pebble tap feeds the tree (${foodT0.toFixed(0)} → ${foodT1.toFixed(0)})`);
  const toastPos = await page.evaluate(() => {
    const t = document.querySelector('#toasts .toast:last-child');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    const v = document.querySelector('#view').getBoundingClientRect();
    return { cy: r.top + r.height / 2, bottom: v.bottom, cx: r.left + r.width / 2, mid: v.left + v.width / 2 };
  });
  check(!!toastPos && toastPos.cy > toastPos.bottom - 70 && Math.abs(toastPos.cx - toastPos.mid) < 130,
    'plain messages sit at the bottom of the scene');

  // --- blossoms mist (neglected trees drop leaves — restore health so blossoms render)
  await page.evaluate(() => { __bonsai.res.health = 80; });
  await sleep(400);
  const mistT0 = await page.evaluate(() => __bonsai.res.mist);
  const findBlossom = () => page.evaluate(() => {
    const t = __bonsai.tree;
    const r = document.querySelector('#view').getBoundingClientRect();
    for (const s of t.segs.values()) {
      if (s.children.length || t.leafRadius(s) < 2.3) continue;
      const p = __bonsai.project(s.end);
      const cx = r.left + (p.x / 176) * r.width, cy = r.top + (p.y / 176) * r.height;
      const hit = __bonsai.pick(cx, cy);
      if (hit && hit.kind === 'leaf') return { x: cx, y: cy, id: hit.segId };
    }
    return null;
  });
  const blossomPt = await findBlossom();
  check(!!blossomPt, 'found a visible blossom to tap');
  if (blossomPt) {
    await page.mouse.move(blossomPt.x, blossomPt.y);
    await sleep(250);
    const mistHover = await page.evaluate(() => ({
      h: document.querySelector('#view').dataset.hover,
      c: getComputedStyle(document.querySelector('#view')).cursor,
    }));
    check(mistHover.h === 'leaf' && /svg/.test(mistHover.c), 'blossom hover shows the spray-bottle cursor');
    // re-find right before clicking: the live sim may have grown/shifted the canopy
    const blossomNow = (await findBlossom()) || blossomPt;
    await page.mouse.click(blossomNow.x, blossomNow.y);
    await sleep(250);
    const mistT1 = await page.evaluate(() => __bonsai.res.mist);
    check(mistT1 > mistT0, `blossom tap mists the tree (${mistT0.toFixed(0)} → ${mistT1.toFixed(0)})`);
    // …and a lone 🍃 TRIM button appears at the pad (like cut/wire, no message)
    const padMenu = await page.evaluate((id) => ({
      open: !document.querySelector('#branch-menu').classList.contains('hidden'),
      trimVisible: !document.querySelector('#bm-trim').classList.contains('hidden'),
      cutHidden: document.querySelector('#bm-cut').classList.contains('hidden'),
      r: __bonsai.tree.leafRadius(__bonsai.tree.segs.get(id)),
    }), blossomNow.id);
    check(padMenu.open && padMenu.trimVisible && padMenu.cutHidden, 'pad tap shows a lone TRIM button');
    if (padMenu.open && padMenu.trimVisible) {
      await page.evaluate(() => document.querySelector('#bm-trim').click());
      await sleep(300);
      const rAfter = await page.evaluate((id) => __bonsai.tree.leafRadius(__bonsai.tree.segs.get(id)), blossomNow.id);
      check(rAfter < padMenu.r, `TRIM button pinched the pad (r ${padMenu.r.toFixed(1)} → ${rAfter.toFixed(1)})`);
    }
    let openNow = false;
    for (let att = 0; att < 2 && !openNow; att++) {   // taps can miss on canopy drift
      const blossom2 = await findBlossom();
      if (!blossom2) break;
      await page.mouse.click(blossom2.x, blossom2.y);
      await sleep(300);
      openNow = await page.evaluate(() => !document.querySelector('#branch-menu').classList.contains('hidden'));
    }
    if (openNow) {
      await sleep(5300);
      const openLater = await page.evaluate(() => !document.querySelector('#branch-menu').classList.contains('hidden'));
      check(!openLater, 'the TRIM option disappears by itself after 5 seconds');
    } else {
      check(true, 'no pad menu opened for the auto-hide check — skipped');
    }
  }

  // --- zen sand: rake cursor + raking draws into the sand without rotating the pot
  await page.keyboard.press('Escape');    // clear any stray branch menu first
  await page.keyboard.press('ArrowLeft');
  await sleep(200);
  const sandPts = await page.evaluate(() => {
    const v = document.querySelector('#view');
    const r = v.getBoundingClientRect();
    const out = [];
    for (const [lx, lz] of [[20, 18], [-20, 18], [24, -6], [-24, -8], [16, 22], [-16, 22]]) {
      const p = __bonsai.projectLocal(lx, 0.2, lz);
      const cx = r.left + (p.x / v.width) * r.width, cy = r.top + (p.y / v.height) * r.height;
      const s = __bonsai.sceneAt(cx, cy);
      if (s && s.target === 'sand') out.push({ x: cx, y: cy });
      if (out.length >= 2) break;
    }
    return out;
  });
  check(sandPts.length >= 2, `found sand to rake (${sandPts.length} points)`);
  if (sandPts.length >= 2) {
    await page.mouse.move(sandPts[0].x, sandPts[0].y);
    await sleep(250);
    const sandHover = await page.evaluate(() => ({
      h: document.querySelector('#view').dataset.hover,
      c: getComputedStyle(document.querySelector('#view')).cursor,
    }));
    check(sandHover.h === 'sand' && /svg/.test(sandHover.c), 'sand hover shows the rake cursor');
    const sum0 = await page.evaluate(() => __bonsai.sandSum());
    const thS0 = await page.evaluate(() => __bonsai.theta);
    await page.mouse.down();
    await page.mouse.move(sandPts[1].x, sandPts[1].y, { steps: 8 });
    await page.mouse.up();
    await sleep(250);
    const sum1 = await page.evaluate(() => __bonsai.sandSum());
    const thS1 = await page.evaluate(() => __bonsai.theta);
    check(sum1 !== sum0, 'raking changed the sand pattern');
    check(Math.abs(thS1 - thS0) < 0.05, 'raking does not rotate the pot');
  }

  // --- water = tap the open air (outside the branches / above the tree)
  const waterT0 = await page.evaluate(() => __bonsai.res.water);
  const skyPt = await page.evaluate(() => {
    const r = document.querySelector('#view').getBoundingClientRect();
    const cands = [[0.12, 0.12], [0.5, 0.06], [0.85, 0.3], [0.1, 0.5], [0.9, 0.55]];
    for (const [fx, fy] of cands) {
      const cx = r.left + r.width * fx, cy = r.top + r.height * fy;
      if (!__bonsai.sceneAt(cx, cy)) return { x: cx, y: cy };
    }
    return null;
  });
  check(!!skyPt, 'found open air to tap');
  if (skyPt) {
    await page.mouse.move(skyPt.x, skyPt.y);
    await sleep(300);
    const hov = await page.evaluate(() => ({
      h: document.querySelector('#view').dataset.hover,
      c: getComputedStyle(document.querySelector('#view')).cursor,
    }));
    check(hov.h === 'sky' && /svg/.test(hov.c), 'open-air hover shows the water-drop cursor');
    await page.mouse.click(skyPt.x, skyPt.y);
    await sleep(250);
    const waterT1 = await page.evaluate(() => __bonsai.res.water);
    check(waterT1 > waterT0, `open-air tap waters the tree (${waterT0.toFixed(0)} → ${waterT1.toFixed(0)})`);
  }

  // --- branch tap → contextual ✂️/➰ menu
  const findBranchTap = () => page.evaluate(() => {
    const t = __bonsai.tree;
    const r = document.querySelector('#view').getBoundingClientRect();
    for (const s of t.segs.values()) {
      if (s.pid === null || s.cut || s.order < 1 || s.thick > 5) continue;
      const mid = [(s.start[0] + s.end[0]) / 2, (s.start[1] + s.end[1]) / 2, (s.start[2] + s.end[2]) / 2];
      const p = __bonsai.project(mid);
      const cx = r.left + (p.x / 176) * r.width, cy = r.top + (p.y / 176) * r.height;
      const hit = __bonsai.pick(cx, cy);
      if (hit && (hit.kind === 'wood' || hit.kind === 'wire') && hit.segId === s.id) return { x: cx, y: cy, id: s.id };
    }
    return null;
  });
  const menuHidden = () => page.evaluate(() => document.querySelector('#branch-menu').classList.contains('hidden'));

  const bt1 = await findBranchTap();
  check(!!bt1, 'found a visible branch for the menu');
  if (bt1) {
    await page.mouse.click(bt1.x, bt1.y);
    await sleep(250);
    check(!(await menuHidden()), 'branch tap opens the ✂️/➰ menu');
    const segsPre = await page.evaluate(() => __bonsai.tree.segs.size);
    await page.click('#bm-cut');
    await sleep(300);
    const cutState = await page.evaluate((id) => ({
      segs: __bonsai.tree.segs.size,
      stub: __bonsai.tree.segs.get(id) ? __bonsai.tree.segs.get(id).cut : 'gone',
    }), bt1.id);
    check((await menuHidden()) && cutState.segs <= segsPre && cutState.stub === true, 'menu CUT pruned the branch');
    const undone = await page.evaluate(() => { const b = document.querySelector('.toast button'); if (b) { b.click(); return true; } return false; });
    await sleep(200);
    check(undone, 'cut-from-menu offered undo');
  }

  const bt2 = await findBranchTap();
  check(!!bt2, 'found a branch for menu wire');
  if (bt2) {
    await page.mouse.click(bt2.x, bt2.y);
    await sleep(200);
    await page.click('#bm-wire');
    await sleep(250);
    const wres = await page.evaluate((id) => ({ mode: __bonsai.mode, wired: __bonsai.tree.segs.get(id).wired }), bt2.id);
    check(wres.wired === true && wres.mode === 'wire', 'menu WIRE wired the branch and armed the wire tool');
    await page.keyboard.press('Escape');
    await sleep(150);
    await page.mouse.click(bt2.x, bt2.y);
    await sleep(200);
    const reopened = !(await menuHidden());
    const wBefore = await page.evaluate(() => __bonsai.res.water);
    if (reopened && skyPt) {
      await page.mouse.click(skyPt.x, skyPt.y);
      await sleep(200);
      const wAfter = await page.evaluate(() => __bonsai.res.water);
      check((await menuHidden()) && Math.abs(wAfter - wBefore) < 1, 'clicking away dismisses the menu without watering');
    } else {
      check(reopened, 'menu reopened for dismissal test');
    }
  }

  // --- trim tool: pinch a blossom pad → smaller pad, ramification boost, no mist
  await page.click('#btn-trim');
  await sleep(150);
  const trimCursor = await page.evaluate(() => getComputedStyle(document.querySelector('#view')).cursor);
  check(/svg/.test(trimCursor), 'trim mode shows the pinching-shears cursor');
  const trimTarget = await page.evaluate(() => {
    const t = __bonsai.tree;
    const r = document.querySelector('#view').getBoundingClientRect();
    for (const s of t.segs.values()) {
      if (s.children.length || s.cut || t.leafRadius(s) < 2.5) continue;
      const p = __bonsai.project(s.end);
      const cx = r.left + (p.x / 176) * r.width, cy = r.top + (p.y / 176) * r.height;
      const hit = __bonsai.pick(cx, cy);
      if (hit && hit.kind === 'leaf' && hit.segId === s.id) {
        return { x: cx, y: cy, id: s.id, r: t.leafRadius(s), bb: s.budBoost };
      }
    }
    return null;
  });
  check(!!trimTarget, 'found a full pad to pinch');
  if (trimTarget) {
    const mistPre = await page.evaluate(() => __bonsai.res.mist);
    await page.mouse.click(trimTarget.x, trimTarget.y);
    await sleep(300);
    const trimmed = await page.evaluate((id) => {
      const s = __bonsai.tree.segs.get(id);
      return { r: __bonsai.tree.leafRadius(s), bb: s.budBoost, mist: __bonsai.res.mist };
    }, trimTarget.id);
    check(trimmed.r < trimTarget.r && trimmed.bb > trimTarget.bb,
      `pinch shrank the pad (r ${trimTarget.r.toFixed(1)} → ${trimmed.r.toFixed(1)}) and boosted ramification`);
    check(Math.abs(trimmed.mist - mistPre) < 5, 'pinching did not trigger a mist');
  }
  await page.keyboard.press('Escape');
  await sleep(150);

  // --- grab a placed wire in view mode: dragging the coil bends the branch directly
  if (bt2) {
    const coilPt = await page.evaluate((id) => {
      const v = document.querySelector('#view');
      const r = v.getBoundingClientRect();
      const s = __bonsai.tree.segs.get(id);
      if (!s || !s.wired) return null;
      const mid = [(s.start[0] + s.end[0]) / 2, (s.start[1] + s.end[1]) / 2, (s.start[2] + s.end[2]) / 2];
      const p = __bonsai.project(mid);
      const bx = r.left + (p.x / v.width) * r.width, by = r.top + (p.y / v.height) * r.height;
      for (let oy = -14; oy <= 14; oy += 2) {
        for (let ox = -14; ox <= 14; ox += 2) {
          const hit = __bonsai.sceneAt(bx + ox, by + oy);
          if (hit && hit.target === 'wire' && hit.segId === id) return { x: bx + ox, y: by + oy };
        }
      }
      return null;
    }, bt2.id);
    check(!!coilPt, 'found the placed wire coil to grab');
    if (coilPt) {
      await page.mouse.move(coilPt.x, coilPt.y);
      await sleep(250);
      const coilHover = await page.evaluate(() => document.querySelector('#view').dataset.hover);
      check(coilHover === 'wire', 'hovering the coil shows the wire handle cursor');
      // multiple drag attempts with a FRESH coil lookup each time (the branch
      // moves when bent, and a single direction can be geometrically degenerate)
      const findCoilFresh = () => page.evaluate((sid) => {
        const v = document.querySelector('#view');
        const r = v.getBoundingClientRect();
        const s = __bonsai.tree.segs.get(sid);
        if (!s || !s.wired) return null;
        const mid = [(s.start[0] + s.end[0]) / 2, (s.start[1] + s.end[1]) / 2, (s.start[2] + s.end[2]) / 2];
        const p = __bonsai.project(mid);
        const bx = r.left + (p.x / v.width) * r.width, by = r.top + (p.y / v.height) * r.height;
        for (let oy = -14; oy <= 14; oy += 2) {
          for (let ox = -14; ox <= 14; ox += 2) {
            const hit = __bonsai.sceneAt(bx + ox, by + oy);
            if (hit && hit.target === 'wire' && hit.segId === sid) return { x: bx + ox, y: by + oy };
          }
        }
        return null;
      }, bt2.id);
      let movedDir = false;
      for (const [ddx, ddy] of [[0, -28], [26, -8], [-24, 12]]) {
        const cp = (await findCoilFresh()) || coilPt;
        const before = await page.evaluate((id) => __bonsai.tree.segs.get(id).dir.slice(), bt2.id);
        await page.mouse.move(cp.x, cp.y);
        await page.mouse.down();
        await page.mouse.move(cp.x + ddx, cp.y + ddy, { steps: 8 });
        await page.mouse.up();
        await sleep(200);
        const a = await page.evaluate((id) => __bonsai.tree.segs.get(id).dir.slice(), bt2.id);
        if (Math.abs(a[0] - before[0]) + Math.abs(a[1] - before[1]) + Math.abs(a[2] - before[2]) > 0.01) { movedDir = true; break; }
      }
      const modeAfterCoil = await page.evaluate(() => __bonsai.mode);
      check(movedDir && modeAfterCoil === 'view', 'dragging the coil bent the branch without leaving view mode');

      // tap the coil → UNWIRE → warning (not set yet) → confirm → the branch springs back
      const readSpring = (id) => page.evaluate((sid) => {
        const s = __bonsai.tree.segs.get(sid);
        const n = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
        const a = n(s.dir), b = n(s.dir0);
        return {
          dir0: s.dir0.slice(),
          angle: Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))),
        };
      }, id);
      let spring0 = await readSpring(bt2.id);
      if (spring0.angle < 0.06) {   // ensure a meaningful bend so the warning path triggers
        await page.evaluate((id) => {
          __bonsai.tree.bend(id, [0, 0, 1], 0.18);
          __bonsai.tree.bend(id, [1, 0, 0], 0.18);
        }, bt2.id);
        await sleep(200);
        spring0 = await readSpring(bt2.id);
      }
      // find the coil AFTER any bending — the branch moves with it
      const coil2 = await page.evaluate((id) => {
        const v = document.querySelector('#view');
        const r = v.getBoundingClientRect();
        const s = __bonsai.tree.segs.get(id);
        if (!s || !s.wired) return null;
        const mid = [(s.start[0] + s.end[0]) / 2, (s.start[1] + s.end[1]) / 2, (s.start[2] + s.end[2]) / 2];
        const p = __bonsai.project(mid);
        const bx = r.left + (p.x / v.width) * r.width, by = r.top + (p.y / v.height) * r.height;
        for (let oy = -14; oy <= 14; oy += 2) {
          for (let ox = -14; ox <= 14; ox += 2) {
            const hit = __bonsai.sceneAt(bx + ox, by + oy);
            if (hit && hit.target === 'wire' && hit.segId === id) return { x: bx + ox, y: by + oy };
          }
        }
        return null;
      }, bt2.id);
      check(!!coil2, 'found the coil again after bending');
      let coilMenuOpen = false;
      if (coil2) {
        await page.mouse.click(coil2.x, coil2.y);
        await sleep(250);
        coilMenuOpen = await page.evaluate(() => !document.querySelector('#branch-menu').classList.contains('hidden'));
      }
      check(coilMenuOpen, 'coil tap opens the menu');
      if (coilMenuOpen) {
        const unwireState = await page.evaluate(() => ({
          label: document.querySelector('#bm-wire').textContent,
          distinct: document.querySelector('#bm-wire').classList.contains('unwire'),
        }));
        check(/UNWIRE/.test(unwireState.label) && unwireState.distinct, 'menu offers UNWIRE with its distinct color');
        await page.evaluate(() => document.querySelector('#bm-wire').click());
        await sleep(250);
        const confirmBtn = await page.evaluate(() => {
          const b = document.querySelector('.toast button');
          return b ? b.textContent : null;
        });
        check(confirmBtn === 'REMOVE', 'early unwire warns and asks for confirmation');
        const stillWired = await page.evaluate((id) => __bonsai.tree.segs.get(id).wired, bt2.id);
        check(stillWired === true, 'wire stays on until the warning is confirmed');
        const confirmed = await page.evaluate(() => {
          const b = document.querySelector('.toast button');
          if (b) { b.click(); return true; }
          return false;
        });
        check(confirmed, 'confirmed the removal');
        await sleep(2000);   // spring-back animation
        const springEnd = await page.evaluate((args) => {
          const s = __bonsai.tree.segs.get(args.id);
          const n = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
          const a = n(s.dir), b = n(args.dir0);
          return {
            wired: s.wired,
            angle: Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))),
          };
        }, { id: bt2.id, dir0: spring0.dir0 });
        check(springEnd.wired === false && springEnd.angle < Math.max(0.02, spring0.angle * 0.5),
          `unset branch sprang back toward its original direction (${spring0.angle.toFixed(2)} → ${springEnd.angle.toFixed(2)} rad)`);
      }
    }
  }

  // --- prune tool: cursor + click a blossom tip
  await page.click('#btn-prune');
  const pruneCursor = await page.evaluate(() => getComputedStyle(document.querySelector('#view')).cursor);
  check(/svg/.test(pruneCursor), 'prune mode turns the cursor into the scissors tool');
  const target = await page.evaluate(() => {
    const t = __bonsai.tree;
    let best = null;
    for (const s of t.segs.values()) {
      if (!s.children.length && t.leafRadius(s) >= 2 && !(s.order === 0)) { best = s; break; }
    }
    if (!best) return null;
    const p = __bonsai.project(best.end);
    return { x: p.x, y: p.y, id: best.id, segs: t.segs.size };
  });
  check(!!target, 'found a blossom tip to prune');
  if (target) {
    const cx = rect.left + (target.x / 176) * rect.w;
    const cy = rect.top + (target.y / 176) * rect.h;
    const picked = await page.evaluate((px, py) => __bonsai.pick(px, py), cx, cy);
    check(picked && picked.segId !== undefined, `raycast pick hit seg ${picked && picked.segId} (aimed at ${target.id})`);
    await page.mouse.click(cx, cy);
    await sleep(250);
    const after = await page.evaluate(() => __bonsai.tree.segs.size);
    check(after <= target.segs, `prune click: ${target.segs} → ${after} segs`);
    const hadUndo = await page.evaluate(() => { const b = document.querySelector('.toast button'); if (b) { b.click(); return true; } return false; });
    await sleep(200);
    const restored = await page.evaluate(() => __bonsai.tree.segs.size);
    check(hadUndo && restored === target.segs, `undo toast restored ${restored} segs`);
  }

  // --- wire tool: cursor + click a low branch and drag to bend, then auto-release
  await page.click('#btn-wire');
  await sleep(400); // wire mode shrinks puffs → rebuild
  const wireCursor = await page.evaluate(() => getComputedStyle(document.querySelector('#view')).cursor);
  check(/svg/.test(wireCursor), 'wire mode turns the cursor into the wire tool');
  const viewCursorBack = await page.evaluate(() => {
    const v = document.querySelector('#view');
    const m = v.dataset.mode;
    v.dataset.mode = 'view';
    const c = getComputedStyle(v).cursor;
    v.dataset.mode = m;
    return c;
  });
  check(/grab/.test(viewCursorBack), 'view mode returns to the grab cursor');
  await page.evaluate(() => { for (const t of document.querySelectorAll('.toast')) t.remove(); });
  const findWireTarget = () => page.evaluate(() => {
    const t = __bonsai.tree;
    const r = document.querySelector('#view').getBoundingClientRect();
    const cands = [];
    for (const s of t.segs.values()) {
      if (s.pid === null || s.cut || s.order < 1 || s.wired) continue;
      if (s.end[1] > 26) continue;
      cands.push(s);
    }
    cands.sort((a, b) => (b.thick - b.end[1] * 0.02) - (a.thick - a.end[1] * 0.02));
    for (const s of cands) {   // pick-validated: the click must land on THIS branch
      const mid = [(s.start[0] + s.end[0]) / 2, (s.start[1] + s.end[1]) / 2, (s.start[2] + s.end[2]) / 2];
      const p = __bonsai.project(mid);
      const cx = r.left + (p.x / 176) * r.width, cy = r.top + (p.y / 176) * r.height;
      const hit = __bonsai.pick(cx, cy);
      if (hit && hit.segId === s.id) return { x: cx, y: cy, id: s.id, dir: s.dir.slice() };
    }
    return null;
  });
  let wireT = null, wireRes = null;
  for (let attempt = 0; attempt < 2 && !wireRes; attempt++) {
    const m = await page.evaluate(() => __bonsai.mode);
    if (m !== 'wire') { await page.click('#btn-wire'); await sleep(300); }
    wireT = await findWireTarget();
    if (!wireT) break;
    await page.mouse.move(wireT.x, wireT.y);
    await page.mouse.down();
    await page.mouse.move(wireT.x, wireT.y - 30, { steps: 8 });
    await page.mouse.up();
    await sleep(250);
    const res = await page.evaluate((id) => {
      const s = __bonsai.tree.segs.get(id);
      return s ? { wired: s.wired, dir: s.dir.slice() } : null;
    }, wireT.id);
    if (res && res.wired) wireRes = res;
  }
  check(!!wireT, 'found a branch to wire');
  check(!!wireRes, 'drag attached wire to the branch');
  if (wireRes && wireT) {
    const moved = (Math.abs(wireRes.dir[0] - wireT.dir[0]) + Math.abs(wireRes.dir[1] - wireT.dir[1]) + Math.abs(wireRes.dir[2] - wireT.dir[2])) > 0.01;
    check(moved, 'drag bent the branch');
    const modeAfterBend = await page.evaluate(() => __bonsai.mode);
    check(modeAfterBend === 'view', 'finishing the bend returns to normal mode automatically');
    const hasWireVox = await page.evaluate(() => {
      const built = Bonsai.Voxels.buildTree(__bonsai.tree, { puffScale: 0.6 });
      return built.voxels.some(v => v.kind === 'wire');
    });
    check(hasWireVox, 'wire coil voxels render on the branch');
    const setRes = await page.evaluate((id) => {
      const s = __bonsai.tree.segs.get(id);
      if (!s) return null;
      const needH = __bonsai.tree.wireSetHours(s);
      __bonsai.tree.ageWires(needH + 2);      // fast-forward the training months
      return { wired: s.wired, set: s.wireAge >= needH, months: needH / 720 };
    }, wireT.id);
    check(!!setRes && setRes.wired === true && setRes.set === true,
      `wire STAYS on after setting (~${setRes ? setRes.months.toFixed(1) : '?'}mo) — removal is up to the user`);
  }

  await page.keyboard.press('Escape');   // leave wire mode so canvas drags rotate/pan
  await sleep(120);

  // --- right-click cancels any tool / menu
  await page.click('#btn-wire');
  await sleep(150);
  await page.mouse.click(rect.left + rect.w / 2, rect.top + 20, { button: 'right' });
  await sleep(150);
  const rcMode = await page.evaluate(() => __bonsai.mode);
  check(rcMode === 'view', 'right-click exits the wire tool');
  const bt3 = await findBranchTap();
  if (bt3) {
    await page.mouse.click(bt3.x, bt3.y);
    await sleep(250);
    const openedRc = !(await menuHidden());
    await page.mouse.click(bt3.x, bt3.y, { button: 'right' });
    await sleep(150);
    check(openedRc && (await menuHidden()), 'right-click closes the branch menu');
  } else {
    check(true, 'no branch for right-click menu test — skipped');
  }

  // --- FEED / MIST buttons
  const meters0 = await page.evaluate(() => ({ food: __bonsai.res.food, mist: __bonsai.res.mist }));
  await page.click('#btn-feed');
  await page.click('#btn-mist');
  await sleep(150);
  const meters = await page.evaluate(() => ({ food: __bonsai.res.food, mist: __bonsai.res.mist }));
  check(meters.food > meters0.food, `FEED raised food ${meters0.food.toFixed(0)} → ${meters.food.toFixed(0)}`);
  check(meters.mist > meters0.mist, `MIST raised humidity ${meters0.mist.toFixed(0)} → ${meters.mist.toFixed(0)}`);
  const plainCount = await page.evaluate(() => document.querySelectorAll('#toasts .toast:not(.has-action)').length);
  check(plainCount === 1, `plain messages never stack (${plainCount} visible after two quick actions)`);

  // --- zoom: wheel, pan on the pot, buttons, recenter
  await page.evaluate(() => { for (const t of document.querySelectorAll('.toast')) t.remove(); });
  const z0 = await page.evaluate(() => __bonsai.zoom);
  await page.mouse.move(rect.left + rect.w / 2, rect.top + rect.h / 2);
  await page.mouse.wheel({ deltaY: -400 });
  await sleep(150);
  const z1 = await page.evaluate(() => __bonsai.zoom);
  check(z1 > z0, `wheel zoomed in ${z0.toFixed(2)} → ${z1.toFixed(2)}`);

  const rimPt = toCss(await page.evaluate(() => __bonsai.projectLocal(11, 9.9, 0)));
  await page.mouse.move(rimPt.x, rimPt.y);
  await page.mouse.down();
  await page.mouse.move(rimPt.x, rimPt.y - 70, { steps: 6 });
  await page.mouse.up();
  await sleep(150);
  const pan1 = await page.evaluate(() => __bonsai.panY);
  check(Math.abs(pan1) > 0.5, `pot drag panned the view while zoomed (panY ${pan1.toFixed(1)})`);

  await page.click('#zoom-out');
  await page.click('#zoom-out');
  await sleep(150);
  const z2 = await page.evaluate(() => __bonsai.zoom);
  check(z2 < z1, `zoom buttons zoomed out ${z1.toFixed(2)} → ${z2.toFixed(2)}`);
  for (let i = 0; i < 4; i++) await page.click('#zoom-out');
  await sleep(150);
  const recenter = await page.evaluate(() => ({ z: __bonsai.zoom, p: __bonsai.panY }));
  check(recenter.z <= 1.01 && Math.abs(recenter.p) < 0.01,
    `zooming out re-centers the view (zoom ${recenter.z.toFixed(2)}, panY ${recenter.p.toFixed(2)})`);
  await page.click('#zoom-in');
  await page.click('#zoom-in');
  await sleep(120);

  // --- future preview
  const nowSegs = await page.evaluate(() => __bonsai.tree.segs.size);
  await page.click('#btn-future');
  await sleep(600);
  const p2 = await page.evaluate(() => ({ years: __bonsai.preview, stats: __bonsai.previewStats() }));
  check(p2.years === 2, 'FUTURE button opened the +2y vision');
  check(p2.stats && p2.stats.segments >= nowSegs, `+2y vision has ${p2.stats && p2.stats.segments} segs (now ${nowSegs})`);
  await page.click('#future-bar button[data-years="4"]');
  await sleep(600);
  const p4 = await page.evaluate(() => ({ years: __bonsai.preview, stats: __bonsai.previewStats() }));
  check(p4.years === 4, 'switched to the +4y vision');
  check(p4.stats.tips >= p2.stats.tips, `+4y fuller than +2y (tips ${p2.stats.tips} → ${p4.stats.tips})`);
  await page.click('#future-bar button[data-years="9"]');
  await sleep(1200);
  const p9 = await page.evaluate(() => ({ years: __bonsai.preview, stats: __bonsai.previewStats() }));
  check(p9.years === 9, 'switched to the +9y vision');
  check(p9.stats.tips >= p4.stats.tips, `+9y fuller than +4y (tips ${p4.stats.tips} → ${p9.stats.tips})`);
  const waterBefore = await page.evaluate(() => __bonsai.res.water);
  await page.click('#btn-water');
  await sleep(150);
  const waterAfter = await page.evaluate(() => __bonsai.res.water);
  check(Math.abs(waterAfter - waterBefore) < 0.5, 'care actions are blocked during the vision');
  await page.click('#future-bar button[data-years="0"]');
  await sleep(300);
  const pBack = await page.evaluate(() => ({ years: __bonsai.preview, segs: __bonsai.tree.segs.size }));
  check(pBack.years === 0 && pBack.segs === nowSegs, 'NOW returns to the live tree unchanged');
  await page.click('#btn-future'); // close the bar
  await sleep(150);

  // --- persistence: reload and compare
  const preReload = await page.evaluate(() => ({ segs: __bonsai.tree.segs.size, water: Math.round(__bonsai.res.water), sand: __bonsai.sandSum() }));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction('window.__bonsai && window.__bonsai.tree', { timeout: 12000 });
  await sleep(800);
  const postReload = await page.evaluate(() => ({ segs: __bonsai.tree.segs.size, water: Math.round(__bonsai.res.water), sand: __bonsai.sandSum() }));
  check(postReload.segs === preReload.segs, `reload restored the tree (${postReload.segs} segs)`);
  check(Math.abs(postReload.water - preReload.water) <= 2, `reload restored meters (water ${postReload.water})`);
  check(postReload.sand === preReload.sand, 'reload restored the raked sand');

  // --- wallpaper mode: fullscreen widescreen scene, UI hidden, cut & wire usable
  const wp = await browser.newPage();
  await wp.setViewport({ width: 1600, height: 900 });
  wp.on('pageerror', e => errors.push('wallpaper pageerror: ' + e.message));
  await wp.goto(URL + '#wallpaper', { waitUntil: 'load' });
  await wp.waitForFunction('window.__bonsai && window.__bonsai.tree', { timeout: 12000 });
  await sleep(800);
  const wpState = await wp.evaluate(() => ({
    cls: document.documentElement.classList.contains('wallpaper'),
    headerHidden: getComputedStyle(document.querySelector('header')).display === 'none',
    actionsHidden: getComputedStyle(document.querySelector('#actions')).display === 'none',
    bufW: document.querySelector('#view').width,
    bufH: document.querySelector('#view').height,
    cssW: document.querySelector('#view').getBoundingClientRect().width,
  }));
  check(wpState.cls && wpState.headerHidden && wpState.actionsHidden, 'wallpaper mode hides the UI chrome');
  check(wpState.bufH === 176 && wpState.bufW >= 300 && wpState.bufW <= 330,
    `wallpaper buffer follows the screen aspect (${wpState.bufW}×${wpState.bufH})`);
  check(Math.abs(wpState.cssW - 1600) < 4, `scene fills the screen edge to edge (${Math.round(wpState.cssW)}px)`);

  const wpBranch = await wp.evaluate(() => {
    const t = __bonsai.tree;
    const v = document.querySelector('#view');
    const r = v.getBoundingClientRect();
    for (const s of t.segs.values()) {
      if (s.pid === null || s.cut || s.order < 1 || s.thick > 5 || s.wired) continue;
      const mid = [(s.start[0] + s.end[0]) / 2, (s.start[1] + s.end[1]) / 2, (s.start[2] + s.end[2]) / 2];
      const p = __bonsai.project(mid);
      const cx = r.left + (p.x / v.width) * r.width, cy = r.top + (p.y / v.height) * r.height;
      const hit = __bonsai.pick(cx, cy);
      if (hit && hit.kind === 'wood' && hit.segId === s.id) return { x: cx, y: cy, id: s.id };
    }
    return null;
  });
  check(!!wpBranch, 'wallpaper: found a branch to tap');
  if (wpBranch) {
    await wp.mouse.click(wpBranch.x, wpBranch.y);
    await sleep(300);
    const wpMenu = await wp.evaluate(() => {
      const m = document.querySelector('#branch-menu');
      return !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none';
    });
    check(wpMenu, 'wallpaper: branch ✂️/➰ menu opens and is visible');
    await wp.click('#bm-wire');
    await sleep(300);
    const wpWire = await wp.evaluate((id) => ({
      mode: __bonsai.mode,
      wired: __bonsai.tree.segs.get(id).wired,
      toastShown: !!document.querySelector('.toast') && getComputedStyle(document.querySelector('#toasts')).display !== 'none',
    }), wpBranch.id);
    check(wpWire.wired === true && wpWire.mode === 'wire' && wpWire.toastShown,
      'wallpaper: menu WIRE wires the branch with a visible toast');
    const wpSky = await wp.evaluate(() => {
      const r = document.querySelector('#view').getBoundingClientRect();
      for (const [fx, fy] of [[0.08, 0.1], [0.92, 0.12], [0.1, 0.5], [0.5, 0.05]]) {
        const cx = r.left + r.width * fx, cy = r.top + r.height * fy;
        if (!__bonsai.sceneAt(cx, cy)) return { x: cx, y: cy };
      }
      return null;
    });
    if (wpSky) {
      await wp.mouse.click(wpSky.x, wpSky.y);
      await sleep(250);
      const modeAfter = await wp.evaluate(() => __bonsai.mode);
      check(modeAfter === 'view', 'wallpaper: tapping empty space puts the wire tool away');
    } else {
      check(true, 'wallpaper: no open air found this run — exit check skipped');
    }
  }
  await wp.close();

  await browser.close();
  console.log(results.join('\n'));
  if (errors.length) { console.log('PAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
  console.log(okAll.fail ? 'E2E: FAILURES ABOVE' : `E2E PASS — ${okAll.n} checks, no page errors`);
  process.exit(okAll.fail ? 1 : 0);
})().catch(e => { console.error('E2E crashed:', e); process.exit(1); });
