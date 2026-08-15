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
| 🔮 **FUTURE** | preview your bonsai after **2–9 years** of good care — a deterministic vision grown from your exact tree (older visions: denser canopy, stockier trunk); nothing changes until you return to NOW |
| 💧 **WATER** | soil moisture — drains faster on hot, dry days (shortcut: **tap the open air** above/beside the tree) |
| 🌫 **MIST** | leaf humidity — nice-to-have, the tree loves it (shortcut: **tap the blossoms**) |
| 🧪 **FEED** | fertilizer speeds growth; overfeeding burns the roots (shortcut: **tap the pebbles**) |
| ✂️ **PRUNE** | click a branch/blossom to cut it — it buds back **denser** (real bonsai behavior) |
| ➰ **WIRE** | click a branch to wire it, **drag to bend**; rotate the pot and bend again to sculpt in 3D; double-click unwires |
| ⏩ | time-lapse one hour |
| ⚙ | set your city (weather), start a new tree |

## Real time & weather

- Location: silent IP lookup → or search your city → or 📍 precise geolocation.
- [Open-Meteo](https://open-meteo.com) (keyless) supplies temperature, humidity, rain, wind, day/night.
- **Rain waters the tree** (up to a safe level), frost/snow make it dormant, wind makes it
  sway and shed petals, night slows growth, heat dries the soil faster.
- Progress persists in `localStorage`; on return the elapsed time (capped at 72 h) is simulated.

## Project layout

| File | Role |
|---|---|
| `js/tree.js` | pure segment-graph tree model + generative growth (Node-testable) |
| `js/voxels.js` | palette + voxel generation: pot, pebbles, wood, blossom puffs, wire coils |
| `js/weather.js` | Open-Meteo + location chain + environment factors |
| `js/game.js` | three.js scene (instanced voxels, orthographic pixel look), sim tick, input, FX, UI |
| `test/smoke.js` | headless test: 90-day growth run, caps, prune/wire, serialization |

Rendering: a 176×176 backbuffer upscaled with `image-rendering: pixelated`;
two `InstancedMesh`es of unit cubes with baked palette shading (no lights) — that's the
whole trick behind "pixel art you can rotate".

## Test

```bash
node test/smoke.js
```

## Tuning

- Growth pace/caps: `CFG` at the top of `js/tree.js`
- Meters & decay rates: `stepSim()` in `js/game.js`
- Palette: `PAL` in `js/voxels.js`
- Pixel chunkiness: `HALF` in `js/game.js` (44 = chunky, 88 = fine)
