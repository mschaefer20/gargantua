# 🕳️ Gargantua — Real-Time Black Hole Simulator

A visually stunning, physically-inspired black hole simulator that runs entirely
in the browser. Photon paths are ray-traced through a Schwarzschild geometry, so
both the starfield **and** the accretion disk are genuinely gravitationally
lensed — you see the disk wrap up over the top and under the bottom of the
shadow, exactly like *Interstellar*'s Gargantua.

Built with **Astro** + hand-written **WebGL2** shaders. No 3D libraries, ~19 KB
of JS, deploys to **Cloudflare Pages** as a static site.

![Gargantua](scripts/render.png)

## ✨ Features

- **Gravitational lensing** — per-pixel geodesic integration bends light around
  the event horizon (the classic Einstein-ring / photon-ring look).
- **Relativistic accretion disk** — blackbody temperature gradient, turbulent
  spiral structure, Keplerian rotation, and **Doppler beaming** (the approaching
  side is brighter and blue-shifted).
- **Lensed procedural starfield + nebula** with twinkling multi-layer stars.
- **HDR pipeline** — float render targets, two-iteration bloom, ACES filmic
  tonemapping, vignette and grain.
- **Interactive** — drag to orbit, scroll/pinch to zoom, live control panel for
  lensing strength, disk glow, bloom, exposure, starfield and render quality.
- **Adaptive performance** — auto-scales resolution if the framerate drops.

## 🚀 Develop

```bash
npm install
npm run dev      # http://localhost:4321
```

## 🏗️ Build

```bash
npm run build    # outputs static site to ./dist
npm run preview  # preview the production build
```

## ☁️ Deploy to Cloudflare Pages

**Option A — Git integration (recommended).** Push this repo to GitHub/GitLab,
then in the Cloudflare dashboard create a *Pages* project from the repo with:

- Build command: `npm run build`
- Build output directory: `dist`

(`wrangler.toml` already sets `pages_build_output_dir = "dist"`.)

**Option B — Direct upload from the CLI.**

```bash
npm run deploy   # runs `astro build` then `wrangler pages deploy dist`
```

The first `wrangler` run will prompt you to authenticate and name the project.

## 🧪 Smoke test

`scripts/smoke.mjs` loads the built page in headless Chrome and reports console
errors / shader-compile failures plus a screenshot (`scripts/render.png`):

```bash
npm run preview &        # serve on :4321
node scripts/smoke.mjs
```

## 🔭 The physics, briefly

Light is integrated as it falls through curved spacetime. Each step applies the
Schwarzschild light-bending acceleration

```
a = −1.5 · h² · r⃗ / |r⃗|⁵
```

where `h²` is the (conserved) specific angular momentum. Units are normalised so
the Schwarzschild radius is 1 — the horizon sits at r = 1, the photon sphere at
r = 1.5, and the disk spans roughly r = 2.6 → 13. Rays that fall inside the
horizon are captured (black); rays that cross the disk plane pick up emission;
the rest escape and sample the background sky.

It's an artistic approximation tuned for beauty, not a research-grade GR
integrator — but the lensing, photon ring and beaming asymmetry are all real
consequences of the simulation.
