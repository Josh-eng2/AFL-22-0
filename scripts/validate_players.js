'use strict';
/**
 * scripts/validate_players.js
 * Structural sanity checks for players.json — run after every player
 * data batch (see docs/player-data-audit/rubric.md once it's rewritten
 * for AFL — see docs/afl-port-plan.md in the meantime).
 *
 * This is NOT a realism check — it only catches mechanical mistakes
 * (typos, duplicate ids, out-of-range values, wrong trait counts, a
 * player placed at a club before that club existed) that would
 * otherwise sit undetected across many batches.
 *
 * Run:  node scripts/validate_players.js
 * Exits non-zero and prints every violation if any are found.
 */
const fs   = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'players.json');

// Six-slot AFL position model (defence → forward axis). See
// docs/afl-port-plan.md §3.2.
const POSITIONS = new Set(['KD', 'HB', 'MID', 'RUC', 'KF', 'SF']);

// AFL archetypes replacing the NBA six. See docs/afl-port-plan.md §3.3.
const ARCHETYPES = new Set([
  'Ball Magnet', 'Goal Sneak', 'Power Forward',
  'Intercept Marker', 'Lockdown Defender', 'Ruck Bull',
]);

// Season-average bounds (NOT single-game bounds) — generous on purpose,
// this is a typo/fabrication net, not a realism check. hitouts is a
// display/synergy-only stat (see docs/afl-port-plan.md §D4/§3.6) — it's
// still bounds-checked here so a stray typo doesn't slip through, but it
// is deliberately excluded from add_rating.js's weighted formula.
const STAT_BOUNDS = {
  disposals:  [0, 42],
  goals:      [0, 8],
  marks:      [0, 12],
  tackles:    [0, 10],
  clearances: [0, 12],
  hitouts:    [0, 55],
};

const BUCKET_KEY_RE = /^[A-Za-z]+_(19[7-9]0s|20[0-2]0s)$/;

// Clubs that didn't exist (in their current form) for the full 1970s-2020s
// range this game covers. Any club not listed here is treated as having
// existed the whole time (true for every "continuous VFL/AFL presence" club
// in docs/afl-port-plan.md §3.1). Value = first year the club fielded a team
// under this bucket identity; a decade bucket is legal if the decade's last
// year (decadeStart + 9) is >= that first year.
//
// Brisbane Lions bucket key covers the Brisbane Bears era (1987-1996) and
// the post-1997 merged Lions — see the plan's note on folding Fitzroy in.
const CLUB_FIRST_YEAR = {
  WestCoast:     1987,
  BrisbaneLions: 1987,
  Adelaide:      1991,
  Fremantle:     1995,
  PortAdelaide:  1997,
  GoldCoast:     2011,
  GWS:           2012,
};

function main() {
  let raw;
  try {
    raw = fs.readFileSync(SRC, 'utf8');
  } catch (e) {
    fail([`Could not read ${SRC}: ${e.message}`]);
  }

  let db;
  try {
    db = JSON.parse(raw);
  } catch (e) {
    fail([`players.json is not valid JSON: ${e.message}`]);
  }

  const errors = [];
  const idsSeen = new Map(); // id -> [ "Club_decade / Name", ... ]

  for (const bucketKey of Object.keys(db)) {
    if (!BUCKET_KEY_RE.test(bucketKey)) {
      errors.push(`Bucket key "${bucketKey}" doesn't match Club_decade pattern`);
    } else {
      const [club, decade] = bucketKey.split('_');
      const firstYear = CLUB_FIRST_YEAR[club];
      if (firstYear != null) {
        const decadeStart = parseInt(decade, 10);
        const decadeEnd    = decadeStart + 9;
        if (decadeEnd < firstYear) {
          errors.push(
            `Bucket "${bucketKey}": ${club} didn't exist until ${firstYear} — ` +
            `this bucket predates the club entirely`
          );
        }
      }
    }

    const players = db[bucketKey];
    if (!Array.isArray(players)) {
      errors.push(`Bucket "${bucketKey}" is not an array`);
      continue;
    }

    for (const p of players) {
      const where = `${bucketKey} / ${p.name || p.id || '(unnamed)'}`;

      if (!p.id || typeof p.id !== 'string') {
        errors.push(`${where}: missing or invalid "id"`);
      } else {
        const label = `${bucketKey} / ${p.name || p.id}`;
        if (!idsSeen.has(p.id)) idsSeen.set(p.id, []);
        idsSeen.get(p.id).push(label);
      }

      if (!p.name || typeof p.name !== 'string') {
        errors.push(`${where}: missing or invalid "name"`);
      }

      if (!POSITIONS.has(p.pos)) {
        errors.push(`${where}: invalid pos "${p.pos}" (must be one of ${[...POSITIONS].join(', ')})`);
      }

      for (const [stat, [min, max]] of Object.entries(STAT_BOUNDS)) {
        const v = p[stat];
        if (typeof v !== 'number' || Number.isNaN(v)) {
          errors.push(`${where}: "${stat}" is not a number (${JSON.stringify(v)})`);
        } else if (v < min || v > max) {
          errors.push(`${where}: "${stat}" = ${v} is outside sane bounds [${min}, ${max}]`);
        }
      }

      if (!ARCHETYPES.has(p.archetype)) {
        errors.push(`${where}: invalid archetype "${p.archetype}" (must be one of ${[...ARCHETYPES].join(', ')})`);
      }

      if (!Array.isArray(p.traits)) {
        errors.push(`${where}: "traits" is not an array`);
      } else if (p.traits.length !== 2 && p.traits.length !== 3) {
        errors.push(`${where}: "traits" has ${p.traits.length} entries (must be 2 or 3)`);
      } else if (p.traits.some(t => typeof t !== 'string' || !t.trim())) {
        errors.push(`${where}: "traits" contains an empty/non-string entry`);
      }

      if (typeof p.popularity !== 'number' || !Number.isInteger(p.popularity)) {
        errors.push(`${where}: "popularity" = ${JSON.stringify(p.popularity)} is not an integer`);
      }
    }
  }

  for (const [id, labels] of idsSeen) {
    if (labels.length > 1) {
      errors.push(`Duplicate id "${id}" used by: ${labels.join(' | ')}`);
    }
  }

  if (errors.length) fail(errors);

  const totalPlayers = Object.values(db).reduce((n, arr) => n + arr.length, 0);
  console.log(`OK — ${Object.keys(db).length} buckets, ${totalPlayers} players, no structural issues found.`);
}

function fail(errors) {
  console.error(`FAILED — ${errors.length} issue(s):\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

main();
