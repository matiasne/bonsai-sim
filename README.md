# 🌸 Pixel Bonsai

A pixel-art **3D bonsai care simulation** for the browser. Your sakura bonsai grows
generatively in **real time**, driven by the **real weather** where you live — and it
keeps living while the page is closed.

![style](https://img.shields.io/badge/style-pixel%20art-ff9ecb) ![stack](https://img.shields.io/badge/stack-three.js%20%2B%20vanilla%20JS-blue)

## Run it

Just open `index.html` in a browser (double-click works — no build, no install).
The only network needs are the three.js CDN (first load) and the free weather APIs.

Optionally serve it instead:

```bash
npx serve .        # or: python3 -m http.server
```

## How to play

| Action | What it does |
|---|---|
| **drag the pot / ← →** | grab the pot itself to spin the tree (background drags do nothing) |
| **scroll / pinch / + −** | zoom in and out (buttons on the canvas, or the `+`/`-` keys) |
| **drag ↕ / ↑ ↓ keys** | when zoomed in, move the view up and down; zooming out re-centers |
| **〰️ rake the sand** | the pot sits in a zen sand tray — drag across it to rake patterns (tap = dimple; rain slowly smooths them; patterns rotate with the pot and are saved) |
| **right-click / esc** | put any tool away, close menus, cancel a drag |
| 🔮 **FUTURE** | preview your bonsai after **2–9 years** of good care — a deterministic vision grown from your exact tree (older visions: denser canopy, stockier trunk); nothing changes until you return to NOW |
| 💧 **WATER** | soil moisture — drains faster on hot, dry days (shortcut: **tap the open air** above/beside the tree) |
| 🌫 **MIST** | leaf humidity — nice-to-have, the tree loves it (shortcut: **tap the blossoms**) |
| 🧪 **FEED** | fertilizer speeds growth; overfeeding burns the roots (shortcut: **tap the pebbles**) |
| ✂️ **PRUNE** | click a branch/blossom to cut it — it buds back **denser** (real bonsai behavior) |
| 🍃 **TRIM** | pinch blossom pads (defoliation): they regrow **smaller and finer**, ramification densifies, and the opened crown catches light — a short growth boost, at a small vigor cost |
| ➰ **WIRE** | click a branch to wire it, **drag to bend** — releasing the bend puts the tool away; from then on **grab the copper coil to re-bend anytime** (tap the coil → menu → unwire). The wire must stay on **1–3 months** for the shape to hold (thin shoots set fastest, thick branches slowest, growing season helps), and **removal is always manual** — unwire after setting and the shape is kept; unwire early (after a warning) and the branch **springs back** proportionally |
| ⏩ | time-lapse one hour |
| ⚙ | set your city (weather), start a new tree |

**⚠️ It can die.** If health stays at rock bottom for ~4 days the bonsai withers for good —
gray wood, bare branches, care refused. You get a 🥀 *dying* warning with a countdown first,
and good care winds the countdown back. A dead tree can only be replaced (⚙ → 🌱 NEW TREE).

## Use it as a desktop wallpaper 🖼

Open **`wallpaper.html`** instead of `index.html` and you get just the living scene, edge to edge —
no buttons, widescreen-aware, slowly rotating when idle. The tree keeps growing, real weather keeps
working, and progress saves inside the wallpaper app.

**Windows — Wallpaper Engine** (Steam): copy this whole folder into
`...\steamapps\common\wallpaper_engine\projects\myprojects\bonsai-sim` — it ships a `project.json`,
so it appears under *Installed*. (Or: Wallpaper Editor → *Create Wallpaper* → pick `wallpaper.html`.)
Enable mouse input in the wallpaper's settings to interact with the tree.

**Windows — Lively Wallpaper** (free, Microsoft Store): drag `wallpaper.html` onto the Lively window
(or *Add Wallpaper* → *Browse*). A `LivelyInfo.json` is included for folder imports.

**macOS — Plash** (free, App Store): Plash → *Add Website* → paste the file URL
(`file:///path/to/bonsai-sim/wallpaper.html`) and grant folder access. Turn on *Browsing Mode*
whenever you want to water/prune/rotate; turn it off to click through to your desktop.

With input enabled you can do **everything right on the desktop**: drag the pot, tap to
water/mist/feed — and tap a branch for the ✂️ cut / ➰ wire menu (cut offers a brief UNDO;
after wiring, drag the branch to bend, then tap empty space to put the tool away).

**Same tree, live-synced:** once you **keep** (mint) a bonsai, open ⚙ → *🖼 PUT ON MY
DESKTOP* to copy a personalized wallpaper link that carries your tree. When the wallpaper
and your browser load from the **same site** (both `mydigitalbonsai.com`, or both the same
local folder), they share one living tree in real time — water or prune it on the desktop
and the browser reflects it instantly, and vice-versa. One context advances time (leader);
the other mirrors and forwards your care to it, so the tree never forks. If a wallpaper app
sandboxes its storage (so it can't be shared), it simply keeps its own bonsai and the
settings panel says so.

**Backgrounds:** ⚙ → *background* offers scenes (Classic day/night, Night sky, Sakura,
Zen mist, Dusk, Void). Your choice is saved and syncs with the wallpaper like everything else.

Everything works offline except the first three.js load and weather.

## Real seasons 🌸🍃🍂❄

The tree follows the **real seasonal cycle** of your hemisphere: ~3 weeks of pink bloom in early
spring, green foliage through summer, orange autumn color, and a bare, dormant winter (growth
nearly stops — like a real deciduous sakura). Growth pace is tuned near real life (~5× faster):
a recognizable silhouette takes about a month and a half; girth and density keep refining for
a year and beyond. Fertilizer barely depletes in winter, and wires set faster in the growing season.

The season curve is the **only** thing that drives growth speed besides your care — it's a pure
function of the calendar and hemisphere, which is what makes every bonsai exactly reproducible
from its DNA (below).

## Real time & weather

- Location: silent IP lookup → or search your city → or 📍 precise geolocation.
- [Open-Meteo](https://open-meteo.com) (keyless) supplies temperature, humidity, rain, wind, day/night.
- Weather is **ambience**: rain streaks and smooths the raked sand, frost dusts the pads, wind
  makes the tree sway and shed petals, the sky follows your day/night. It never changes growth —
  that would make a shared tree impossible to verify.
- Progress persists in `localStorage`; on return the elapsed time (capped at 72 h) is simulated
  at half pace.

## 🧬 DNA — your bonsai is a seed plus its history

Since the tree can die, every surviving bonsai is proof of real care — and the whole game is built
so that a bonsai **is** its history:

- A tree is exactly `(seed, genesis time, hemisphere, action log)` — an *envelope*. Saves store
  no geometry: every boot **replays the log** and must land on the identical tree, bit for bit
  (`__bonsai.verifyReplay()` checks this live).
- Every action you take — water, mist, feed, cut, pinch, wire, unwire, bend (quantized), offline
  gaps, time-lapses — is an event with a sim-timestamp. The sim advances in fixed 15-minute
  quanta, so replay and live play take the exact same path. Even **death is a replayable fact**:
  the log of a neglected tree proves when it died.
- **⚙ → 🧬 COPY DNA LINK** copies a URL (~1 KB, deflate + base64url of the canonical envelope)
  that opens a **read-only viewer** of your exact tree on any machine — it replays your whole
  history in milliseconds and touches nothing locally.

## ⏱ Provable age — the timestamp notary

A grown bonsai's value is that it took *real months of real care* — so the game makes that
provable. Roughly once a day (silently, never blocking play), it sends a **hash** of the tree's
canonical history to `/api/notarize`, a tiny serverless function that returns the hash signed
(Ed25519) with the **server's own clock**. These attestations:

- ride along in DNA links (`&att=…`) and are verified **fully offline** by the viewer against
  public keys committed in [`js/notary.js`](js/notary.js) — the badge reads
  `⏱ on record since <date> · ≥N real days`;
- can't be backdated (the server signs with its own time — a freshly fabricated log gets a
  fresh timestamp and proves nothing), and can't be transplanted (the hash binds the seed,
  genesis, and every event byte of one exact history);
- prove **the history's age, not who grew it** — a fork of a shared DNA link verifies
  truthfully, because that history really is that old. Ownership is the NFT's job, below.

The notary is the game's only backend, it holds no data (stateless signing), and everything
still works offline — attestations are opportunistic. Key rotation: append the new public key
to `PUBKEYS` (old attestations stay verifiable) and swap the `NOTARY_KEY` env in Vercel.

## 🪙 Keep your bonsai — a living NFT (testnet)

Every bonsai starts as a **free demo**: fully playable, but it lives only in your
browser's memory. To **keep** a tree — save it across reloads and truly own it — you
mint it as a **living NFT** on **Base Sepolia** (a free test network). Grow one you love,
then hit 🪙 **KEEP**.

- **The demo never needs a wallet.** You can play, prune, and time-lapse without one; the
  wallet code (`js/chain.js` + ethers from a CDN) loads only when you KEEP (or to recover
  a tree you already own on boot). An un-kept demo tree is discarded when you close the tab
  (you're warned first).
- The token stores the tree's **entire DNA on-chain** — the same envelope a DNA link carries.
  Its metadata is generated on-chain too, and the `animation_url` opens this site's read-only
  viewer, so marketplaces (e.g. OpenSea testnet) render the *actual living tree*, not a picture.
- It's **alive**: after you keep it, the button becomes ⛓ UPDATE ON-CHAIN — push your tree's
  latest history whenever you like. Sim-time may never rewind, each tree can only be minted once
  (`treeId = keccak(seed:genesis)`), and yes: a tree that dies can be immortalized dead.
- To try it you need the MetaMask extension, a **fresh test account**, and free Base Sepolia ETH
  from a faucet. The contract lives in [`contracts/`](contracts/) (Foundry + OpenZeppelin,
  `forge test` covered) — see its README for build/deploy.

**Trust caveats (testnet-honest):** the chain *stores* the envelope, it does not *verify* it —
anyone can check a tree by replaying its DNA in the open sim, but trustless on-chain verification
would require fixed-point math: replay is bit-identical on the same JS engine, while
`Math.sin/cos/pow` are not spec-pinned across engines. The integer event format
(`["W",t]`, `["B",t,id,ax,ay,az,a]`, …) maps 1:1 onto a compact binary encoding when the time
comes. `treeId` and `simT` are client-supplied honesty rails, not proofs.

## Project layout

| File | Role |
|---|---|
| `js/tree.js` | pure segment-graph tree model + generative growth (Node-testable) |
| `js/sim.js` | deterministic sim core: fixed-step integrator, season curve, action/event vocabulary, replay, DNA codec |
| `js/voxels.js` | palette + voxel generation: pot, pebbles, wood, blossom puffs, wire coils |
| `js/weather.js` | Open-Meteo + location chain + visual environment factors |
| `js/game.js` | three.js scene (instanced voxels, orthographic pixel look), event logging, wall-clock scheduling, input, FX, UI |
| `test/smoke.js` | headless test: growth run, caps, prune/wire, replay identity, DNA round-trip |

Rendering: a 176×176 backbuffer upscaled with `image-rendering: pixelated`;
two `InstancedMesh`es of unit cubes with baked palette shading (no lights) — that's the
whole trick behind "pixel art you can rotate".

## Test

```bash
node test/smoke.js
```

## Tuning

- Growth pace/caps: `CFG` at the top of `js/tree.js`
- Meters, decay rates & pace: `step()` / `PACE` in `js/sim.js` (⚠ changes alter what old logs replay to)
- Palette: `PAL` in `js/voxels.js`
- Pixel chunkiness: `HALF` in `js/game.js` (44 = chunky, 88 = fine)
