# Player data realism rubric (AFL)

Methodology for auditing `players.json`. Read this before touching any batch —
it is written so a session with zero memory of prior conversations can execute
correctly without re-deriving any of these decisions.

**Source of truth:** `players.json` at the repo root. `js/data/players.js` is
generated — never hand-edit it; regenerate with `bash scripts/update_players.sh`.

**Most entries should not be hand-edited at all.** Unlike the NBA original
this game is ported from — where every stat line was typed in by hand — this
database is *derived* from a real per-game corpus
(`akareen/AFL-Data-Analysis`, MIT, pinned; see `data/README.md`). If a stat
line is wrong, the fix almost always belongs in the pipeline
(`scripts/afl_build_seasons.mjs` / `afl_build_db.mjs`), not in the JSON —
otherwise the next pipeline run silently reverts it.

Hand-maintained layers that *are* meant to be edited:

| file | what it holds |
|---|---|
| `scripts/afl_positions.mjs` | position overrides, name repairs, collision disambiguation |
| `scripts/add_popularity.js` | curated household-name popularity |

**Do not touch:** `secondaryPos` isn't stored — `js/logic/positions.js`
derives it at runtime from `pos` and the stat line. Fixing `pos` fixes the
secondary automatically.

---

## Per-field targets

### Stats (`disposals`, `goals`, `marks`, `tackles`, `clearances`, `hitouts`)

Each entry is one player's **real per-game averages from a single real
season** at that club, within that decade — never a decade average, and never
a fabricated "sounds about right" line. The pipeline enforces this by picking
the player's best qualifying season (>= 8 games) by stat composite.

`hitouts` is display/synergy-only: it is deliberately excluded from
`add_rating.js`'s weighted formula (port plan §D4) because it is ~zero for
five of the six positions and would distort the balance model.

### `rating` vs `overall` — don't audit them the same way

`rating` is a pure stat-line value. `overall` is the award/career composite
built by `add_overall.js`, and it is what the game actually plays on. They are
**meant to disagree**, often sharply: a key defender with a modest stat line
and a decorated career should sit far higher on `overall` than on `rating`.
That divergence is the point, not a defect — `validate_players.js` fails the
build if the two agree for more than 90% of entries, which is what a silent
regression to the old placeholder would look like.

Neither is hand-editable. To interrogate a rating, run
`node scripts/add_overall.js --explain="<player name>"`, which prints every
input, its weight, and whether it was available for that player. Full method:
`data/README.md`.

**Era plausibility.** Disposal volume did *not* simply rise over time. The
1970s was kick-dominated and its best ball-winners posted enormous numbers —
Wayne Richardson averaged 32.8 disposals in 1971 off 27 kicks a game. Do not
"correct" a large 1970s disposal count toward modern norms; check the source
first. Conversely, scoring *fell*: a 1980s forward's goal average came in a
much higher-scoring league than a 2020s forward's.

`scripts/audit_stats.js` encodes era-aware ceilings for exactly this reason.

### Imputed stats — the rule that matters most

Tackles were not recorded before **1987**; clearances not before **~1998**.
For entries in those windows the value is **estimated**, and the entry carries
`imputed: ["tackles", ...]` naming which.

Three things follow:

1. **Never treat a missing tackle/clearance as `0`.** A blank in 1975 means
   "not recorded", not "did nothing". Zeroing it makes every 1970s player look
   like a non-tackler and drags the whole era's balance ratio down.
   `validate_players.js` fails the build if this regresses.
2. **Never remove an `imputed` flag to make a line look cleaner.** The flag is
   what drives the asterisk in the UI. Silently presenting an estimate as a
   measurement is the failure mode this whole policy exists to prevent.
3. An imputed value should read as a plausible estimate for that position and
   era — not as a career-best. `audit_stats.js` flags implausible ones.

Full policy, including the zero-blank vs missing-blank column split:
`data/README.md`.

### `pos` — six slots, hand-reviewed

`KD` (key defender), `HB` (half-back), `MID`, `RUC`, `KF` (key forward),
`SF` (small forward).

**The stat-line heuristic is a first pass and must never be trusted alone.**
AFL stat lines under-determine position, and worst for exactly the players
people recognise. Glenn Archer's best season reads 12.9 disposals / 1.3 goals
/ 3.1 marks — statistically a small forward. He was one of the most famous
*defenders* of his era. Nothing in the numbers says otherwise.

