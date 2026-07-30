# Building out AFL 22-0 — step-by-step plan

Companion to [`afl-port-plan.md`](afl-port-plan.md). That document was the
*translation* plan, written before any code existed. This one is the
*build-out* plan: what is actually left, in dependency order, from the
current state of the repo.

**Status when this was written:** commit `69e80db`. The engine port is done
and the game is playable end to end (draft → 22-game season → AFL Final
Eight → results). The player database is a 41-player hand-written stub
(3 clubs × 2 decades).

---

## 0. What the research changed

Before planning, I checked what data is actually reachable from the build
environment. Three findings reshape the plan:

### 0.1 The primary AFL data sources are network-blocked

The environment's proxy returns **403 on CONNECT** for the three sites the
original plan named as primary sources:

| Host | Result |
|---|---|
| `afltables.com` | 403 (policy denial) |
| `www.footywire.com` | 403 (policy denial) |
| `api.squiggle.com.au` | 403 (policy denial) |
| `en.wikipedia.org` | unreachable |
| `github.com` / `raw.githubusercontent.com` | ✅ reachable |
| `pypi.org`, `registry.npmjs.org` | ✅ reachable |

This is the same wall the NBA original hit with `2kratings.com` (documented
at length in its `data/README.md`), and the fix is the same one that repo
used: **find a GitHub-mirrored dataset.**

### 0.2 A complete VFL/AFL dataset is clonable from GitHub

