# Porting the upstream NBA game code into AFL 22-0

**Companion to** [`afl-port-plan.md`](afl-port-plan.md) (the original translation
plan) and [`afl-build-out-plan.md`](afl-build-out-plan.md) (what's left to finish
the AFL game). This document covers a third, separate thing: **the NBA original
has kept shipping since we forked it, and none of that work exists here.**

> **Status: all ten units landed.** This document is kept as the record of
> *why* each port was done the way it was — the AFL-specific departures in §0.2
> and §2 are the parts worth re-reading before touching this code again.
>
> | Unit | Commit | Notes |
> |---|---|---|
> | 2.1 Popularity knob | `2bb4047` | Shipped at **1.0**, not upstream's 0.4 — see §0.2 |
> | 2.2 OOP penalty | `6681868` | −12%, measured on real rosters first |
> | 2.10 SEO / generator | `22b9707` | Also de-NBA'd the daily-page template |
> | 2.3 `seasonGrade()` | `f7c3422` | Rescaled to 22 games |
> | 2.4 Drop season-sim | `a3be30d` | Straight to results in ~140 ms |
> | 2.5 Team Report popup | `3ce661b` | Season Impact pulled forward from 2.8 |
> | 2.6 + 2.8 Results hero | `1b62737` | Teal/turf palette; Starting **Six** |
> | 2.7 Finals band | `96e83ca` | Final Eight double-chance handled |
> | 2.9 PWA | `39b181d` | AFL mark drawn to unblock it |
>
> **Two decisions taken during implementation**, both flagged here as open:
> - **§1 accent** resolved to **teal over a night-footy turf gradient**
>   (`--acc: #0d9488` / `#2dd4bf`, `--turf-*`), with CSS classes renamed
>   `.courtside-*` → `.boundary-*`. Gold kept for grade and premiership.
> - **§2.9's Phase E block** was cleared by drawing a placeholder Sherrin
>   crest rather than deferring the PWA. `og-image.svg` is still NBA art and
>   remains Phase E work.
>
> Still outstanding from the wider build-out: Phase C balance (which owns the
> real `POPULARITY_SCALE` value), Phase D daily pages, Phase E branding
> proper, Phase F infrastructure.

---

## 0. What this covers, and how the gap was measured