It is worse before 2000: `rebound_50s`, `inside_50s`, `one_percenters` and
`contested_marks` — the columns that actually separate a half-back from a
small forward — are 0% populated pre-1990 and only ~21% in the 1990s. For the
1970s and 1980s the heuristic works from disposals / goals / marks / hitouts
alone.

**Audit protocol:**

```bash
node scripts/afl_build_db.mjs --review    # writes position-review.md
```

Then, in `docs/player-data-audit/position-review.md`:

1. Read the **"Low-confidence heuristic calls"** table at the top first.
   Any name you recognise in there deserves a decision.
2. Scan each bucket for a position that contradicts its own stat line —
   high hitouts not marked `RUC`, 25+ disposals marked `KF`, a `KD` kicking
   two goals a game.
3. Fix by adding to `POSITION_OVERRIDES` in `scripts/afl_positions.mjs` and
   re-running. Never edit `players.json` directly.

Genuine swingmen (Paul Roos at CHB *and* CHF, Kurt Tippett forward *and* ruck,
Trent Croad both ends) will always trip a contradiction check. That is fine —
pick the role they are best remembered in and let `positions.js` derive the
secondary at runtime. Note the decision rather than churning it.

### `archetype` and `traits`

Archetype in: Ball Magnet / Goal Sneak / Power Forward / Intercept Marker /
Lockdown Defender / Ruck Bull. Rule-derived from position + stat line.

Traits: **2-3** per player from the 21-trait AFL vocabulary (port plan §3.4).
Derived from real signals where possible — Brownlow votes -> *Ball Winner*,
finals played -> *Big Finals Performer*, one club across a career ->
*One-Club Champion*.

### Names

Three source defects are repaired in the pipeline, all documented in
`data/README.md`:

- stripped apostrophes (`OBrien` -> `O'Brien`) — fixed by rule;
- dropped Dutch particles (`Goey` -> `De Goey`) — fixed by explicit list;
- **collisions between different players sharing a name** — fixed by
  `NAME_BY_KEY`.

The collision case is the one to watch when adding data. Two distinct players
under one name is not merely a display error: the engine uses the name as its
cross-era clone guard (`draftedPlayerNames`), so they would wrongly block each
other in the draft. Established football convention wins where one exists
(Gary Ablett Sr / Jr; Josh P. / Josh J. Kennedy).

### `eraClubName`

Set only where a club has since been renamed or merged, so the era-accurate
identity displays: **Footscray** -> Western Bulldogs, **South Melbourne** ->
Sydney, **Brisbane Bears** / **Fitzroy** -> Brisbane Lions, **Kangaroos** ->
North Melbourne. `validate_players.js` rejects any other value.

### Club-era legality

No entry may place a player at a club in a decade that club did not exist:
West Coast and Brisbane 1987+, Adelaide 1991+, Fremantle 1995+, Port Adelaide
1997+, Gold Coast 2011+, GWS 2012+. Enforced by `CLUB_FIRST_YEAR` in
`validate_players.js`.

---

## Board quality

Each `Club_Decade` bucket is a draft board. Targets:

- **5-9 entries**, aiming for 9.
- **Genuine choice.** The validator errors on a degenerate board — fewer than
  four distinct positions, or one position exceeding 60% of the bucket.
- **Spine coverage** (`KD`, `MID`, `RUC`, `KF`) is a *warning*, not an error.
  The engine can fill any slot with any player via secondary positions or an
  out-of-position placement (a "Versatile ... (-3%)" chemistry penalty), and
  some club-decades genuinely lack a role — Port Adelaide only existed
  1997-99, and many 1970s defenders posted no stat-distinguishable profile.

---

## Running the audit

```bash
bash scripts/update_players.sh      # regenerate derived fields + js/data/players.js
node scripts/validate_players.js    # structural — MUST exit 0
node scripts/audit_stats.js         # realism triage
node scripts/audit_stats.js --decade=1980
```

`validate_players.js` is mechanical (schema, bounds, ids, legality,
blank-semantics asserts, board degeneracy). `audit_stats.js` is heuristic —
every flag is a *candidate for review*, not a proven error. **Verify against
the vendored source before changing anything**; an earlier ceiling in that
script flagged a genuine 1971 record as an outlier.

Note that `DUP` (two players with an identical stat line) is low-signal here,
unlike in the NBA original: these lines are machine-derived from real data, so
a duplicate is usually coincidence between two low-output players — a 1970s
line is only three numbers wide.
