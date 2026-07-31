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

// Stats that may legitimately be imputed — the two the source never recorded
// in the early decades (tackles pre-1987, clearances pre-1998).
const IMPUTABLE = new Set(['tackles', 'clearances']);

// Historical identities a club legitimately played under (port plan §3.1).
// Anything else in eraClubName is a data error, not a nickname.
const ERA_CLUB_NAMES = {
  WesternBulldogs: ['Footscray'],
  Sydney:          ['South Melbourne'],
  BrisbaneLions:   ['Brisbane Bears', 'Fitzroy'],
  NorthMelbourne:  ['Kangaroos'],
};

// Every board must be able to fill the spine; smalls can be covered by
// secondary positions at runtime, the key posts largely cannot.
const CORE_ROLES = ['KD', 'MID', 'RUC', 'KF'];
const MIN_BUCKET_DEPTH = 5;

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
  const warnings = [];
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

      // ── eraClubName: the era-accurate display identity ────────────────────
      // Only meaningful for clubs that changed name/merged (port plan §3.1).
      if (p.eraClubName !== undefined) {
        if (typeof p.eraClubName !== 'string' || !p.eraClubName.trim()) {
          errors.push(`${where}: "eraClubName" must be a non-empty string`);
        } else {
          const club = bucketKey.split('_')[0];
          const allowed = ERA_CLUB_NAMES[club];
          if (!allowed) {
            errors.push(`${where}: "${club}" never had an alternate identity — remove eraClubName "${p.eraClubName}"`);
          } else if (!allowed.includes(p.eraClubName)) {
            errors.push(`${where}: eraClubName "${p.eraClubName}" not valid for ${club} (expected one of ${allowed.join(', ')})`);
          }
        }
      }

      // ── A.4 blank semantics, asserted ─────────────────────────────────────
      // The whole point of the two-way blank rule is that a stat the era
      // never recorded must be IMPUTED, never silently zeroed. Guard both
      // directions so a future pipeline change can't quietly reintroduce the
      // bug: (a) imputed must name only real, imputable stats, and (b) a
      // pre-recording-era entry must not carry a bare 0.
      const decadeStart = parseInt(bucketKey.split('_')[1], 10);
      if (p.imputed !== undefined) {
        if (!Array.isArray(p.imputed) || p.imputed.length === 0) {
          errors.push(`${where}: "imputed" must be a non-empty array when present`);
        } else {
          for (const st of p.imputed) {
            if (!IMPUTABLE.has(st)) {
              errors.push(`${where}: "imputed" names "${st}" — only ${[...IMPUTABLE].join('/')} are imputable`);
            } else if (p[st] === 0) {
              errors.push(`${where}: "${st}" is flagged imputed but is 0 — imputation must produce a real estimate`);
            }
          }
        }
      }
      // Tackles aren't recorded before 1987, clearances before ~1998. A zero
      // in those windows means the blank-semantics path was bypassed.
      if (decadeStart <= 1980 && p.tackles === 0 && !(p.imputed || []).includes('tackles')) {
        errors.push(`${where}: tackles = 0 in the ${bucketKey.split('_')[1]} — tackles weren't recorded before 1987, so this must be imputed`);
      }
      if (decadeStart <= 1990 && p.clearances === 0 && !(p.imputed || []).includes('clearances')) {
        errors.push(`${where}: clearances = 0 in the ${bucketKey.split('_')[1]} — clearances weren't recorded before ~1998, so this must be imputed`);
      }
    }

    // ── Bucket must be draftable ────────────────────────────────────────────
    // The engine can fill ANY slot with ANY player — positions.js derives a
    // secondary position at runtime and out-of-position placement is legal
    // (it just carries a "Versatile … (-3%)" chemistry penalty). So a bucket
    // missing one core role is playable, not broken, and some club-decades
    // genuinely lack one (Port Adelaide only existed 1997-99; 1970s defenders
    // often posted no stat-distinguishable profile).
    //
    // What IS broken is a degenerate board — one that offers no real choice.
    // Error on that; warn on a missing core role so it stays visible.
    if (players.length >= 6) {
      const posSet = new Set(players.map(p => p.pos));
      if (posSet.size < 4) {
        errors.push(`Bucket "${bucketKey}" has ${players.length} players covering only ${posSet.size} position(s) (${[...posSet].join('/')}) — degenerate board`);
      }
      const counts = {};
      for (const p of players) counts[p.pos] = (counts[p.pos] || 0) + 1;
      const [topPos, topN] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (topN / players.length > 0.6) {
        errors.push(`Bucket "${bucketKey}" is ${Math.round((topN / players.length) * 100)}% ${topPos} (${topN}/${players.length}) — degenerate board`);
      }
      const missingCore = CORE_ROLES.filter(r => !posSet.has(r));
      if (missingCore.length) {
        warnings.push(`Bucket "${bucketKey}" has no ${missingCore.join('/')} — playable via secondary/out-of-position, but thin`);
      }
    }
    if (players.length && players.length < MIN_BUCKET_DEPTH) {
      warnings.push(`Bucket "${bucketKey}" has only ${players.length} players (target >= ${MIN_BUCKET_DEPTH})`);
    }
  }

  for (const [id, labels] of idsSeen) {
    if (labels.length > 1) {
      errors.push(`Duplicate id "${id}" used by: ${labels.join(' | ')}`);
    }
  }

  // ── `overall` — the field the game actually plays on ─────────────────────
  // Phase B replaced the placeholder `overall = rating` with a real award
  // composite (scripts/add_overall.js). The failure mode worth guarding is
  // silent regression: if add_overall.js is dropped from the pipeline, or
  // add_rating.js starts writing `overall` again, the game reverts to
  // stat-only ratings — which rank key defenders with fringe players — and
  // nothing else would notice, because every value stays structurally valid.
  //
  // So assert the composite actually ran, by checking `overall` diverges from
  // `rating`. The two agree for a handful of entries by coincidence; agreeing
  // for nearly ALL of them means the placeholder is back.
  {
    const all = Object.values(db).flat().filter(p => p && typeof p === 'object');
    const missing = all.filter(p => !Number.isInteger(p.overall));
    if (missing.length) {
      errors.push(`${missing.length} entries have no integer "overall" (e.g. ${missing[0].name}) — did scripts/add_overall.js run? See scripts/update_players.sh`);
    }
    const outOfRange = all.filter(p => Number.isInteger(p.overall) && (p.overall < 40 || p.overall > 99));
    for (const p of outOfRange.slice(0, 5)) {
      errors.push(`${p.name}: "overall" = ${p.overall} is outside [40, 99]`);
    }
    const withBoth = all.filter(p => Number.isInteger(p.overall) && Number.isInteger(p.rating));
    if (withBoth.length) {
      const same = withBoth.filter(p => p.overall === p.rating).length;
      if (same / withBoth.length > 0.9) {
        errors.push(
          `"overall" equals "rating" for ${same}/${withBoth.length} entries — the Phase B ` +
          `composite has been bypassed and the game is back on stat-only ratings. ` +
          `Check that scripts/add_overall.js runs after add_rating.js.`);
      }
    }
    // Each decade's best player is anchored to 99 by the era normalisation.
    // If a decade tops out below that, the normalisation didn't run over it.
    const byDecade = new Map();
    for (const [bucketKey, players] of Object.entries(db)) {
      if (!Array.isArray(players)) continue;
      const decade = bucketKey.split('_')[1];
      for (const p of players) {
        if (!Number.isInteger(p.overall)) continue;
        byDecade.set(decade, Math.max(byDecade.get(decade) ?? 0, p.overall));
      }
    }
    for (const [decade, peak] of [...byDecade].sort()) {
      if (peak !== 99) {
        errors.push(`Decade ${decade} peaks at overall ${peak}, expected 99 — per-era normalisation did not anchor it (scripts/add_overall.js B.3)`);
      }
    }
  }

  // A name is the engine's cross-era clone key (draftedPlayerNames), so two
  // DIFFERENT players sharing a name would wrongly block each other in the
  // draft. Distinct birth-era players must be disambiguated upstream
  // (NAME_BY_KEY in scripts/afl_positions.mjs).
  const nameToIdRoots = new Map();
  for (const [bucketKey, players] of Object.entries(db)) {
    if (!Array.isArray(players)) continue;
    for (const p of players) {
      if (!p.name || !p.id) continue;
      const root = String(p.id).replace(/_\d{2}(_[a-z]{3}\d+)?$/, '');
      if (!nameToIdRoots.has(p.name)) nameToIdRoots.set(p.name, new Set());
      nameToIdRoots.get(p.name).add(root);
    }
  }

  if (errors.length) fail(errors, warnings);

  const totalPlayers = Object.values(db).reduce((n, arr) => n + arr.length, 0);
  const imputedCount = Object.values(db).flat().filter(p => p.imputed).length;
  if (warnings.length) {
    console.warn(`${warnings.length} warning(s):`);
    for (const w of warnings) console.warn(`  ! ${w}`);
    console.warn('');
  }
  console.log(`OK — ${Object.keys(db).length} buckets, ${totalPlayers} players, ${imputedCount} with imputed stats, no structural issues found.`);
}

function fail(errors, warnings = []) {
  if (warnings.length) {
    console.warn(`${warnings.length} warning(s):`);
    for (const w of warnings) console.warn(`  ! ${w}`);
    console.warn("");
  }
  console.error(`FAILED — ${errors.length} issue(s):\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

main();
