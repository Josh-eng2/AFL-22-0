/**
 * js/logic/positions.js — Dynamic Secondary Position Scanner
 *
 * Runs once after loadDatabase() populates DB.
 * Mutates player objects in-memory only — players.js is never touched.
 *
 * Each rule collects into a Set (multiple secondaries per player are valid).
 * Output is sorted by positional distance so the closest slot appears first.
 *
 * Rule Categories (defence -> forward axis: KD, HB, MID, RUC, KF, SF)
 * ─────────────────────────────────────────────────────────────────
 * KD  Ball-Carrying Back  : high disposals, low scoring          → HB
 * KD  Swingman            : non-trivial scoring                  → KF
 * HB  Intercept Type      : high marks                           → KD
 * HB  Wingman-Mid         : high disposals                       → MID
 * MID Outside Runner      : high marks / low clearances          → HB
 * MID Forward-Half Mid    : non-trivial scoring                  → SF
 * MID Tall Pinch-Hitter   : non-trivial hitouts                  → RUC
 * RUC Ruck-Forward        : high marks or scoring                → KF
 * RUC Ruck-Rover          : high disposals + clearances          → MID
 * KF  Pinch-Hitting Ruck  : non-trivial hitouts                  → RUC
 * KF  Intercept Swingman  : elite marks, low scoring              → KD
 * SF  Rotating Mid        : high disposals                        → MID
 * SF  Power Small Forward : high scoring                          → KF
 */

import { DB } from '../data/players.js';

// Positional rank used for distance-sorting secondary positions
const POS_RANK = { KD: 0, HB: 1, MID: 2, RUC: 3, KF: 4, SF: 5 };

/**
 * Appends a `secondaryPos` array to every player object in DB.
 * Safe to call multiple times — always overwrites.
 */
export function applySecondaryPositions() {
  if (!DB) return;
  for (const players of Object.values(DB)) {
    for (const p of players) {
      p.secondaryPos = deriveSecondary(p);
    }
  }
}

/**
 * Returns a sorted secondary-position array for a single player.
 * Positions closest to the player's natural slot appear first.
 *
 * @param {object} p  Player object from DB
 * @returns {string[]}
 */
function deriveSecondary(p) {
  const arch = p.archetype || '';
  const sec  = new Set();

  switch (p.pos) {

    // ── Key Defender ──────────────────────────────────────────────────────
    case 'KD':
      // Ball-Carrying Back: intercepts and drives it out himself → HB
      if (p.disposals > 18 && p.goals < 0.3) sec.add('HB');
      // Swingman: enough scoring touch to play up the other end → KF
      if (p.goals > 0.3) sec.add('KF');
      break;

    // ── Half-Back ─────────────────────────────────────────────────────────
    case 'HB':
      // Intercept Type: wins it in the air more than most half-backs → KD
      if (p.marks > 5.5 || arch === 'Intercept Marker') sec.add('KD');
      // Wingman-Mid: racks up enough of the ball to roll into the middle → MID
      if (p.disposals > 23) sec.add('MID');
      break;

    // ── Midfielder ────────────────────────────────────────────────────────
    case 'MID':
      // Outside Runner: more mark-and-run than clearance work → HB
      if (p.marks > 4.0 && p.clearances < 2.0) sec.add('HB');
      // Forward-Half Mid: enough scoring touch to push forward → SF
      if (p.goals > 1.0) sec.add('SF');
      // Tall Pinch-Hitter: can share ruck duties → RUC
      if ((p.hitouts || 0) > 5) sec.add('RUC');
      break;

    // ── Ruck ──────────────────────────────────────────────────────────────
    case 'RUC':
      // Ruck-Forward: mobile enough to play as a marking target → KF
      if (p.marks > 4.0 || p.goals > 1.0 || arch === 'Power Forward') sec.add('KF');
      // Ruck-Rover: wins his own hitout and follows it up → MID
      if (p.disposals > 16 && p.clearances > 2.0) sec.add('MID');
      break;

    // ── Key Forward ───────────────────────────────────────────────────────
    case 'KF':
      // Pinch-Hitting Ruck: can follow a teammate into the ruck → RUC
      if ((p.hitouts || 0) > 5) sec.add('RUC');
      // Intercept Swingman: elite overhead marking, low scoring load → KD
      if (p.marks > 6.0 && p.goals < 0.5) sec.add('KD');
      break;

    // ── Small Forward ─────────────────────────────────────────────────────
    case 'SF':
      // Rotating Mid: enough of the ball to spend time on-ball → MID
      if (p.disposals > 16) sec.add('MID');
      // Power Small Forward: heavy enough scorer to play up as a KF → KF
      if (p.goals > 2.5 || arch === 'Power Forward') sec.add('KF');
      break;
  }

  // Sort secondaries by proximity to natural position (ascending distance)
  const myRank = POS_RANK[p.pos] ?? 2;
  return [...sec].sort(
    (a, b) => Math.abs(POS_RANK[a] - myRank) - Math.abs(POS_RANK[b] - myRank)
  );
}
