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
bash scripts/update_players.sh      # 3. popularity -> rating -> inline js/data/players.js
node scripts/validate_players.js    # 4. structural validation (must exit 0)
node scripts/audit_stats.js         # 5. realism triage
```

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

---

## Provisional vs. final ratings

`afl_build_db.mjs` ranks curation candidates with a **provisional** composite
(the five stats + Brownlow votes across the club-decade + games + finals).
Its only job is deciding *which* players make each board.

The rating the game actually plays on (`overall`) is still produced by
`scripts/add_rating.js` from the stat line. A real composite — All-Australian
selections, club best-and-fairests, Coleman finishes, era-normalised and
corrected for the well-known bias of vote-based measures against key
defenders — is **Phase B**, not built here. See
`docs/afl-build-out-plan.md` §B.

`popularity` precedence is: curated household-name table →
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
