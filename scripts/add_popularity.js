'use strict';
/**
 * scripts/add_popularity.js
 * Sets the `popularity` integer (35-99) on every player in players.json.
 * Run:  node scripts/add_popularity.js
 *
 * Precedence, highest first:
 *  1. NAMED  — curated household-name overrides. Recognition is cultural, not
 *     statistical: Jason Dunstall and Dermott Brereton are famous for reasons
 *     no stat line encodes, and a quiet 300-gamer can out-rate a superstar on
 *     raw output.
 *  2. The value afl_build_db.mjs already computed from real signals (Brownlow
 *     votes across the club-decade, games played, finals appearances, quality
 *     composite). This is a far better prior than any single-stat formula —
 *     crucially it doesn't punish defenders and rucks, who score few goals.
 *  3. formulaPopularity() — last-resort fallback for entries built outside the
 *     pipeline (e.g. a hand-added player).
 *
 * The NBA original recomputed popularity for everyone from a points-per-game
 * formula. That is exactly the wrong shape for AFL: goals are concentrated in
 * two positions, so a goals-driven formula would rate every key defender as
 * an unknown. Hence the precedence above.
 */
const fs   = require('fs');
const path = require('path');

const SRC  = path.join(__dirname, '..', 'players.json');
const db   = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// ─── Global popularity scale ─────────────────────────────────────────────────
// Single knob for a league-wide popularity adjustment, applied at the
// assignment point below. Without it, any global change made directly to
// players.json is silently reverted the next time this script runs.
//
// Currently 1.0 — identity, no behaviour change. The upstream NBA game runs
// 0.4 (a 60% cut); do NOT copy that value here. Measured over our 828 entries
// popularity is min 38 / median 72 / max 99, and simulation.js clamps at
// POP_FLOOR = 35, so a 0.4 scale drops the median to ~29 — under the floor.
// popNorm would pin to 0 for nearly every roster and flatten fan hype, the
// Fans First mode, and the AI draft's popularity weight, without erroring.
// The FLOOR_WARN check at the end of this file guards exactly that mistake.
// Pick a real value from the Phase C sweeps (docs/afl-build-out-plan.md), and
// consider re-deriving POP_FLOOR/POP_CEIL from the real distribution instead.
const POPULARITY_SCALE = 1.0;

// Mirror of simulation.js's POP_FLOOR — only used for the sanity warning.
const POP_FLOOR = 35;

// ─── Curated household names (name → popularity) ─────────────────────────────
// Names must match the DISAMBIGUATED names in players.json (Gary Ablett Sr /
// Gary Ablett Jr, Josh P. / Josh J. Kennedy) — see scripts/afl_positions.mjs.
const NAMED = {
  // Immortals / modern superstars
  'Gary Ablett Sr': 99, 'Gary Ablett Jr': 97, 'Wayne Carey': 97,
  'Leigh Matthews': 96, 'Tony Lockett': 96, 'Jason Dunstall': 92,
  'Lance Franklin': 96, 'Dustin Martin': 95, 'Chris Judd': 92,
  'Nathan Buckley': 91, 'James Hird': 93, 'Michael Voss': 90,
  'Robert Harvey': 88, 'Nicky Winmar': 90, 'Michael Long': 90,
  'Adam Goodes': 90, 'Patrick Dangerfield': 92, 'Marcus Bontempelli': 90,
  'Patrick Cripps': 88, 'Nat Fyfe': 88, 'Scott Pendlebury': 89,
  'Joel Selwood': 89, 'Luke Hodge': 86, 'Sam Mitchell': 82,
  'Jarryd Roughead': 80, 'Cyril Rioli': 89, 'Buddy Franklin': 95,

  // Cult figures / crowd favourites
  'Dermott Brereton': 88, 'Warwick Capper': 86, 'Peter Daicos': 90,
  'Tony Modra': 84, 'Brendan Fevola': 84, 'Eddie Betts': 92,
  'Jim Krakouer': 82, 'Phil Krakouer': 78, 'Maurice Rioli Sr': 82,
  'Robert DiPierdomenico': 78, 'Doug Hawkins': 80, 'Rex Hunt': 62,
  'Barry Breen': 60, 'Kevin Bartlett': 86, 'Malcolm Blight': 86,
  'Robert Flower': 84, 'Bruce Doull': 82, 'Peter Knights': 80,

  // Champions of their clubs
  'Stephen Silvagni': 85, 'Dustin Fletcher': 82, 'Glenn Archer': 80,
  'Matthew Scarlett': 78, 'Alex Rance': 80, 'Jeremy McGovern': 76,
  'Matthew Richardson': 84, 'Matthew Lloyd': 84, 'Nick Riewoldt': 88,
  'Matthew Pavlich': 86, 'Jonathan Brown': 86, 'Barry Hall': 85,
  'Josh J. Kennedy': 82, 'Josh P. Kennedy': 78, 'Tom Hawkins': 82,
  'Jack Riewoldt': 80, 'Travis Cloke': 74, 'Taylor Walker': 76,
  'Simon Black': 84, 'Jason Akermanis': 84, 'Shane Crawford': 84,
  'Ben Cousins': 88, 'Daniel Kerr': 74, 'Mark Ricciuto': 82,
  'Andrew McLeod': 86, 'Gavin Wanganeen': 82, 'Paul Kelly': 80,
  'Michael OLoughlin': 80, "Michael O'Loughlin": 80, 'Brett Kirk': 74,
  'Chris Grant': 78, 'Brad Johnson': 78, 'Rohan Smith': 68,
  'Wayne Schimmelbusch': 74, 'Todd Goldstein': 70, 'Brent Harvey': 78,
  'Dean Cox': 78, 'Nic Naitanui': 86, 'Aaron Sandilands': 78,
  'Max Gawn': 84, 'Christian Petracca': 84, 'Clayton Oliver': 80,
  'Lachie Neale': 82, 'Dayne Zorko': 72, 'Charlie Curnow': 80,
  'Toby Greene': 76, 'Isaac Heeney': 80, 'Errol Gulden': 74,
  'Nick Daicos': 88, 'Harry McKay': 74, 'Jeremy Cameron': 80,
  'Paul Salmon': 72, 'Gerard Healy': 72, 'Tim Watson': 80,
  'Terry Daniher': 74, 'Simon Madden': 74, 'Justin Madden': 66,
  'Gary Ayres': 74, 'John Platten': 78, 'Chris Langford': 66,
  'Stephen Kernahan': 86, 'Greg Williams': 82, 'Craig Bradley': 78,
  'Anthony Koutoufides': 82, 'Marc Murphy': 68, 'Trent Cotchin': 78,
  'Jack Riewoldt Richmond': 78, 'Dane Swan': 84, 'Steele Sidebottom': 70,
  'Travis Boak': 72, 'Kane Cornes': 68, 'Warren Tredrea': 74,
  'Robbie Gray': 78, 'Ollie Wines': 70, 'Rory Sloane': 74,
  'Ken Hinkley': 58, 'Peter Hudson': 84, 'Bernie Quinlan': 74,
  'Michael Roach': 72, 'Ross Glendinning': 70, 'Guy McKenna': 68,
  'Dean Kemp': 70, 'Chris Lewis': 70, 'Peter Matera': 78,
  'Scott Lucas': 68, 'Chris Tarrant': 66, 'Jarrad Waite': 62,
  'Max King': 70, 'Jamarra Ugle-Hagan': 72, 'Jack Lukosius': 62,
  'Tom J. Lynch': 74, 'Tom T. Lynch': 58, 'Eric Hipwood': 60,
  'Sam Reid': 60, 'Jamie Elliott': 70, 'Bayley Fritsch': 66,
};

