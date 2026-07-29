# Can You Go 22-0? — AFL All-Time Team Builder *(work in progress)*

This is an in-progress AFL adaptation of [**Can You Go 82-0?**](https://canyougo820.com/),
an NBA all-time roster builder and season simulator. The goal, once finished, is the
same dare translated to Australian football: spin the draft wheel for a club + era,
draft an all-time six across KD / HB / MID / RUC / KF / SF, build chemistry, pick a
coach, and simulate a 22-game home-and-away season chasing a perfect **22-0**.

**Full build plan:** [`docs/afl-port-plan.md`](docs/afl-port-plan.md) — every decision,
the club/position/archetype translation table, the data project, and the phase-by-phase
sequencing lives there. Read it before touching this repo.

## Current status

**The app does not run correctly yet.** What's done so far is the data layer only:

- ✅ NBA-specific data, the NBA 2K rating pipeline, and NBA daily-challenge content
  have been stripped out.
- ✅ A small **stub** `players.json` exists — 3 clubs (Carlton, Essendon, North
  Melbourne) × 2 decades (1990s, 2010s), 41 real AFL players across the six AFL
  position slots — enough to unblock engine and UI development. It is **not**
  researched/audited data; it exists to build against, and gets replaced by the real
  ~800-1000 player dataset in Phase 3 of the plan.
- ✅ The AFL stat/position/archetype/trait schema (disposals, goals, marks, tackles,
  clearances, hitouts; KD/HB/MID/RUC/KF/SF; six new archetypes) is defined and the
  data pipeline scripts (`add_rating.js`, `add_popularity.js`, `validate_players.js`)
  are adapted to it.
- ❌ **The game engine is still the NBA version.** `js/logic/state.js` (club list,
  decades, positions, coaches), `js/logic/positions.js`, `js/logic/chemistry.js`,
  `js/logic/simulation.js`, `js/logic/era.js`, the finals bracket, and all UI copy
  still expect NBA teams/positions/archetypes. Because the club and decade names in
  the new `players.json` don't match `state.js`'s NBA team/decade lists, **every
  draft spin currently comes back empty** — the app will not play a game yet. This
  is Phase 4/5 of the plan and hasn't started.

## Run it locally

Serve the repo root over HTTP (ES modules don't load reliably over `file://`):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

It will load, but the draft wheel will not find any players until the engine port
(Phase 4 in the plan) is done.

## Tech

Vanilla JavaScript (ES modules), HTML, and CSS — no backend and no build step to play.
Tailwind is compiled ahead of time into the committed `css/tailwind.css`; re-run
`scripts/build_tailwind.sh` after changing Tailwind classes.

## Data pipeline

The player database is committed pre-generated at `js/data/players.js` (inlined from
`players.json`). To regenerate after editing `players.json`:

```bash
scripts/update_players.sh   # add_popularity.js -> add_rating.js -> inline_players.js
node scripts/validate_players.js
```

---

*Disclaimer: This is an unofficial fan-made game and is **not affiliated with, endorsed
by, or sponsored by the AFL** or any AFL club. All club and player names are the
property of their respective owners and are used for identification purposes only.*
