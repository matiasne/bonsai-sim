/* OpenSea-iframe compatibility test — proves the tokenURI animation_url path.

   Marketplaces render a living token by loading its animation_url (the game's
   #dna= viewer) inside a CROSS-ORIGIN iframe with sandbox="allow-scripts" and
   no allow-same-origin: the page runs from an OPAQUE origin where any
   localStorage/sessionStorage touch throws SecurityError and no cookies exist.
   This harness reproduces exactly that: two local HTTP origins (site +
   "marketplace"), the real index.html embedded in the real sandbox, driven by
   real Chrome. If the tree renders here, it renders on OpenSea.

   Run: npm run opensea   (needs installed Chrome, like e2e) */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

require(path.join(__dirname, '..', 'js', 'fmath.js'));
require(path.join(__dirname, '..', 'js', 'tree.js'));
require(path.join(__dirname, '..', 'js', 'sim.js'));
const B = globalThis.Bonsai;
const SIM = B.Sim;

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.join(__dirname, '..');
const SITE_PORT = 8931, MARKET_PORT = 8932;

const results = [];
const okAll = { n: 0, fail: false };
function check(cond, label) {
  results.push((cond ? '  ✓ ' : '  ✗ FAIL ') + label);
  if (cond) okAll.n++; else okAll.fail = true;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml',
};

// The deployed site (mydigitalbonsai.com is static — this is an exact stand-in).
function siteServer() {
  return http.createServer((req, res) => {
    const url = req.url.split(/[?#]/)[0];
    const file = path.join(ROOT, url === '/' ? 'index.html' : url.slice(1));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
}

// The "marketplace": a DIFFERENT origin embedding the viewer in OpenSea's sandbox.
function marketServer(viewerUrl) {
  const html = `<!doctype html><meta charset="utf-8"><title>fake marketplace</title>
<style>body{margin:0;background:#222}iframe{width:600px;height:600px;border:0;display:block;margin:24px auto}</style>
<iframe id="animation" sandbox="allow-scripts" src="${viewerUrl}"></iframe>`;
  return http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
}

(async () => {
  // A grown v3 tree, the same way the game would mint it: scripted care → envelope.
  const env = { v: 3, seed: 90210, g: Date.UTC(2026, 3, 1), s: 0, t: 0, e: [] };
  const st = SIM.newState({ seed: env.seed, g: env.g, v: 3 });
  const act = (ev) => { if (SIM.applyAction(st, ev).ok) env.e.push(ev); };
  for (let d = 0; d < 15; d++) {
    act(['W', st.simT]); if (d % 3 === 0) act(['F', st.simT]);
    SIM.advance(st, 43200, false);
    act(['W', st.simT]); act(['M', st.simT]);
    SIM.advance(st, 43200, false);
  }
  env.t = st.simT;
  const code = await SIM.dnaEncode(env);
  const expected = SIM.replay(env);
  const expectedSegs = expected.tree.segs.size;

  const site = siteServer().listen(SITE_PORT);
  const viewerUrl = `http://127.0.0.1:${SITE_PORT}/index.html#dna=${code}`;
  const market = marketServer(viewerUrl).listen(MARKET_PORT);

  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=800,720'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 700 });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => {
      if (m.type() === 'error' && !/net::|favicon|Failed to load resource/.test(m.text()))
        errors.push('console: ' + m.text());
    });

    await page.goto(`http://127.0.0.1:${MARKET_PORT}/`, { waitUntil: 'load' });
    const frame = await (await page.waitForSelector('#animation')).contentFrame();
    check(!!frame, 'marketplace page embeds the viewer iframe');

    // The harness must actually reproduce OpenSea's constraint, or this test proves nothing.
    const sandboxed = await frame.evaluate(() => {
      try { window.localStorage; return 'allowed'; } catch (e) { return 'blocked:' + e.name; }
    });
    check(sandboxed === 'blocked:SecurityError',
      `sandbox is real: localStorage throws in the opaque origin (${sandboxed})`);

    await frame.waitForFunction('window.__bonsai && window.__bonsai.viewer && window.__bonsai.tree', { timeout: 15000 });
    const v = await frame.evaluate(() => ({
      viewer: __bonsai.viewer,
      segs: __bonsai.tree.segs.size,
      simT: __bonsai.tree ? (window.__bonsai.res ? true : true) : false,
      canvas: (() => { const c = document.querySelector('canvas'); return c ? { w: c.width, h: c.height } : null; })(),
      clear: __bonsai.clearColor,
      status: (document.querySelector('#status-line') || {}).textContent || '',
    }));
    check(v.viewer === true, 'page booted in read-only viewer mode');
    check(v.segs === expectedSegs, `sandboxed replay re-derived the exact tree (${v.segs}/${expectedSegs} segs)`);
    check(!!v.canvas && v.canvas.w > 0, `WebGL canvas alive under swiftshader (${v.canvas && v.canvas.w}×${v.canvas && v.canvas.h})`);
    check(/read-only/.test(v.status), `viewer status shown ("${v.status.trim().slice(0, 60)}…")`);

    await sleep(1200);   // let a few frames render
    const shotDir = process.env.SHOT_DIR || __dirname;
    const shot = path.join(shotDir, 'opensea-render.png');
    const el = await page.$('#animation');
    await el.screenshot({ path: shot });
    const bytes = fs.statSync(shot).size;
    // a uniform/black iframe compresses to ~2–4 KB; a rendered tree is far bigger
    check(bytes > 20000, `iframe pixels are a real render, not a blank (${(bytes / 1024).toFixed(0)} KB png → ${shot})`);

    check(errors.length === 0, errors.length ? 'page errors: ' + errors.join(' | ') : 'no page errors inside the sandbox');
  } finally {
    await browser.close();
    site.close(); market.close();
  }

  console.log(results.join('\n'));
  if (okAll.fail) { console.error('OPENSEA-IFRAME FAIL'); process.exit(1); }
  console.log(`OPENSEA-IFRAME PASS — ${okAll.n} checks: the living viewer renders inside a marketplace sandbox`);
})().catch((e) => { console.error('FAIL —', e); process.exit(1); });
