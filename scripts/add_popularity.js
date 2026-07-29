'use strict';
/**
 * scripts/add_popularity.js
 * Adds a `popularity` integer (1-100) to every player in players.json.
 * Run:  node scripts/add_popularity.js
 *
 * Logic:
 *  1. Named overrides for every well-known player (curated by hand).
 *  2. For everyone else: stat-based formula using goals as the main driver
 *     (most recognisable stat in the public eye, same role ppg played in
 *     the NBA original), with a small deterministic jitter so role-players
 *     aren't all identical.
 *
 * NAMED currently only covers the ~40 players in the hand-written stub
 * roster (docs/afl-port-plan.md's "3 clubs x 2 decades" starter DB). Once
 * the real ~800-1000 player dataset lands (Phase 3 of the port plan), this
 * needs the same scale of curated list the NBA original had (~700 names) —
 * built from Brownlow/Norm Smith/Coleman winners, Hall of Fame and Legend
 * status, premierships, and a subjective recognisability pass, per
 * docs/afl-port-plan.md §4.5.
 */
const fs   = require('fs');
const path = require('path');

const SRC  = path.join(__dirname, '..', 'players.json');
const db   = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// ─── Curated overrides (name → popularity) ───────────────────────────────────
const NAMED = {
  // Carlton
  'Stephen Kernahan':        90,
  'Greg Williams':           85,
  'Stephen Silvagni':        82,
  'Craig Bradley':           78,
  'Justin Madden':           55,
  'Ang Christou':            45,
  'Anthony Koutoufides':     80,
  'Charlie Curnow':          82,
  'Patrick Cripps':          90,
  'Jacob Weitering':         68,
  'Kade Simpson':            65,
  'Matthew Kreuzer':         55,
  'Eddie Betts':             92,
  'Marc Murphy':             60,
  // Essendon
  'James Hird':              95,
  'Dustin Fletcher':         80,
  "Gary O'Donnell":          55,
  'Simon Madden':            70,
  'Michael Long':            88,
  'Joe Misiti':              45,
  'Joe Daniher':             65,
  'Zach Merrett':            72,
  'Michael Hurley':          58,
  'Adam Saad':               55,
  'Tom Bellchambers':        50,
  'Orazio Fantasia':         52,
  'Dyson Heppell':           65,
  // North Melbourne
  'Wayne Carey':             97,
  'Anthony Stevens':         65,
  'Glenn Archer':            78,
  'David King':              68,
  'Corey McKernan':          60,
  'Wayne Schwass':           62,
  'Ben Brown':               60,
  'Ben Cunnington':          62,
  'Scott Thompson':          55,
  'Shaun Higgins':           60,
  'Todd Goldstein':          72,
  'Lindsay Thomas':          55,
  'Jack Ziebell':            58,
};

// ─── Stat-based fallback ──────────────────────────────────────────────────────
function formulaPopularity(player) {
  // Base from goals — most recognisable stat in the public eye
  const goalsBase = Math.min(player.goals / 4, 1) * 55; // 4 goals/game → 55 pts

  // Supporting stats add a little
  const supportBase =
    (player.disposals  / 30) * 8 +
    (player.marks      / 8)  * 7 +
    (player.tackles     / 6)  * 5 +
    (player.clearances / 8)  * 5;

  const base = Math.round(goalsBase + supportBase);

  // Deterministic jitter from the player id so the same player always
  // gets the same score (no randomness).
  let hash = 0;
  for (let i = 0; i < (player.id || player.name).length; i++) {
    hash = ((hash << 5) - hash) + (player.id || player.name).charCodeAt(i);
    hash |= 0;
  }
  const jitter = Math.abs(hash % 11) - 5; // -5 … +5

  return Math.min(100, Math.max(0, base + jitter));
}

// ─── Apply ────────────────────────────────────────────────────────────────────
let total = 0, named = 0, formula = 0;

for (const key of Object.keys(db)) {
  for (const player of db[key]) {
    if (NAMED[player.name] !== undefined) {
      player.popularity = NAMED[player.name];
      named++;
    } else {
      player.popularity = formulaPopularity(player);
      formula++;
    }
    total++;
  }
}

fs.writeFileSync(SRC, JSON.stringify(db, null, 2), 'utf8');

console.log(`Done.`);
console.log(`  Total players     : ${total}`);
console.log(`  Named overrides   : ${named}`);
console.log(`  Formula-derived   : ${formula}`);
console.log(`Wrote ${SRC}`);
