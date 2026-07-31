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

**Playable end to end** — draft → 22-game home-and-away season → AFL Final
Eight → premiership.

- ✅ Engine fully ported to AFL: 18 clubs, six decades, the six-slot spine
  (KD/HB/MID/RUC/KF/SF), AFL chemistry synergies, a 22-game season sim, and
  the real AFL Final Eight (McIntyre system) with the double chance.
- ✅ **Real player database** — 828 entries across 92 club-decade buckets
  (1970s–2020s), derived from AFL Tables data. Each entry is a real player's
  best single season at that club in that decade. See [`data/README.md`](data/README.md).
- ⬜ Balance tuning (Phase C), branding assets, Firebase, and launch prep are
  still outstanding — see [`docs/afl-build-out-plan.md`](docs/afl-build-out-plan.md).

## Run it locally

Serve the repo root over HTTP (ES modules don't load reliably over `file://`):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Data attribution

Player data is derived from
**[akareen/AFL-Data-Analysis](https://github.com/akareen/AFL-Data-Analysis)**
(**MIT licence**, © 2023 Adam Kareen), a mirror of
[AFL Tables](https://afltables.com/afl/afl_index.html) — pinned at commit
`c71299ef01958e5454dc4583c6787775f9e14b53`.

The ~137 MB source corpus is **not committed**; only the derived
`players.json` ships. Full provenance, the measured per-decade stat-coverage
table, and the blank-semantics/imputation policy are in
[`data/README.md`](data/README.md).

## Tech

Vanilla JavaScript (ES modules), HTML, and CSS — no backend and no build step to play.
Tailwind is compiled ahead of time into the committed `css/tailwind.css`; re-run
`scripts/build_tailwind.sh` after changing Tailwind classes.

## Data pipeline

The player database ships pre-generated at `js/data/players.js` (inlined from
`players.json`). To rebuild it from source:

```bash
bash scripts/afl_vendor_data.sh     # fetch the pinned source corpus (~137 MB, gitignored)
node scripts/afl_build_seasons.mjs  # per-game rows -> per-season lines
node scripts/afl_build_db.mjs       # best season per club-decade -> curated boards
bash scripts/update_players.sh      # popularity -> rating -> inline js/data/players.js
node scripts/validate_players.js    # structural validation (must exit 0)
node scripts/audit_stats.js         # realism triage
```

Add `--review` to `afl_build_db.mjs` to regenerate the position-review artifact.
Audit methodology: [`docs/player-data-audit/rubric.md`](docs/player-data-audit/rubric.md).

---

*Disclaimer: This is an unofficial fan-made game and is **not affiliated with, endorsed
by, or sponsored by the AFL** or any AFL club. All club and player names are the
property of their respective owners and are used for identification purposes only.*