This repo was forked from
[`Josh-eng2/NBA-All-Time-Roster-Builder-Can-You-Go-82-0-`](https://github.com/Josh-eng2/NBA-All-Time-Roster-Builder-Can-You-Go-82-0-)
at commit **`a1e0644`** (2026-07-28), recorded in our `5a47466` "Initial import".
Upstream `main` is now at **`c049991`** (2026-08-04).

The delta, excluding `daily/` and `data/`:

```
 css/styles.css                    |  688 ++++++++++-
 icons/apple-touch-icon.png        |  Bin (new)
 icons/icon-192.png                |  Bin (new)
 icons/icon-512.png                |  Bin (new)
 index.html                        |   41 +-
 js/logic/aiDraft.js               |    4 +-
 js/logic/chemistry.js             |    4 +-
 js/logic/seasonTier.js            |   20 +
 js/logic/simulation.js            |    4 +-
 js/logic/state.js                 |    8 +-
 js/ui/events.js                   |  266 +---
 js/ui/render.js                   | 1031 +++++++++-------
 manifest.webmanifest              |   45 + (new)
 players.json                      | 1876 +++++++++++------------
 scripts/add_popularity.js         |  116 +-
 scripts/build_challenge_pages.mjs |    6 +-
 sitemap.xml / daily.html          |   40 +-
 sw.js                             |  130 + (new)
```

Reduced to intent, that is **ten units of work**, listed in §2. Six are pure UI /
platform and port almost mechanically. Four touch gameplay numbers, and **three of
those must not be copied verbatim** — §1 explains why.

### 0.1 Cherry-picking is not available

`git cherry-pick` across the two repos will conflict on essentially every hunk.
The AFL port already rewrote the same files: `render.js` (+296 lines changed),
`events.js` (+60), `chemistry.js` (+804), `simulation.js` (+371), `state.js`
(+244). Upstream's `render.js` changes alone are ~1031 lines against a file we
have independently diverged from.

**Method instead:** read each upstream commit's diff as a *specification*, and
re-implement it against the AFL file. The upstream commit messages are unusually
detailed (they explain the *why*, including trade-offs deliberately accepted) —
treat them as the design doc. Keep the upstream SHA in each of our commit
messages so the provenance is traceable.

### 0.2 The three numbers that must not be copied

This is the single most important finding in this document.

| Upstream change | Copying it verbatim into AFL would… |
|---|---|
| `POPULARITY_SCALE = 0.4` | **Break the fans mechanic outright.** See below. |
| Removing the `popNorm` upper clamp | Do nothing at all today. See below. |
| OOP chemistry penalty `0.03 → 0.12` | Actually be correct — but for a reason worth verifying, not assuming. |

**Popularity ×0.4 is actively wrong for AFL.** Measured from our committed
`players.json` (828 entries): popularity runs **min 38 / median 72 / p95 89 /
max 99**. `simulation.js` uses `POP_FLOOR = 35`, `POP_CEIL = 100`. Scaling by 0.4
drops the median to **28.8 — below `POP_FLOOR`** — so `popNorm` would floor at 0
for the overwhelming majority of rosters. Fan hype (`popMul`, `fansM`), the AI
draft's popularity weight, and the entire **Fans First** mode would all go flat.
Upstream's 0.4 is a correction for *NBA* popularity inflation relative to *NBA*
constants; it is not a fact about this game's data.

**Removing the upper clamp is a no-op here.** `Math.min(1, …)` only bites when
popularity exceeds 100. Nothing in `players.json` does (max 99), and `avgPop` is a
mean, so it cannot either. Adopt the change for structural parity and
future-proofing, but do not expect or claim a behaviour change.

**The OOP penalty does translate 1:1** — upstream's stated rationale is "matching
the severity of the existing Positional Logjam penalty," and our
`chemistry.js:780` logjam penalty is *already* `0.12`. The rationale survives the
port intact. The open question is arithmetic, not intent: see §2.2.

---

## 1. Prerequisite decision: the accent colour

Six of the ten units are blocked on one choice that has not been made yet.

Upstream's Results/Playoffs redesign introduces a token set built around
`--acc: #ea580c` (NBA orange), plus `--hardwood-from/to`, `--gold-from/to`,
`--pip-win/loss`. Meanwhile **Phase E of `afl-build-out-plan.md` already commits
to moving the accent off NBA orange** to something footy-neutral that isn't any
one club's palette.

Doing the UI port first and Phase E second means re-theming the same CSS twice.

**Decision to make before any UI work starts:** pick the AFL accent and the
"broadcast band" palette now, and land the redesign already wearing it.

Recommended, and assumed by the rest of this document:

| Token | NBA | AFL proposal |
|---|---|---|
| `--acc` (light) | `#ea580c` orange | a saturated non-club accent — teal/gold-ochre range |
| `--acc` (dark) | `#fb923c` | lighter tint of the same |
| `--hardwood-from/to` | `#161d2b → #3b2417` (timber) | **`--turf-from/to`**, night-footy: near-black → deep green |
| `--gold-*` | `#f59e0b → #d97706` | unchanged — premiership gold reads correctly |
| `--pip-win/loss` | green / rose | unchanged |

**Naming:** rename the CSS class prefix `.courtside-*` → `.boundary-*` and
`--hardwood-*` → `--turf-*`. It is a mechanical find/replace across
`styles.css` + `render.js`, and it keeps basketball vocabulary out of a file
players can open in devtools. Do it during the port, not as a follow-up.

Also inherited from upstream and worth keeping as-is: `.broadcast-band`,
`.season-strip`, `.quick-tile`, `.brk-o` — all sport-neutral already.

---

## 2. The ten units

Ordered by dependency, not by upstream chronology.

### 2.1 Popularity pipeline — the knob, not the value
**Upstream:** `83fcfc0`, `790ca02`, `970dfa4`, `897206d`
**Ours:** `scripts/add_popularity.js`, `js/logic/aiDraft.js:45`,
`js/logic/simulation.js:452`, `js/ui/render.js` (Fans First preview banner)

1. Add a single `POPULARITY_SCALE` constant to `add_popularity.js`, applied at
   the assignment point (our lines 117–123, where `NAMED` overrides and
   `formulaPopularity()` both land). This is the structurally valuable half of
   the upstream change: without it, re-running the generator silently reverts any
   global popularity adjustment made to `players.json`.
2. **Ship it at `1.0`** — no behaviour change on landing.
3. Remove the `Math.min(1, …)` upper bound in all three call sites (0 floor
   kept). Document in-comment that it is currently inert for AFL, with the
   measured max (99) as the reason.
4. **Defer choosing a real scale value to Phase C** of the build-out plan, where
   the sweep harness can measure it. Whatever value is chosen must be checked
   against `POP_FLOOR = 35` — if `median × SCALE < 35`, the mechanic is dead.
   Consider instead re-deriving `POP_FLOOR`/`POP_CEIL` from the actual AFL
   distribution (38–99), which is the more honest fix and makes the scale knob
   unnecessary.

**Verify:** rerun `scripts/update_players.sh` and confirm `players.json` is
byte-identical at `SCALE = 1.0`. That is the regression test for step 1.

---

### 2.2 Out-of-position chemistry penalty
**Upstream:** `eefa560`
**Ours:** `js/logic/chemistry.js:287`, `js/ui/render.js` (slot borders, report
card badge, fit chip)

1. `penalty('fit-<slot>', 0.03, …)` → `0.12`, and update the user-visible string
   from `-3%` to `-12%`.
2. Recolour out-of-position placements **amber → red** in three UI spots. Our
   `chemistry.js` header comments were ported from the NBA file and carry the
   same stale claim upstream called out — that OOP is a positive synergy. Fix the
   comments too.
3. **Check the arithmetic before shipping.** Two AFL-specific differences from
   the NBA case:
   - We have **six** starter slots, not five. Worst case is `6 × −12% = −72%`,
     against NBA's −60%.
   - `FAMILY_CAPS.position = 0.22` — confirm at `chemistry.js:955` whether that
     cap applies to *penalties* or only to positive synergies (the comment at
     line 48 says penalties are exempt from `SYNERGY_SCALE`; the cap is a
     separate mechanism and needs reading). If penalties are uncapped, a
     six-slot all-OOP roster is a −72% cliff that no other single mechanic can
     approach. Decide deliberately: either accept it as intended (bad positional
     fits *should* be ruinous) or cap the family.

**Verify:** hand-build a deliberately mis-slotted roster in the browser and read
the Team Chemistry Report; the numbers must add up to what the sim applies.

---

### 2.3 `seasonGrade()` — the results hero's letter grade
**Upstream:** `b30bf9d` (part) → `js/logic/seasonTier.js`
**Ours:** `js/logic/seasonTier.js`

Upstream adds a finer-grained letter grade beside the existing tier label,
pinned to the tier boundaries so the letter and label never disagree. Straight
rescale from 82 games to 22, anchored on our existing `seasonTier()` cut points
(22 / 19 / 16 / 8):

| Grade | NBA wins | AFL wins | Anchored to |
|---|---|---|---|
| S | 82 | **22** | `perfect` |
| A+ | ≥73 | **≥19** | `historic` |
| A | ≥65 | **≥16** | `elite` |
| B+ | ≥55 | **≥12** | midpoint |
| B | ≥41 | **≥8** | `playoff` (finals floor) |
| C | ≥30 | **≥6** | — |
| D | ≥20 | **≥4** | — |
| F | else | else | — |

Port the docstring's reasoning with it — it explains why the ladder is finer than
the tier ladder, which is the kind of thing that gets "simplified" away later.

---

### 2.4 Delete the paced season-sim screen
**Upstream:** `095bded` (part)
**Ours:** `js/ui/render.js`, `js/ui/events.js`, `js/logic/state.js`, `index.html`

Simulate goes straight from drafting → results. The "Season in progress" reveal
screen and all its machinery come out.

Remove:
- `render.js`: `renderSeasonSim()` (~1706), `renderSeasonTickerRows()` (~1672),
  `liveStreakLabel()` (~1664), the `'season-sim'` entries in `PHASE_HASH` (~3103)
  and the `render()` dispatch (~3133).
- `events.js`: `runSeasonReveal()` (~969+), `updateSeasonSimDOM()`, the
  `season-continue` / `season-skip` action handlers (~295–299), the reveal-state
  resets (~857–860), and the now-unused imports at ~42–43
  (`renderSeasonTickerRows`, `liveStreakLabel`, `clearToastsOfKind` — check
  whether `clearToastsOfKind` has other callers before dropping the export).
- `state.js`: `seasonRevealIdx`, `seasonPaused`, `rivalTease`, `rivalTeased`.
  **Keep `seasonGames`** — it is repurposed as the source for the new pip strip.
  Update the `phase` union comment to drop `'season-sim'`.
- `render.js:3063`: drop `'season-sim'` from `CG_GAMEPLAY_PHASES` (CrazyGames
  gameplay-state signalling).
- `styles.css`: `.season-sim-main`, `.season-sim-ticker`.

**Must be preserved** (upstream is explicit that it kept all of these):
result data, streak computation, **Rivalry Night** game ordering, cold-open
reordering, the personal-best toast, and the Daily Statistics modal's timing.
The *reveal* dies; the *data* it revealed does not.

**AFL-specific:** confirm nothing in the AFL playoffs/series flow reaches for
`S.phase === 'season-sim'`. Our `playoffs.js` was rewritten for the Final Eight
and may have picked up its own references.

---

### 2.5 Team Report popup
**Upstream:** `095bded` (part)
**Ours:** `js/ui/render.js`, `js/ui/events.js`

Move the analysis blocks off the main results scroll into a modal, so results
stays focused on record → finals CTA → save/share.

Into the modal: **Loss Autopsy, Team Chemistry Report, Fans, Season Leaders,
Team Statistics, Optimized Lineup.** Stays on the main screen: the perfect-season
congrats card (a celebration, not analysis).

New builders to write, mirroring upstream's decomposition:
`renderAutopsyReportCard`, `renderChemistryReportCard`, `renderFansReportCard`,
`renderSeasonLeadersReportCard`, `renderTeamStatsReportCard`,
`renderOptimizedLineupReportCard`, `reportRosterRow`, `reportStatBar`, plus the
modal shell `renderTeamReportModal` / `showTeamReportModal` /
`closeTeamReportModal` and an `open-team-report` action.

Follow the existing leaderboard/daily-stats modal pattern already in our
`storage.js`/`render.js`: backdrop, X, Escape, click-outside, focus trap. Note
upstream's implementation detail — the modal mounts **outside `#app`**, so its
buttons use inline `onclick` + `window.*` exports rather than the delegated
`data-action` handler, which only listens inside `#app`.

**AFL translation — `REPORT_STAT_MAXES`.** Upstream ships
`{ ppg:150, rpg:65, apg:40, spg:10, bpg:10 }`. Do **not** transliterate. Our
`render.js:1995` already has the AFL scale for the equivalent bars:

```js
{ goals: 16, marks: 35, disposals: 160, tackles: 28, clearances: 30 }
```

Reuse those, and check them once against real season leaders now that
`players.json` holds real data — they were set against the 41-player stub.

**AFL translation — Optimized Lineup cost.** `optimizeLineup` is 720
permutations at six slots vs the NBA's 120. It now runs inside a modal the player
opens on demand rather than in the main results render, which is a small win, but
`afl-build-out-plan.md` §G.5 already flags this path. Measure it here rather than
deferring again.

---

### 2.6 Results screen — the broadcast hero
**Upstream:** `b30bf9d` (part)
**Ours:** `js/ui/render.js:1898 renderResults()`, `css/styles.css`

Replaces the centred record card (`results-block--record`, our ~2078) with a
dark gradient hero band.

| Piece | NBA | AFL |
|---|---|---|
| Eyebrow | `Season Complete · <mode>` | same |
| Grade badge | gold, `seasonGrade()` | same (§2.3 ladder) |
| Record | oversized Barlow `W–L` | same |
| Sub-line | `Projected N% · Team OVR n · #s seed` | same — our `getPlayerSeed()` already returns 1–8 |
| Seed shown when | `wins >= 20` | **`wins >= 8`** — our finals floor, and the gate `render.js:2116` already uses |
| Pip strip | 82 pips | **22 pips** — `S.seasonGames?.length === 82` → `=== 22` |
| Quick tiles | OVR / CHEM / FANS / COACH | same |
| Signal row | mode badge only | same |

**Pip strip specifics.** Ours is 22 pips against upstream's 82 — roughly 4× the
width per pip. Two consequences: (a) restyle rather than inherit, since pips
sized for 82 will look sparse and undersized at 22; (b) upstream's aria-label
(`"Season game log: N wins, M losses"`) ports directly — our home-and-away sim
has no draws (`simulation.js:501` computes `losses: 22 - wins`), so the pip
binary holds. Draws exist only in the Grand Final path, which the strip never
covers.

Also in this unit:
- **Finals CTA** becomes the full-width gradient button, with a neutral locked
  variant below the bid threshold. Our existing copy is good and should survive
  the restyle — "Sneak that N-win squad into the eight anyway — every low seed
  dreams of a boilover" and "Need at least 8 wins to crack the eight."
- **Loss autopsy** collapses to a slim red strip that doubles as run-it-back
  (read-only in Daily — one attempt). Needs the new `runItBackFromReport()` /
  `startFreshDraft()` split from `events.js`.
- **Season leaders** compact to one line per category.
- **Block order:** finals CTA ahead of the save-run card at every width.

---

### 2.7 Playoffs screen — broadcast band
**Upstream:** `b30bf9d` (part)
**Ours:** `js/ui/render.js` (playoffs), `js/logic/playoffs.js` (read-only)

Upstream's band is `NBA Playoffs` / `ROAD TO THE RING` / seed + live series line.

**This is the unit with the most real translation work**, because our bracket is
structurally different — the AFL Final Eight (McIntyre) has **four rounds with a
double chance**, not three single-elimination rounds.

| Piece | NBA | AFL |
|---|---|---|
| Eyebrow | `NBA Playoffs` | `AFL Finals` |
| Headline | `ROAD TO THE RING` | `ROAD TO THE FLAG` |
| Champion headline | `🏆 WORLD CHAMPIONS!` | `🏆 PREMIERS!` |
| Other-team headline | `<TEAM> WIN THE TITLE` | `<CLUB> WIN THE FLAG` |
| Champion banner label | `NBA Champion` | `AFL Premiers` |
| `BRACKET_ROUND_LABELS` | `['Quarterfinals','Semifinals','Finals']` (3) | **4 entries**, short forms: `['Finals Wk 1','Semis','Prelims','Grand Final']` |
| Sub-line | `Regular season W–L · #s seed · <status>` | `Home & away W–L · #s seed · <status>` |

`ROUND_NAMES` already exists correctly at `playoffs.js:29`
(`['Finals Week 1','Semi Finals','Preliminary Finals','Grand Final']`) and drives
the Simulate button label. `BRACKET_ROUND_LABELS` is the *short* set for the
status line only — upstream added it precisely because the long names wrapped on
phones, and our long names are longer still.

**The live-status line needs rewriting, not porting.** Upstream reads
`bd.qf` / `bd.sf` / `bd.finals` off `getBracketDisplayState()`. Ours
(`playoffs.js:70`) returns `week1` (4 matchups) / `week2` (`{matchups, byes}`) /
`week3` / `week4`. The `week2.byes` case has no NBA analogue at all and must be
handled explicitly: **a player on the double chance is not in a Week 2 matchup**,
so upstream's `slots.find(m => m.top.isPlayer || m.bottom.isPlayer)` returns
nothing and the line silently degrades to a bare round name. Correct behaviour is
a dedicated string — "Won the Qualifying Final · straight to a Preliminary" or
similar. Getting this wrong is invisible in testing unless you specifically play
a top-4 seed.

Same for elimination: our Week 1 losers are only *sometimes* eliminated (QF loss
= second chance, EF loss = out). `po.eliminatedIn` already encodes this, but the
status line must not imply a QF loss ended the run.

Remaining, mechanical: the `.brk-o` accent override on the player row and live
matchup, the phone swipe hint, and moving simulate/continue into the band's
button set.

---

### 2.8 Starting Six, Season Impact card, de-orange CTAs
**Upstream:** `4543826`
**Ours:** `js/ui/render.js`, `css/styles.css`

1. **`Starting 5` → `Starting 6`.** Card sits right after the quick tiles: slot
   label, name, club + decade, OVR badge (reuse our existing `ovrColor()`).
   `POSITIONS.map(...)` already yields our six — `KD / HB / MID / RUC / KF / SF`
   — so the loop is unchanged and only the heading string moves. Note there are
   **three** `Starting 5` strings upstream (results card, and two in the
   series/share paths at ~2723 and ~2886); check all equivalents here.
   Deliberately lighter than the modal's Optimized Lineup: no per-game stats.
2. **Season Impact card** becomes the first section of the Team Report modal,
   carrying the Team OVR Elo and coach-mastery detail chips pulled off the main
   results row. The Fans Elo detail folds into the existing Fans card's Hype
   Boost/Penalty row rather than getting its own section.
3. **De-orange the CTAs.** `.courtside-cta` / `.btn-courtside` move from the
   accent gradient to a flat `var(--primary)` fill, with a new `--primary-soft`
   shadow token in both themes. Upstream's trap, which applies to us verbatim:
   `.btn-courtside-outline` is *shared* with "Share Result", so the blue
   treatment needs a narrow `--playoffs` modifier scoped to "Simulate Entire
   Finals" only. Under our renamed prefix these become `.boundary-cta` /
   `.btn-boundary` / `.btn-boundary-outline--finals`.

---

### 2.9 Progressive Web App
**Upstream:** `cf6d397`
**Ours:** new `manifest.webmanifest`, new `sw.js`, new `icons/`, `index.html`

Mechanical, with **two AFL-specific traps that will silently break it.**

**Trap 1 — GitHub Pages subpath.** Upstream is served from a domain root
(`canyougo820.com`) and uses `"start_url": "./"`, `"scope": "./"`. We deploy to
`https://josh-eng2.github.io/AFL-22-0/`. Relative `./` is correct there *only*
because the manifest sits beside `index.html` — but the service worker's
`PRECACHE_URLS` and its registration path both need to resolve against the
subpath. Keep everything relative (`./sw.js`, `./css/…`), never absolute (`/css/…`),
and test the installed app on the real Pages URL rather than `localhost:8000`
where the subpath doesn't exist. If a custom domain lands later
(build-out plan §F.3), re-verify.

**Trap 2 — the precache list is hand-maintained and we have a file upstream
doesn't.** Copy `PRECACHE_URLS` and then diff it against our actual `js/` tree.
`js/logic/modes.js`, `js/logic/seasonTier.js`, `js/utils/pageIntegrity.js` and
`js/utils/gamedistribution.js` must all be present. A missing module means the
installed app half-loads offline — worse than not caching at all.

Manifest content:

| Field | Value |
|---|---|
| `name` | `Can You Go 22-0? — AFL All-Time Team Builder` |
| `short_name` | `22-0` |
| `description` | AFL rewrite of upstream's |
| `theme_color` / `background_color` | match our shell (`#0d1526` currently — revisit with §1) |
| `categories` | `["games","sports","entertainment"]` |
| icons | 192 / 512 (both `any` + `maskable`), `favicon.svg` |

**Icons are a hard dependency on branding.** `icons/icon-192.png`,
`icon-512.png`, `apple-touch-icon.png` do not exist here, and our `favicon.svg` /
`og-image.svg` / `logo-badge.svg` are **still the NBA basketball artwork**. This
unit cannot ship honestly before **Phase E** of the build-out plan. Shipping a PWA
whose home-screen icon is a basketball is a worse outcome than shipping no PWA —
it is the one asset a player pins to their phone.

`index.html` additions: manifest link, `theme-color`, `mobile-web-app-capable`,
the Apple meta set (`apple-mobile-web-app-title` = `22-0`), `apple-touch-icon`,
and the silent-failure SW registration block before `</body>`.

Add `CACHE_VERSION` bumping to the release checklist — a stale precache serves an
old build indefinitely.

---

### 2.10 SEO: suppress the Search thumbnail
**Upstream:** `095bded` (part)
**Ours:** `index.html:158`, `index.html:186`, `scripts/build_challenge_pages.mjs:221`

1. `max-image-preview:large` → `max-image-preview:none` in `index.html`.
2. Drop the JSON-LD `"image"` field (`index.html:186`) — Google can surface a
   structured-data image as a thumbnail independently of the robots directive.
3. Same two changes in the `build_challenge_pages.mjs` template.
4. `og:image` / `twitter:image` **untouched** — they feed social share cards,
   which this directive does not affect.

**Port the trade-off comment verbatim, adapted.** Upstream flip-flopped on this
twice and the inline comment is the record of why: `none` opts the page out of
Google Discover entirely, and that was accepted deliberately. Without the
comment, someone reverts it in three months.

**Ours differs upstream here:** `daily.html`, `daily/*.html` and `sitemap.xml`
were **deleted** during the port and don't exist yet. Upstream's changes to those
files have nothing to apply to. Fold this into **Phase D** of the build-out plan
(regenerate `daily/`) — the generator template change in step 3 is what makes the
regenerated pages come out right, so it must land *before* Phase D runs, not
after.

---

## 3. Sequencing

Two independent tracks. The gameplay track is short and unblocked; the UI track
is long and gated on the accent decision.

```
   §1 accent + palette decision  ◄── blocks the whole UI track
            │
   ┌────────┴─────────────────────────────────────────────┐
   │  UI track                                            │
   │  2.3 seasonGrade  ──► 2.6 results hero ──► 2.8 six/impact/CTAs
   │  2.4 drop sim screen ──► 2.5 Team Report ──┘
   │  2.7 playoffs band (parallel, own translation work)
   └──────────────────────────────────────────────────────┘

   Gameplay track (independent, land first)
   2.1 popularity knob @1.0  ──► (value deferred to Phase C)
   2.2 OOP penalty + red styling

   Platform track
   2.10 SEO/robots ──► gates Phase D (daily pages)
   2.9 PWA ◄── hard-blocked on Phase E branding assets
```

**Suggested commit order** — each is independently reviewable and playable:

1. `2.1` popularity knob at 1.0 + clamp removal *(no behaviour change)*
2. `2.2` OOP penalty + red styling *(gameplay change, ship alone)*
3. `2.10` SEO/robots + generator template
4. `2.3` `seasonGrade()`
5. `2.4` drop the season-sim screen *(large deletion, ship alone)*
6. `2.5` Team Report popup
7. `2.6` results hero + `2.8` Starting Six / Season Impact / CTAs
8. `2.7` playoffs band
9. `2.9` PWA *(last — gated on Phase E)*

Regenerate `css/tailwind.css` via `scripts/build_tailwind.sh` after any commit
that adds or removes Tailwind classes (5–8 all do).

**Effort:** roughly 4–6 working days for units 2.1–2.8, plus 2.7's bracket
translation as the main unknown. 2.9 is under a day once branding exists.

---

## 4. Interaction with the existing build-out plan

This work **does not replace** `afl-build-out-plan.md`; it interleaves.

| This plan | Existing plan | Relationship |
|---|---|---|
| §1 accent decision | Phase E (branding) | **Pull Phase E's accent choice forward.** Doing it after the UI port means theming twice. |
| 2.1 popularity value | Phase C (balance) | Knob lands now; **value** set by the sweep harness. |
| 2.2 OOP magnitude | Phase C | Ships at 0.12 to match our logjam; re-check under sweeps. |
| 2.5 `REPORT_STAT_MAXES` | Phase C.2.6 (`statBar` maxes) | Same numbers, one job — do them together. |
| 2.5 optimizeLineup cost | Phase G.5 | Measure during 2.5 rather than deferring again. |
| 2.9 PWA icons | Phase E | **Hard block.** No AFL icons, no PWA. |
| 2.10 SEO template | Phase D (daily pages) | Must land **before** Phase D regenerates `daily/`. |
| all | Phase G (QA) | Adds the matrix in §5 to Phase G. |

---

## 5. Verification

No automated tests exist in this repo, so verification is a browser matrix. Add
to Phase G:

- [ ] Full run: draft → **straight to results** (no reveal screen) → Team Report
      → Finals → Grand Final. Confirm the reveal screen is genuinely gone, not
      just unreachable.
- [ ] Pip strip renders **22** pips and the count matches `W–L`.
- [ ] Grade badge and tier label agree at each boundary: 22, 19, 18, 16, 15, 12,
      8, 7, 4, 0 wins.
- [ ] Seed sub-line appears at ≥8 wins, hidden below.
- [ ] **Finals status line as a top-4 seed** — the double-chance / bye path
      (§2.7). This is the port's most likely silent failure.
- [ ] Finals status line as seeds 5–8, after a QF loss (not eliminated) and
      after an EF loss (eliminated).
- [ ] Team Report modal: backdrop, X, Escape, click-outside, focus trap; opens
      from the results screen and from a Daily run.
- [ ] Loss-autopsy strip is **read-only in Daily** (one attempt) and run-it-back
      elsewhere.
- [ ] Rivalry Night ordering, cold-open reordering, streak, personal-best toast,
      Daily Statistics modal all still fire with the reveal screen removed.
- [ ] OOP placements show **red**, and the report's arithmetic matches the sim.
- [ ] Light + dark on every changed screen; the theme toggle drives it with no JS
      branching (upstream's stated design constraint).
- [ ] Mobile widths: band sub-lines must not wrap to a second row — the reason
      `BRACKET_ROUND_LABELS` exists at all.
- [ ] PWA: install on Android + iOS **from the real Pages subpath**; go offline
      and complete a Classic run.
- [ ] `players.json` byte-identical after `update_players.sh` at `SCALE = 1.0`.
- [ ] Degradation unchanged: fonts blocked, Firebase unreachable, confetti CDN
      blocked.

---

## 6. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `POPULARITY_SCALE = 0.4` copied verbatim | Fans hype, Fans First mode and the AI's popularity weight all go flat — and **silently**, since nothing errors | §2.1: land at 1.0; set the value in Phase C against `POP_FLOOR` |
| Finals status line ports NBA's 3-round shape | Top-4 seeds on the double chance get a wrong or blank status; invisible unless specifically tested | §2.7 explicit `week2.byes` handling + the §5 checklist item |
| UI ported in NBA orange, re-themed in Phase E | Same CSS themed twice | §1 — decide the accent first |
| PWA ships with basketball icons | The one asset players pin to a home screen | §2.9 hard-blocked on Phase E |
| Precache list copied without diffing our tree | Installed app half-loads offline | §2.9 trap 2 |
| OOP −12% × 6 slots uncapped | A −72% cliff no other mechanic approaches | §2.2 step 3 — read `FAMILY_CAPS` behaviour before shipping |
| Season-sim deletion takes live features with it | Rivalry Night / cold open / toasts quietly stop firing | §2.4 preserve-list + §5 |
| Upstream keeps moving | Gap reopens | Record the upstream SHA in each commit message; re-diff against upstream `main` before starting |
| `sitemap.xml` / `daily.html` don't exist here | Parts of `095bded` have no target | §2.10 — folded into Phase D, not ported blind |

---

## 7. Explicitly out of scope

- **`players.json` (1,876 lines changed upstream)** — that is the NBA player
  database. Ours is independently derived from AFL Tables. Never merge it.
- **`data/nba2k_*`** — NBA 2K rating sources; no AFL analogue, already stripped.
- **`daily/*.html` refresh commits** — generated output, regenerated by our own
  Phase D run.
- **Upstream `sitemap.xml` / `CNAME`** — NBA-domain-specific; recreated in
  Phase F for our domain.