// ─── Stat-based fallback (last resort only) ─────────────────────────────────
function formulaPopularity(player) {
  const goalsBase = Math.min((player.goals || 0) / 4, 1) * 40;
  const supportBase =
    ((player.disposals  || 0) / 30) * 22 +
    ((player.marks      || 0) / 8)  * 10 +
    ((player.tackles    || 0) / 6)  * 6 +
    ((player.clearances || 0) / 8)  * 6 +
    ((player.hitouts    || 0) / 35) * 8;
  const base = Math.round(35 + goalsBase + supportBase);

  // Deterministic jitter from the player id so the same player always
  // gets the same score (no randomness).
  let hash = 0;
  const seed = player.id || player.name || '';
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  const jitter = Math.abs(hash % 7) - 3; // -3 … +3

  return Math.min(99, Math.max(35, base + jitter));
}

// ─── Apply ────────────────────────────────────────────────────────────────────
// Each run resolves an UNSCALED base first, then writes
// `popularity = round(base * POPULARITY_SCALE)`. Re-running with a different
// scale therefore re-derives from the base rather than compounding on the
// already-scaled value.
//
// Only the pipeline branch has to persist its base (as `popularityBase`),
// because it is the one input this script cannot recompute: afl_build_db.mjs
// wrote it, and that needs the gitignored ~137 MB corpus. NAMED and the
// formula are both re-derived from source on every run, so they stay
// idempotent with nothing stored — and NAMED keeps winning outright, so
// editing the table above still takes effect on the next run.
//
// `popularityBase` is stripped from the shipped bundle by inline_players.js
// (PIPELINE_ONLY); it lives in players.json, the source of truth.
let total = 0, named = 0, kept = 0, formula = 0;
const scaled = [];

for (const key of Object.keys(db)) {
  for (const player of db[key]) {
    let base;
    if (NAMED[player.name] !== undefined) {
      base = NAMED[player.name];
      named++;
    } else if (Number.isInteger(player.popularityBase) && player.popularityBase >= 1) {
      base = player.popularityBase;                 // captured on an earlier run
      kept++;
    } else if (Number.isInteger(player.popularity) && player.popularity >= 1) {
      base = player.popularityBase = player.popularity;  // first run — capture it
      kept++;
    } else {
      base = formulaPopularity(player);
      formula++;
    }

    player.popularity = Math.max(0, Math.round(base * POPULARITY_SCALE));
    scaled.push(player.popularity);
    total++;
  }
}

fs.writeFileSync(SRC, JSON.stringify(db, null, 2), 'utf8');

scaled.sort((a, b) => a - b);
const median = scaled[Math.floor(scaled.length / 2)];

console.log(`Done.`);
console.log(`  Total players       : ${total}`);
console.log(`  Curated overrides   : ${named}`);
console.log(`  Pipeline-computed   : ${kept}`);
console.log(`  Formula fallback    : ${formula}`);
console.log(`  Scale applied       : ${POPULARITY_SCALE}`);
console.log(`  Popularity min/med/max : ${scaled[0]} / ${median} / ${scaled[scaled.length - 1]}`);

// Self-check: a scale that pushes the median under simulation.js's POP_FLOOR
// silently kills fan hype rather than reducing it. Warn loudly.
if (median < POP_FLOOR) {
  console.warn(
    `\n  ⚠  WARNING: median popularity ${median} is below POP_FLOOR (${POP_FLOOR}).\n` +
    `     simulation.js clamps popNorm at 0 under that floor, so fan hype, the\n` +
    `     Fans First mode and the AI draft's popularity weight are now flat for\n` +
    `     most rosters. Lower POPULARITY_SCALE is not the knob you want here —\n` +
    `     re-derive POP_FLOOR/POP_CEIL from the real distribution instead.`
  );
}

console.log(`Wrote ${SRC}`);