[`akareen/AFL-Data-Analysis`](https://github.com/akareen/AFL-Data-Analysis)
(**MIT licensed**, © 2023 Adam Kareen) mirrors AFL Tables as committed CSVs.
A sparse clone succeeded and materialised **137 MB / 26,412 files** —
~13,200 players × (performance + personal) — covering **1897–2025**.

Per-game columns are an exact match for this game's schema:

```
team, year, games_played, opponent, round, result, jersey_num,
kicks, marks, handballs, disposals, goals, behinds, hit_outs, tackles,
rebound_50s, inside_50s, clearances, clangers, free_kicks_for,
free_kicks_against, brownlow_votes, contested_possessions,
uncontested_possessions, contested_marks, marks_inside_50,
one_percenters, bounces, goal_assist, percentage_of_game_played
```

All five balance stats (`disposals`, `goals`, `marks`, `tackles`,
`clearances`) plus `hit_outs` — **and `brownlow_votes`**, which is the single
most important input to the `overall` rating composite (§B).

A second repo, [`CooperDenny/AFLPlayerStats`](https://github.com/CooperDenny/AFLPlayerStats),
carries a 47 MB official-AFL-API file (2015–2026) that adds
`Rating.Points` (Champion Data's official AFL Player Rating) and
`Player.Position`. **It has no LICENSE file**, so there is no explicit grant
of use — treat it as *optional enrichment for the modern era only*, and
prefer the MIT-licensed akareen data as the backbone. Do not make the build
depend on it.

**Impact: the data phase drops from ~3–6 weeks of manual research to a few
days of scripted ETL.** That was the critical path in the original plan; it
no longer is.

### 0.3 The historic-stats gap is now measured, not assumed

The original plan's §4.2 assumed tackles start in 1987 and clearances
~1998. I measured it across a 1-in-9 sample of the real dataset (~76k
player-games). Percentage of rows with a **non-empty** value:

| decade | rows | disposals | marks | tackles | clearances |
|---|---|---|---|---|---|
| 1950s | 5,948 | 0% | 0% | 0% | 0% |
| 1960s | 5,246 | 51% | 46% | 0% | 0% |
| 1970s | 6,064 | **97%** | **90%** | 0% | 0% |
| 1980s | 6,290 | 100% | 92% | 23% | 0% |
| 1990s | 9,122 | 100% | 91% | 66% | 13% |
| 2000s | 7,391 | 100% | 94% | 80% | 65% |
| 2010s | 10,027 | 100% | 95% | 91% | 59% |
| 2020s | 5,424 | 99% | 94% | 86% | 58% |

This **confirms** the assumption and sharpens it:

- **1960s is not viable** — only ~half of games have disposals at all.
  Confirms decision D5 (start at the 1970s). Do not revisit.
- **1970s** has excellent disposals/marks but **zero** tackles and
  clearances — 2 of the 5 balance stats need imputation.
- **1980s** adds only partial tackles (23%) and still no clearances.
- Full five-stat coverage really begins in the **2000s**.

**Critical ETL nuance this surfaces:** a blank cell means two different
things depending on the stat.

- Blank `goals` / `hit_outs` / `brownlow_votes` = a genuine **zero** (most
  players don't kick a goal, ruck, or poll votes in a given game). The low
  percentages in those columns are not missing data.
- Blank `tackles` in 1975 = **not recorded**, and must never be coerced to 0
  — that would make every 1970s player look like a non-tackler and skew the
  whole era's balance ratio.

Getting this wrong is silent and would poison era normalisation. It is
called out as its own step in §A.4.

---

## 1. Current state

**Done and verified in a browser:**

- Repo copied, NBA data/scripts/assets stripped, NBA-coupled GitHub Action removed.
- Engine fully ported: `state.js` (18 clubs, 6 decades, 6 slots, 7 coaches),
  `positions.js`, `era.js` (dual disposal/scoring factors), `chemistry.js`
  (~50 AFL synergy/penalty rules), `simulation.js` (22-game season, retuned
  sigmoid, goals/behinds scoring), `playoffs.js` (real AFL Final Eight with
  the double chance), `challenge.js`, `modes.js`, `seasonTier.js`,
  `dynastyDuel.js`, `storage.js`, `render.js`, `events.js`.
- Firebase pointed at placeholder config so it can't write to the NBA game's project.
- Data pipeline scripts adapted to the AFL schema, incl. a new club-era
  legality validator.
- Three runtime bugs found and fixed by actually playing it (decade-exhaustion
  soft-lock, 82-game array index crash, QF-loss mis-elimination).

**Not done:**

| Area | State |
|---|---|
| Player data | 41-player stub, 3 clubs, 2 decades |
| `overall` rating | Placeholder — just mirrors stats-derived `rating` |
| Balance tuning | All constants are first-pass estimates vs. a 41-player stub |
| Sweep harness | Does not exist (never existed in the NBA repo either) |
| Daily Challenge pages | Generator present, `daily/` deleted, GH Action removed |
| Branding assets | Still NBA basketball art (favicon, og-image, logo-badge) |
| Firebase project | None |
| Domain / SEO / portals | None |
| Deployment | Pending repo going public + Pages enable |

---

## Phase A — Build the real player database

**Goal:** ~800–1,000 entries across 18 clubs × 6 decades (1970s–2020s),
matching the NBA original's density (937 entries / 178 buckets).
**Effort: 3–5 days.** No longer the critical path.

### A.1 Vendor the source data

1. Sparse-clone `akareen/AFL-Data-Analysis` (`data/players`, `data/matches`).
2. **Do not commit the 137 MB corpus.** Commit only the derived
   `players.json` plus a `data/README.md` documenting provenance, the MIT
   licence, the commit SHA pinned, and the measured coverage table from §0.3
   — mirroring the NBA repo's documentation discipline, which is the single
   most imitable thing in it.
3. Record attribution in the repo README (MIT requires it).

### A.2 Aggregate per-game rows → per-club-per-decade season lines

The game's unit is *one player, one club, one decade*. The source is *one
player, one game*. The reducer:

1. Parse each `*_performance_details.csv`; join `*_personal_details.csv` for
   name/DOB (the unique key).
2. Group rows by `(player, team, decade)`.
3. **Pick the player's best single season** in that club-decade window, not a
   decade-wide average. The NBA original's rubric is explicit that each entry
   must be "an actual season that player had with that team" — a decade
   average is a number no one ever posted. Best season also matches the
   "all-time team" fantasy.
   - Define "best" by games played ≥ 8 **and** a composite of the five stats,
     so a 3-game cameo can't win.
4. Normalise club names to the game's bucket keys (`Western Bulldogs` →
   `WesternBulldogs`), and map historical identities per the port plan §3.1
   (`Footscray`, `South Melbourne`, `Brisbane Bears`, `Fitzroy`), writing
   `eraClubName` for display.

### A.3 Select the roster (the curation step)

Raw aggregation yields far too many players. Trim to ~50–60 per decade
across the league:

1. Rank within each club-decade by the §B composite rating.
2. Take the top N per bucket (target 5–8, matching the stub's shape) with a
   **positional spread constraint** — every bucket must be draftable, i.e.
   contain at least one plausible KD, MID, RUC and KF. A bucket of six
   midfielders is a dead board.
3. Enforce the club-era legality matrix (§3.1) — the validator already
   catches violations.

### A.4 Handle the missing-stat problem explicitly

Per §0.3, implement the two-way blank semantics:

1. **Zero-blanks** (`goals`, `hit_outs`, `brownlow_votes`, `behinds`) → coerce
   blank to 0.
2. **Missing-blanks** (`tackles` pre-1987, `clearances` pre-1998) → leave
   `null` through aggregation, then impute at the end:
   - Derive per-position, per-decade medians from the earliest decade where
     the stat *is* recorded.
   - Scale by that decade's era factor.
   - Stamp `"imputed": ["tackles","clearances"]` on the entry.
3. Surface an asterisk + tooltip on imputed stat lines in the UI. Honesty is
   cheap here and the alternative (silently inventing 1970s tackle counts) is
   the kind of thing a footy audience will notice.

### A.5 Assign positions

Source has `Player.Position` only in the (unlicensed, 2015+) Cooper file, so
derive it for the backbone:

1. Heuristic classifier from the stat line: `hit_outs` → RUC; high
   `goals` + `marks`, low `disposals` → KF; high `goals`, low everything →
   SF; high `marks` + `rebound_50s`, near-zero `goals` → KD; high
   `rebound_50s` + `disposals` → HB; high `disposals` + `clearances` → MID.
2. **Hand-review every entry.** ~900 rows is a few hours and this is the
   field most visible to players — a fan will instantly spot Wayne Carey
   listed as a defender. The heuristic is a first pass, not the answer.
3. `secondaryPos` needs no data work — `positions.js` derives it at runtime.

### A.6 Assign archetypes and traits

1. Archetype: rules over the stat line + position (the six from port plan §3.3).
2. Traits: 2–3 per player from the 21-trait vocabulary, rule-derived
   (e.g. `brownlow_votes` in the decade → *Ball Winner*; finals games played
   → *Big Finals Performer*; one club across whole career → *One-Club Champion*).
3. Spot-check the marquee names by hand.

### A.7 Run and validate

`scripts/update_players.sh` → `validate_players.js` → `audit_stats.js`
(rewrite its thresholds for AFL ranges first). Then a full pass against a
rewritten `docs/player-data-audit/rubric.md`.

---

## Phase B — The `overall` rating pipeline

**Goal:** replace the placeholder (`overall = rating`) with a real composite.
**Effort: 2–3 days.** Depends on A.2.

1. **Inputs**, in descending weight:
   - Brownlow votes in the decade (available in-source, all eras) — primary.
   - All-Australian selections — needs a small hand-compiled table; the lists
     are short and well known.
   - Games played for the club in that decade — a floor, so a cameo can't outrank a champion.
   - Coleman / leading-goalkicker finishes, for forwards.
   - Club best-and-fairest wins — the best available signal for key
     defenders, taggers and rucks.
   - *Optional:* `Rating.Points` from the Cooper file for 2015+, **only if**
     its licensing is clarified.
2. **Correct the defender bias.** Brownlow votes go to ball-winners; an
   uncorrected composite will make every key defender look like filler. Apply
   a documented per-position calibration and say so in `data/README.md`.
3. **Per-era quantile normalisation.** Port the NBA repo's
   `normalize_2k_overalls_by_era.py` method (percentile rank within decade →
   remapped onto the pooled cross-era distribution, with each decade's peak
   anchored to 99). It is the most transferable asset in the original repo.
4. Re-point `RATING_MID` in `simulation.js` (currently 77, tracking the stub)
   and the star/GOAT cutoffs in `draft.js` to the new distribution's percentiles.

---

## Phase C — Balance and tuning

**Goal:** make the numbers mean something. **Effort: 3–4 days. Hard blocked
on A and B** — tuning against a 41-player stub is meaningless.

### C.1 Build the sweep harness first

`scripts/sweep.mjs` — headless, loads the DB, generates N rosters under a
strategy (random / star-chasing / greedy-chemistry), runs the sim, reports
percentiles. The NBA repo's tuning comments cite 400- and 1500-sample sweeps
but the harness itself was never committed. Write it once; everything below
depends on it.

### C.2 Fit constants, in this order

Each step depends on the ones before it; out of order means doing it twice.

1. **`era.js` factors** — re-derive `DISPOSAL_LEAGUE_AVG` and
   `SCORING_LEAGUE_AVG` from real league totals (computable from
   `data/matches`, which the clone already has). Currently documented
   estimates. Add the self-check that prints per-decade adjusted means and
   confirms convergence — a sign error here is plausible-looking and would
   quietly mis-rate whole decades.
2. **`overall` percentiles** → star/GOAT tiers, AI-draft window, badge colours.
3. **Sim sigmoid** (`SIM_K`, `SIM_CENTER`, `WIN_CAP`) — target: star-chasing
   median ≈ 15–17 wins, random median ≈ 6–8, **P(22-0) ≈ 1–2%**.
4. **`FAMILY_CAPS` / `SYNERGY_SCALE`**, and every numeric threshold in
   `chemistry.js` (all currently first-pass guesses against the stub).
5. **Daily-challenge win gates** — set from measured pass rates.
6. **UI scales** — `maxes` in `render.js`'s `statBar`.

### C.3 Re-verify

Re-run the browser playthrough and the 200-trial bracket test after tuning.

---

## Phase D — Content and features

**Effort: ~2 days.** Partly depends on A (locked challenges need real IDs).

1. Point the four `locked` daily challenges at real marquee player IDs.
2. Sanity-check the `no-victorians` challenge now that interstate clubs have
   data (it is currently unsatisfiable).
3. Regenerate `daily/` via `build_challenge_pages.mjs` (update `ORIGIN`,
   `LAUNCH`, copy templates).
4. Restore the nightly refresh GitHub Action — **only after** step 3, since
   that's what made it unsafe to keep.

---

## Phase E — Branding and assets

**Effort: 2–3 days. Fully parallel to A–D** — no dependency on data.

1. `favicon.svg` (Sherrin, not an orange ball) → `build_favicon.sh`.
2. `og-image.svg` → `build_og_image.sh`.
3. `logo-badge.svg`.
4. Accent colour away from NBA orange, to something footy-neutral that is not
   any single club's palette. Re-run `build_tailwind.sh`.
5. Keep the no-logos / text-and-colours-only posture (port plan D8).

---

## Phase F — Infrastructure and launch

**Effort: 1–2 days. Parallel to A–D.**

1. **Deploy now** (unblocks everything else): repo → public, Settings → Pages
   → `main` / root. Canonical + OG tags already point at
   `https://josh-eng2.github.io/AFL-22-0/`.
2. New Firebase project; fill `FIREBASE_CONFIG`; apply the Firestore rules
   from the file header (already rescaled to 22 wins).
3. Domain (if wanted) → `CNAME`, update canonical/OG/JSON-LD, `sitemap.xml`,
   Search Console.
4. Portal registration (CrazyGames, GameDistribution) — new game IDs; the
   current `index.html` still carries the NBA original's GD `gameId`.

---

## Phase G — QA and launch readiness

**Effort: 3–4 days. Depends on everything.**

1. Mode matrix: every mode × every decade × light/dark × mobile.
2. Adversarial: exhausted draft grids, a drawn Grand Final, every
   locked-player challenge, 1v1 and GM-vs-AI full runs.
3. Degradation: fonts blocked, Firebase unreachable, confetti CDN blocked.
4. Full data audit pass against the rewritten rubric.
5. Performance check on `optimizeLineup` — 6 slots is 720 permutations vs the
   NBA's 120, on the hottest path (AI draft calls it twice per board player).

---

## 2. Sequencing

```
Now ──► F.1 deploy (30 min, unblocks feedback)
        │
        ├─► A. Data ETL (3–5d) ──► B. Ratings (2–3d) ──► C. Balance (3–4d) ──┐
        │                                    └─► D. Content (2d) ────────────┤
        ├─► E. Branding (2–3d) ──────────────────────────────────────────────┤
        └─► F.2–4 Infra (1–2d) ──────────────────────────────────────────────┴─► G. QA (3–4d)
```

**Critical path: A → B → C → G ≈ 12–16 working days.** E and F run fully in
parallel and are not on it.

**Revised total: ~3 weeks**, down from the original plan's 6–9 weeks — the
entire saving is §0.2 (a clonable dataset replacing manual research).

### One sequencing note worth acting on

If the full ETL is deferred, grow the stub **along the decade axis, not the
club axis**. The engine has mechanics that only activate with decade spread —
`usedDecades`, era-stacking chemistry, the "All Eras" spin, the decade-skip
budget. Three clubs × six decades exercises far more of the game than
eighteen clubs × two decades, and would have caught the decade-exhaustion
soft-lock earlier.

---

## 3. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Sim constants tuned against thin data | The central 22-0 dare is meaningless | C is hard-blocked on A+B; build the sweep harness first |
| Blank ≠ zero conflation (§0.3) | Silently poisons era normalisation and every balance ratio | Explicit two-way blank semantics in A.4; assert on it in the validator |
| Auto-derived positions ship unreviewed | Immediately visible howlers to a footy audience | A.5 mandates a full hand-review pass |
| Brownlow-based ratings undervalue defenders | Key defenders read as filler on every board | B.2 per-position calibration, documented |
| Dual era factors get the sign wrong | Whole decades mis-rated, plausibly enough to pass unnoticed | C.2.1 self-check printing per-decade adjusted means |
| Dataset licence/attribution | Legal exposure | akareen is MIT — attribute it; treat the unlicensed Cooper file as optional only |
| GD `gameId` still the NBA game's | Wrong attribution / revenue | F.4 before any public launch |
| 137 MB corpus committed by accident | Bloated repo | Vendor outside the repo; commit only derived `players.json` |

---

## 4. Still portable from the NBA repo

Worth stating, because the instinct on a port is to rewrite everything:

- `normalize_2k_overalls_by_era.py` — the per-era quantile normalisation
  method (§B.3). The most valuable transferable idea in the original.
- `build_challenge_pages.mjs` — reads the game's own modules rather than
  duplicating data; survives intact.
- The nightly refresh GitHub Action.
- `pageIntegrity.js` — sport-agnostic, written after a real incident.
- The documentation discipline of `data/README.md` and
  `docs/player-data-audit/rubric.md`. Imitate the standard, not just the format.
