# data/ — provenance for `players.json`

This directory documents where the shipped player database comes from. It
holds **no data files**: the source corpus is ~137 MB and is vendored outside
git (see [Vendoring](#vendoring)). The only data artefact that ships is
`players.json` at the repo root, plus its generated twin `js/data/players.js`.

---

## Source

**[akareen/AFL-Data-Analysis](https://github.com/akareen/AFL-Data-Analysis)**
— a mirror of [AFL Tables](https://afltables.com/afl/afl_index.html) as
committed CSVs.

| | |
|---|---|
| Licence | **MIT**, © 2023 Adam Kareen |
| Pinned commit | `c71299ef01958e5454dc4583c6787775f9e14b53` (2025-04-01) |
| Coverage | 1897–2025, ~13,200 players, 26,412 CSV files, ~137 MB |
| Used from it | `data/players/*.csv`, `data/matches/*.csv` |

Attribution is also carried in the root `README.md`, as MIT requires.

### Why a mirror instead of the original sites

`afltables.com`, `www.footywire.com` and `api.squiggle.com.au` are **all
network-blocked** in this project's build environment — the egress proxy
answers `403` to `CONNECT` for each. Wikipedia is unreachable too.
`github.com` and `raw.githubusercontent.com` are reachable, so a
GitHub-hosted mirror is the only viable path. (The NBA original this game is
ported from hit the identical wall with `2kratings.com` and solved it the
same way; see `docs/afl-build-out-plan.md` §0.1–0.2.)

### A second, deliberately unused source

[`CooperDenny/AFLPlayerStats`](https://github.com/CooperDenny/AFLPlayerStats)
carries a 47 MB official-AFL-API export (2015–2026) with `Rating.Points`
(Champion Data's official AFL Player Rating) and an explicit
`Player.Position` column — both genuinely useful. **It has no LICENSE file**,
so there is no grant of use, and nothing in this build depends on it. If its
licensing is ever clarified it would be a strong enrichment for 2015+ entries
only.

---

## Vendoring

```bash
bash scripts/afl_vendor_data.sh     # sparse clone to vendor/afl-data at the pinned SHA
```

`vendor/` is gitignored. **Never commit the corpus.** The script is
idempotent and refuses to silently drift: if the local clone is at a
different SHA it refetches.

---

## Pipeline

```bash
bash scripts/afl_vendor_data.sh     # 1. fetch source corpus (~137 MB, once)
node scripts/afl_build_seasons.mjs  # 2. per-game rows -> per-season lines
node scripts/afl_build_db.mjs       #    ( --review also writes the position review)
bash scripts/update_players.sh      # 3. popularity -> rating -> overall -> inline
node scripts/validate_players.js    # 4. structural validation (must exit 0)
node scripts/audit_stats.js         # 5. realism triage
```

Stage 3 order matters: `add_overall.js` consumes `ratingRaw` from
`add_rating.js`, and `inline_players.js` must run last so the shipped bundle
carries the finished ratings. Use `add_overall.js --explain="<name>"` to see
which inputs produced any player's rating.

Note that steps 1–2 are only needed to rebuild from source. The career signals
`add_overall.js` needs (`decadeBrownlow`, `decadeGames`, `coleman*`, …) are
persisted into `players.json`, so ratings can be rebuilt with `update_players.sh`
alone — no 137 MB corpus required. `inline_players.js` strips them from the
shipped bundle.

Stage 2 (`afl_build_seasons.mjs`) reduces ~405,000 per-game rows into 21,595
club-seasons. Stage 3 (`afl_build_db.mjs`) picks each player's **best single
season** per club-decade, curates a draftable board per bucket, imputes
unrecorded stats and assigns archetypes/traits.

---

## Measured stat coverage

Not assumed — measured across the real corpus. Percentage of player-game rows
carrying a **non-empty** value for each stat, by decade (1-in-9 sample,
~76,000 rows):

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

Two decisions follow directly from this table:

- **The game starts at the 1970s.** The 1960s has only ~51% disposal and 46%
  mark coverage — barely half its games have the most basic stat — so it
  cannot field a fair board. (Port plan decision D5, now evidence-backed.)
- **Tackles and clearances need imputation** for the 1970s (both), the 1980s
  (tackles partial, clearances none) and much of the 1990s (clearances).

---

## Blank semantics — the load-bearing rule

A blank cell in the source means **two different things** depending on the
column. Conflating them silently corrupts era normalisation and every
balance ratio downstream, so the pipeline treats them separately and the
validator asserts the distinction.

| class | columns | blank means | handling |
|---|---|---|---|
| **zero-blank** | `goals`, `behinds`, `hit_outs`, `brownlow_votes` | a genuine **0** | counted as 0 in the average |
| **missing-blank** | `disposals`, `marks`, `tackles`, `clearances` | **not recorded** | excluded from the average; if a season has none, the stat is `null` and gets imputed |

Most players don't kick a goal, ruck a contest or poll a vote in a given
game — so the low non-empty rates in those columns are *data*, not gaps.
Conversely, a player who took the field always had *some* disposals: a blank
there is a recording gap. Treating a blank 1975 tackle count as `0` would
make every 1970s player look like a non-tackler and drag the whole era's
balance ratio down.

### Imputation

Where a stat has no recorded games in a season, it is filled from the
**median for that position in the nearest decade that does record it**,
scaled by that era's disposal-volume factor — so a 1975 midfielder gets a
1975-scaled midfielder's tackle count, never a modern one copied across and
never a zero.

Every imputed entry carries an `imputed: ["tackles", ...]` array naming
exactly which stats were estimated, and the UI marks those values with an
asterisk. **278 of 828 entries** carry imputed values.

`validate_players.js` fails the build if a pre-1987 entry has `tackles: 0`
without the flag, or a pre-1998 entry has `clearances: 0` without it — so the
trap can't be silently reintroduced.

---

## Known source defects, repaired in the pipeline

Found during the audit; each is corrected in `scripts/afl_positions.mjs`.

1. **Stripped apostrophes.** The source stores `O'Brien` as `OBrien`,
   `O'Loughlin` as `OLoughlin`, `O'Meara` as `OMeara`. Repaired by rule
   (`fixName`) — `Mc`/`Mac` names are correctly left alone.
2. **Dropped Dutch surname particles.** Jordan De Goey is stored with
   `last_name = "Goey"`, Tom De Koning as `"Koning"`, Matt de Boer as
   `"Boer"`. The particle is absent from the data entirely, so these are
   listed explicitly (`NAME_PREFIX_FIX`).
3. **Name collisions between different players.** 16 names in the shipped set
   are shared by two or three distinct players — including **Gary Ablett**
   (Sr, the Geelong full-forward, and Jr, the midfielder) and **Josh
   Kennedy** (Sydney's midfielder and West Coast's key forward). Beyond being
   simply wrong, this breaks gameplay: the engine's `draftedPlayerNames` set
   uses the name as its cross-era clone guard, so two different players
   sharing one would wrongly block each other in the draft. Resolved by
   `NAME_BY_KEY`, using established football convention where one exists
   (Sr/Jr, Josh P./Josh J., Tom J./Tom T.) and a club suffix otherwise.
4. **Position overrides orphaned by those renames.** A second-order defect the
   collision repair itself introduced. `POSITION_OVERRIDES` is keyed by *final*
   player name, so when `NAME_BY_KEY` splits a shared name, an override still
   keyed on the old name either goes dead or — worse — re-points at whichever
   player kept the bare name.

   `'Scott Thompson': 'KD'` was written for North Melbourne's key defender.
   Once he was renamed `Scott D. Thompson`, the override landed on **Adelaide's
   30-disposal midfielder**, shipping him as a key defender. It stayed
   invisible through all of Phase A and only surfaced when the Phase B
   positional calibration multiplied the error and pushed him to the top of the
   board. Four more overrides (`Gary Ablett`, `Josh Kennedy`, `Tom Lynch`,
   `Josh Kennedy Jr`) were dead for the same reason.

   `afl_build_db.mjs` now fails the build on any override keyed to a name the
   rename layer has since split, so the class of bug can't recur silently.

---

## Ratings — how `overall` is built

Two different numbers, for two different jobs:

| field | built by | used for |
|---|---|---|
| `rating` | `add_rating.js` | display only; a pure stat-line value |
| `overall` | `add_overall.js` | **everything the game plays on** — sim strength, AI draft, star/GOAT tiers, badge colours |

`afl_build_db.mjs` separately ranks curation candidates with a *provisional*
composite whose only job is deciding which players make each board.

### Why `overall` can't just be the stat line

Through Phase A, `overall` was a placeholder that mirrored `rating`. That is
wrong in a specific and unfixable way: the stat columns the source carries
(disposals, goals, marks, tackles, clearances) measure **volume**, and volume
tracks *position* far more than quality. Glenn Archer's best season reads 12.9
disposals / 1.3 goals / 3.1 marks — statistically a fringe small forward. He is
one of the most decorated defenders of his era. No weighting of those five
columns separates him from a journeyman, because the numbers genuinely don't
differ. Awards measure standing among peers, which is what a rating should
express.

### The composite

Five weighted inputs plus one additive bonus, then calibrated for positional
bias and normalised per era.

| input | weight | available |
|---|---|---|
| Brownlow votes per game (club-decade) | 0.34 | 729/828 — **1984+ only** |
| All-Australian selections | 0.20 | *table not yet sourced* |
| Club best & fairest | 0.16 | *table not yet sourced* |
| Games + finals (stint, blended with career) | 0.14 | all |
| Stat line (`ratingRaw`) | 0.16 | all |
| Goalkicking honours | +0.12 max | all — **additive bonus** |

**A missing signal is not a zero.** This is the same trap as blank-vs-zero in
the stat columns, one level up, and it is the most load-bearing rule here. The
weighted mean is taken over *available* inputs only and renormalised by the
weight actually present, so an entry lacking a signal is scored on what remains
rather than penalised for a gap in the historical record.

Goalkicking honours sit outside the weighted mean deliberately. As an input
they would score 0 for every key defender and half-back, so not kicking goals
would drag their composite down — reintroducing the exact positional penalty
the calibration exists to remove. As a bonus they can only ever add.

### The Brownlow gap: no votes before 1984

**Measured, not assumed.** `brownlow_votes` is blank for every pre-1984 row in
the corpus — 8,028 sampled 1970–83 game rows carry no non-empty value, while
1984–2024 rows carry them normally. AFL Tables only publishes per-game Brownlow
votes back to 1984.

So for 1970–83 a blank means *not recorded*, while from 1984 it means a genuine
zero — the same cell, in the same column, meaning different things either side
of a boundary. Reading the pre-1984 blanks as zeroes would encode "no 1970s
player ever polled a Brownlow vote", which is false, and would mark an entire
era as journeymen — Leigh Matthews and Kevin Bartlett included.

Each entry therefore carries `decadeBrownlowGames`: games played inside the
vote-recording window. Zero means *no signal available*, and the composite
redistributes that weight rather than scoring a zero. `BROWNLOW_FIRST_YEAR` in
`afl_build_seasons.mjs` re-asserts the boundary against the source on every
build, so a future backfill surfaces instead of passing silently.

Coverage after this handling: **0 of 99** 1970s entries have a Brownlow term;
every later decade has 100%. The 1970s is carried instead by goalkicking
honours (its best coverage of any decade — 27/99), longevity and production,
which is why Kevin Bartlett still rates 96 with no vote data at all.

### Defender-bias calibration

The bias, measured in this database — mean Brownlow votes per club-decade:

| KD | HB | MID | RUC | KF | SF |
|---|---|---|---|---|---|
| 13.8 | 21.9 | 53.9 | 24.9 | 35.8 | 16.7 |

Midfielders poll **3.9x** the votes of key defenders. That gap is what umpires
reward, not a measure of how good defenders are.

The correction replaces each position-biased input (Brownlow rate, stat line)
with a blend of its absolute score and the player's percentile rank *within
their own position*, at strength 0.70. Effect on the median composite:

| pos | before | after | change |
|---|---|---|---|
| KD | 0.164 | 0.346 | +0.182 |
| HB | 0.224 | 0.358 | +0.134 |
| MID | 0.409 | 0.413 | +0.004 |
| RUC | 0.259 | 0.362 | +0.104 |
| KF | 0.382 | 0.452 | +0.070 |
| SF | 0.212 | 0.352 | +0.140 |

Correcting *inside* the biased inputs rather than rescaling the finished
composite is deliberate. An earlier version applied a per-position multiplier
to the final score; because the bias is concentrated in two inputs but the
multiplier hit all of them, it had to grow so large it saturated its own clamp
(1.60x for key defenders) and then over-promoted the top of that position
rather than lifting its middle. It also amplified any position mislabel into a
rating error — which is how the Scott Thompson bug below surfaced.

Strength 0.70 rather than 1.0: a full correction would assert that the best
small forward and the best midfielder are equally valuable, which is its own
distortion.

### Per-era normalisation

Each player is ranked *within their own decade*, and that percentile read off
the pooled cross-era distribution. Each decade's best player is anchored to
**99**, encoding the intended claim — every era's best is an all-time great —
and keeping the board competitive whichever decade the wheel lands on.

This is the second thing rescuing the 1970s: entries there have no Brownlow
term, so their raw composites sit systematically lower. Comparing decades on
absolute value would mark down an entire era for a gap in record-keeping;
ranking within decade is immune, because what carries across is a player's
standing among their contemporaries.

`validate_players.js` fails the build if any decade does not peak at 99.

### Resulting distribution, and the gameplay thresholds

```
min 58   p50 77   p75 83   p90 89   p95 92   p99 96   max 99
```

Gameplay cutoffs are set by **percentile**, not round numbers, so they keep
selecting the same slice of the league as the rating model changes:

| threshold | value | share | where |
|---|---|---|---|
| GOAT | >= 95 | top 2.1% (17) | `draft.js`, `render.js`, `storage.js` |
| star | >= 92 | top 5.7% (47) | `draft.js`, `render.js`, `storage.js` |
| solid | >= 85 | top 20% | `render.js`, `storage.js` |
| sim midpoint | 77 | median | `RATING_MID`, `simulation.js` |

These preserve the shares the previous 97/92/85 bands selected under the old
placeholder (1.8% / 5.7% / 19.2%). Only GOAT moved — 97 → 95 — because the
composite's top tail is tighter; leaving it would have cut the GOAT pool from
~1.8% to 0.7%.

`validate_players.js` also fails the build if `overall` equals `rating` for
more than 90% of entries, which is what a silent regression to the placeholder
would look like.

### Known gaps

- **All-Australian and club best-and-fairest tables are not yet sourced.**
  Together they are 0.36 of the intended weight, and they are the two inputs
  that would most help defenders — B&F especially, being voted by a club's own
  coaches, who see the defensive work umpire votes never reward. The composite
  runs without them via weight redistribution. Adding
  `data/awards/all-australian.json` and `data/awards/best-and-fairest.json`
  (shape `{"players": {"Name": [years...]}}`) needs no code change.
- **Goalkicking honours are derived, not sourced.** The Coleman goes to the
  season's highest home-and-away goal aggregate — a mechanical criterion applied
  directly to the corpus, so it needs no external table and carries no extra
  licensing risk. Spot-checked against known winners: 1970/71 Hudson, 1983
  Quinlan, 1991 & 1998 Lockett, 2003 Lloyd, 2012 Riewoldt, 2017 Franklin, 2022
  Curnow all reproduce exactly. Note the award was the plain "leading
  goalkicker" award before being named for Coleman in 1981.

`popularity` precedence is unchanged: curated household-name table →
pipeline-computed (Brownlow/games/finals informed) → stat formula. It is
deliberately *not* recomputed from goals for everyone, which would rate every
key defender as an unknown.

---

## Current shape

| | |
|---|---|
| Buckets | 92 (`Club_Decade`, 1970s–2020s, 18 clubs) |
| Entries | 828 |
| With imputed stats | 278 |
| With `eraClubName` | 73 |

`eraClubName` carries the era-accurate identity where a club has since been
renamed or merged: **Footscray** → Western Bulldogs, **South Melbourne** →
Sydney, **Brisbane Bears** and **Fitzroy** → Brisbane Lions, **Kangaroos** →
North Melbourne.
