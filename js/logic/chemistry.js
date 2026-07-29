/**
 * js/logic/chemistry.js — Advanced Team Chemistry Engine
 *
 * calculateChemistry(starters, coachId?, opts?)
 *
 * opts.asPlacedSlots — when set (live draft UI), score positional fit against
 * the player's placed roster slots instead of optimizeLineup.
 *   Uses coachId when provided; otherwise falls back to S.coach.
 *   Returns { chemBonus, chemScore, chemReport, chemEntries, lineupAssignment }.
 *
 *   chemBonus   — raw float added to adjustedStrength in simulation
 *   chemScore   — 0–100 display value (50 baseline; see chemScoreFromBonus)
 *   chemReport  — array of human-readable strings (🟢 synergies / 🔴 penalties)
 *   chemEntries — structured source of truth the strings are derived from:
 *                 { id, kind: 'synergy'|'penalty'|'info', family, bonus, label }
 *
 * The structured entries exist so downstream systems (defense-mode profile
 * boosts, autopsy, future coach systems) can key off `kind`/`family` instead
 * of regex-matching English prose — the report strings are presentation only.
 *
 * ── Synergy families & caps ──────────────────────────────────────────────────
 * Positive synergies belong to one of four families, each with a hard cap.
 * Stacking within one identity plateaus instead of compounding linearly.
 * Penalties are never capped. When a family overflows, the overflow is
 * trimmed from chemBonus and an 🟢 info line explains the cap so the player
 * learns to diversify rather than wonder where the % went.
 *
 * ── AFL port note ────────────────────────────────────────────────────────────
 * Ported from the NBA original's chemistry engine — same family-cap
 * structure, same synergy/penalty shape, same numeric bonus values.
 * Archetypes/traits/positions/stat fields are renamed to the AFL taxonomy
 * (see docs/afl-port-plan.md §3.3/§3.4/§3.6) and numeric stat thresholds are
 * rescaled to AFL stat ranges. Rescaled thresholds are first-pass estimates,
 * not swept against a real dataset yet (the live DB is a 41-player stub) —
 * revisit once the real player dataset lands (docs/afl-port-plan.md §9).
 */

import { S } from '../logic/state.js';

// ── Family caps ──────────────────────────────────────────────────────────────
export const FAMILY_CAPS = {
  position:    0.22,
  offense:     0.38,
  defense:     0.36,
  intangibles: 0.20,
};

// Global tuning knob — every positive synergy bonus is multiplied by this
// before being added to chemBonus. Penalties are unaffected.
const SYNERGY_SCALE = 0.8;

const FAMILY_LABEL = {
  position:    'Positional fit',
  offense:     'Offensive',
  defense:     'Defensive',
  intangibles: 'Intangible',
};

// Display scale: chemScore starts at 50 (empty roster / no synergies).
// Positive bonuses climb toward 100; penalties drop toward 0.
export const CHEM_SCORE_SCALE = 0.95;
export const CHEM_SCORE_BASE  = 50;

/** 0–100 display score for a raw chemistry bonus. Shared with simulation.js. */
export function chemScoreFromBonus(bonus) {
  const delta = (bonus / CHEM_SCORE_SCALE) * CHEM_SCORE_BASE;
  return Math.round(Math.max(0, Math.min(100, CHEM_SCORE_BASE + delta)));
}

/**
 * Player-facing chemistry tier. Empty roster (score 50) lands on Neutral.
 * Thresholds intentionally hide the raw 0–100 number from the UI.
 *
 * @returns {{ id: string, label: string, score: number }}
 */
export function chemTier(score) {
  const sc = Math.round(Math.max(0, Math.min(100, Number(score) || 0)));
  if (sc >= 95) return { id: 'perfect',     label: 'Perfect',     score: sc };
  if (sc >= 80) return { id: 'veryStrong',  label: 'Very Strong', score: sc };
  if (sc >= 65) return { id: 'strong',      label: 'Strong',      score: sc };
  if (sc >= 45) return { id: 'neutral',     label: 'Neutral',     score: sc };
  if (sc >= 25) return { id: 'weak',        label: 'Weak',        score: sc };
  return { id: 'veryWeak', label: 'Very Weak', score: sc };
}

/** Colors for chemTier badges. Pass dark=true for dark-mode hexes. */
export function chemTierColors(tierId, dark = false) {
  const map = {
    perfect: {
      color: dark ? '#fbbf24' : '#b45309',
      bg:    dark ? 'rgba(251,191,36,0.12)' : '#fffbeb',
    },
    veryStrong: {
      color: dark ? '#4ade80' : '#15803d',
      bg:    dark ? 'rgba(34,197,94,0.12)' : '#ecfdf5',
    },
    strong: {
      color: dark ? '#4ade80' : '#16a34a',
      bg:    dark ? 'rgba(34,197,94,0.12)' : '#f0fdf4',
    },
    neutral: {
      color: dark ? '#fbbf24' : '#d97706',
      bg:    dark ? 'rgba(251,191,36,0.12)' : '#fffbeb',
    },
    weak: {
      color: dark ? '#fb923c' : '#ea580c',
      bg:    dark ? 'rgba(251,146,60,0.12)' : '#fff7ed',
    },
    veryWeak: {
      color: dark ? '#f87171' : '#dc2626',
      bg:    dark ? 'rgba(239,68,68,0.12)' : '#fef2f2',
    },
  };
  return map[tierId] || map.neutral;
}

// ── Lineup Optimizer ──────────────────────────────────────────────────────────

// Six AFL slots, defence -> forward axis (matches positions.js POS_RANK).
const FLOOR_SLOTS = ['KD', 'HB', 'MID', 'RUC', 'KF', 'SF'];

// Ordered slot selections P(6, n), memoized by n. The pool is always
// FLOOR_SLOTS, so the permutation set never changes — but optimizeLineup runs
// inside hot paths (AI-draft candidate scoring calls calculateChemistry twice
// per board player), and rebuilding up to 720 arrays each call was pure waste.
const _slotOrderCache = new Map();

function slotOrders(pool, r) {
  if (r === 0) return [[]];
  const out = [];
  for (let i = 0; i < pool.length; i++) {
    const rest = [...pool.slice(0, i), ...pool.slice(i + 1)];
    for (const sub of slotOrders(rest, r - 1)) out.push([pool[i], ...sub]);
  }
  return out;
}

function slotOrdersForCount(n) {
  if (!_slotOrderCache.has(n)) _slotOrderCache.set(n, slotOrders(FLOOR_SLOTS, n));
  return _slotOrderCache.get(n);
}

// Returns the raw chemBonus contribution for one player-slot pair.
// Primary match = +3%, secondary/flex = +2%, out-of-position = +1%.
// OOP is intentionally lower than secondary — it fills a role but doesn't fit it.
function slotFitScore(player, slot) {
  if (player.pos === slot) return 0.03;
  if ((player.secondaryPos || []).includes(slot)) return 0.02;
  return 0.01;
}

/**
 * Brute-force optimal assignment of up to 6 starters into floor slots.
 * Tries all P(6, n) ordered slot selections — at most 720 iterations for n=6.
 *
 * @param {object[]} starters
 * @returns {{ assignment: object[], posBonus: number, flawless: boolean }}
 */
function optimizeLineup(starters) {
  const n = Math.min(starters.length, 6);
  if (n === 0) return { assignment: [], posBonus: 0, flawless: false };

  const players = starters.slice(0, n);

  let bestSlots = null;
  let bestScore = -Infinity;
  for (const perm of slotOrdersForCount(n)) {
    const score = players.reduce((s, p, i) => s + slotFitScore(p, perm[i]), 0);
    if (score > bestScore) { bestScore = score; bestSlots = perm; }
  }

  // Build assignment
  const assignment = [];
  let posBonus = 0;
  for (let i = 0; i < n; i++) {
    const p     = players[i];
    const slot  = bestSlots[i];
    const score = slotFitScore(p, slot);
    let fit;
    if (p.pos === slot)                              fit = 'primary';
    else if ((p.secondaryPos || []).includes(slot)) fit = 'flex';
    else                                              fit = 'oop';
    assignment.push({ slot, player: p, fit, bonus: score });
    posBonus += score;
  }

  const allPrimary = n === 6 && assignment.every(a => a.fit === 'primary');
  if (allPrimary) posBonus += 0.07;

  return { assignment, posBonus, flawless: allPrimary };
}

/**
 * Score positional fit against the player's *placed* roster slots
 * (KD→SF order), not the engine's optimized floor. Used by the live draft
 * chemistry panel so "Perfect Fit … natural HB" matches the HB chip the
 * player actually sees.
 *
 * @param {object[]} starters  players in POSITIONS order (empties already filtered)
 * @param {string[]} slots     matching slot labels for each starter
 */
function placementLineup(starters, slots) {
  const n = Math.min(starters.length, slots.length, 6);
  if (n === 0) return { assignment: [], posBonus: 0, flawless: false };

  const assignment = [];
  let posBonus = 0;
  for (let i = 0; i < n; i++) {
    const p     = starters[i];
    const slot  = slots[i];
    const score = slotFitScore(p, slot);
    let fit;
    if (p.pos === slot)                              fit = 'primary';
    else if ((p.secondaryPos || []).includes(slot)) fit = 'flex';
    else                                              fit = 'oop';
    assignment.push({ slot, player: p, fit, bonus: score });
    posBonus += score;
  }

  const allPrimary = n === 6 && assignment.every(a => a.fit === 'primary');
  if (allPrimary) posBonus += 0.07;

  return { assignment, posBonus, flawless: allPrimary };
}

/**
 * @param {object[]} starters  6 starter player objects (starters-only format)
 * @param {string|null} coachId
 * @param {{ asPlacedSlots?: string[] }} [opts]  when set, score fit against these
 *   placed slots (same order as starters) instead of optimizeLineup — for live UI
 * @returns {{ chemBonus: number, chemScore: number, chemReport: string[], chemEntries: object[], lineupAssignment: object[] }}
 */
export function calculateChemistry(starters, coachId = null, opts = {}) {
  const coach = coachId ?? ((typeof S !== 'undefined' && S.coach) ? S.coach : null);

  // Archetype shorthand
  const sA = starters.map(p => p.archetype || '');

  // Trait shorthand — safe even if a player has no traits array
  const sT = starters.flatMap(p => p.traits || []);

  // Pre-computed archetype flags
  const sHasBallMagnet   = sA.includes('Ball Magnet');
  const sHasGoalSneak    = sA.includes('Goal Sneak');
  const sHasInterceptMkr = sA.includes('Intercept Marker');
  const sHasLockdown     = sA.includes('Lockdown Defender');
  const sGoalSneakCount  = sA.filter(a => a === 'Goal Sneak').length;
  const sPowerIMCount    = sA.filter(a => a === 'Power Forward' || a === 'Intercept Marker').length;
  const sBallMagnetCount = sA.filter(a => a === 'Ball Magnet').length;

  // Structured entries — the single source of truth. chemBonus, chemReport,
  // and the family-cap math are all derived from this list at the end.
  const entries = [];
  const add = (id, kind, family, bonus, label) => entries.push({ id, kind, family, bonus, label });
  // All positive synergy bonuses are scaled down 20% here — single point of
  // control so every call site (base and coach-boosted alike) stays in sync,
  // and the label's "(+N%)" is rewritten to match the post-scale value.
  const synergy = (id, family, bonus, label) => {
    const scaledBonus = bonus * SYNERGY_SCALE;
    const scaledLabel = label.replace(/\+\d+(?:\.\d+)?%/, `+${Math.round(scaledBonus * 100)}%`);
    add(id, 'synergy', family, scaledBonus, scaledLabel);
  };
  const penalty = (id, bonus, label) => add(id, 'penalty', null, -Math.abs(bonus), label);

  // ── PHASE 0: LINEUP OPTIMIZER (POSITIONAL FIT) ───────────────────────────────
  // Sim uses optimizeLineup (engine may rematch slots). Live draft UI passes
  // asPlacedSlots so Perfect Fit / Versatile lines match the visible roster.
  const { assignment, posBonus, flawless } = opts.asPlacedSlots
    ? placementLineup(starters, opts.asPlacedSlots)
    : optimizeLineup(starters);
  if (flawless) {
    synergy('flawless-construction', 'position', 0.07,
      'Flawless Construction: All six starters playing natural positions (+7%)');
    for (const { slot, player, bonus } of assignment) {
      synergy(`fit-${slot}`, 'position', bonus,
        `Perfect Fit: ${player.name} plays natural ${slot} (+3%)`);
    }
  } else {
    for (const { slot, player, fit, bonus } of assignment) {
      if (fit === 'primary') {
        synergy(`fit-${slot}`, 'position', bonus,
          `Perfect Fit: ${player.name} plays natural ${slot} (+3%)`);
      } else if (fit === 'flex') {
        add(`fit-${slot}`, 'synergy', 'position', 0,
          `Flex Fit: ${player.name} (${player.pos}) covers ${slot} via secondary position (0%)`);
      } else {
        penalty(`fit-${slot}`, 0.03,
          `Versatile: ${player.name} fills the ${slot} role (-3%)`);
      }
    }
  }

  // ── PHASE 2: ARCHETYPE SYNERGIES ────────────────────────────────────────────

  if (sHasBallMagnet && sHasGoalSneak) {
    synergy('drive-and-kick', 'offense', 0.08,
      'Drive & Kick: Ball Magnet finds the Goal Sneak in space (+8%)');
  }

  if (sHasInterceptMkr && sHasLockdown) {
    const bonus = coach === 'auerbach' ? 0.10 : 0.08;
    synergy('tall-timber', 'defense', bonus,
      `Tall Timber${coach === 'auerbach' ? ' ⭐ Barassi' : ''}: Interior dominance across the six (+${Math.round(bonus * 100)}%)`);
  }

  if (sHasBallMagnet && sHasInterceptMkr) {
    synergy('trusted-target', 'offense', 0.08,
      'Trusted Target: Ball Magnet always has an Intercept Marker to hit (+8%)');
  }

  if (sHasBallMagnet && sGoalSneakCount >= 2) {
    const bonus = coach === 'popovich' ? 0.09 : coach === 'kerr' ? 0.09 : coach === 'holzman' ? 0.09 : 0.07;
    synergy('inside-50-delivery', 'offense', bonus,
      `Inside 50 Delivery${coach === 'popovich' ? ' ⭐ Matthews' : coach === 'kerr' ? ' ⭐ Clarkson' : coach === 'holzman' ? ' ⭐ Hafey' : ''}: Ball Magnet unlocks multiple sharpshooters (+${Math.round(bonus * 100)}%)`);
  }

  const defAnchor = starters.find(
    p => (p.archetype === 'Lockdown Defender' || p.archetype === 'Intercept Marker') &&
         (p.tackles + p.clearances) >= 5.0
  );
  if (defAnchor) {
    const bonus = coach === 'auerbach' ? 0.09 : 0.07;
    synergy('defensive-anchor', 'defense', bonus,
      `Defensive Anchor${coach === 'auerbach' ? ' ⭐ Barassi' : ''}: ${defAnchor.name.split(' ').pop()} anchors the defensive 50 (+${Math.round(bonus * 100)}%)`);
  }

  const sLockdownCount = sA.filter(a => a === 'Lockdown Defender').length;
  if (sLockdownCount >= 2) {
    const bonus = coach === 'auerbach' ? 0.09 : coach === 'holzman' ? 0.09 : 0.07;
    synergy('perimeter-lockdown', 'defense', bonus,
      `Perimeter Lockdown${coach === 'auerbach' ? ' ⭐ Barassi' : coach === 'holzman' ? ' ⭐ Hafey' : ''}: Multiple shutdown defenders across the ground (+${Math.round(bonus * 100)}%)`);
  }

  const sPowerFwdCount = sA.filter(a => a === 'Power Forward').length;
  if (sHasBallMagnet && sPowerFwdCount >= 2) {
    const bonus = coach === 'kerr' ? 0.09 : 0.07;
    synergy('corridor-blitz', 'offense', bonus,
      `Corridor Blitz${coach === 'kerr' ? ' ⭐ Clarkson' : ''}: Rapid end-to-end footy engine ready (+${Math.round(bonus * 100)}%)`);
  }

  if (sGoalSneakCount >= 3) {
    const bonus = coach === 'kerr' ? 0.08 : 0.05;
    synergy('sharpshooting-swarm', 'offense', bonus,
      `Sharpshooting Swarm${coach === 'kerr' ? ' ⭐ Clarkson' : ''}: Accuracy overload with 3+ Goal Sneaks in the six (+${Math.round(bonus * 100)}%)`);
  }

  const tallSharp = starters.find(
    p => (p.pos === 'RUC' || p.pos === 'KF') && p.archetype === 'Goal Sneak'
  );
  if (tallSharp) {
    const bonus = coach === 'kerr' ? 0.08 : 0.05;
    synergy('loose-in-the-square', 'offense', bonus,
      `Loose in the Goalsquare${coach === 'kerr' ? ' ⭐ Clarkson' : ''}: ${tallSharp.name.split(' ').pop()}'s accuracy drags a defender out of position (+${Math.round(bonus * 100)}%)`);
  }

  const endToEndBallMagnet = starters.find(p => p.archetype === 'Ball Magnet' && p.disposals > 26.0);
  const endToEndForward    = starters.find(p => p.archetype === 'Power Forward' && p.goals > 2.5);
  if (endToEndBallMagnet && endToEndForward) {
    const bonus = coach === 'riley' ? 0.09 : 0.07;
    synergy('end-to-end-rush', 'offense', bonus,
      `End-to-End Rush${coach === 'riley' ? ' ⭐ Jeans' : ''}: Coast-to-coast footy fully synchronized (+${Math.round(bonus * 100)}%)`);
  }

  const clubCounts = {};
  for (const p of starters) {
    if (p.team) clubCounts[p.team] = (clubCounts[p.team] || 0) + 1;
  }
  if (Object.values(clubCounts).some(count => count >= 3)) {
    synergy('one-club-spine', 'intangibles', 0.05,
      'One-Club Spine: Shared club history yields a chemistry boost (+5%)');
  }

  if (sLockdownCount >= 3) {
    const bonus = (coach === 'riley' || coach === 'auerbach' || coach === 'rivers') ? 0.10 : 0.07;
    synergy('all-australian-defence', 'defense', bonus,
      `All-Australian Defence${coach === 'riley' ? ' ⭐ Jeans' : coach === 'auerbach' ? ' ⭐ Barassi' : coach === 'rivers' ? ' ⭐ Fagan' : ''}: High baseline pressure across the six (+${Math.round(bonus * 100)}%)`);
  }

  const goToGun = starters.find(p => p.archetype === 'Ball Magnet' && p.disposals > 28.0);
  const otherStartersScoring = starters.filter(
    p => p.archetype !== 'Ball Magnet' && p.goals > 0.8
  );
  if (
    goToGun &&
    starters.filter(p => p.archetype === 'Ball Magnet').length === 1 &&
    otherStartersScoring.length === 5
  ) {
    const bonus = coach === 'jackson' ? 0.09 : 0.07;
    synergy('go-to-gun', 'offense', bonus,
      `Go-To Gun${coach === 'jackson' ? ' ⭐ Sheedy' : ''}: System built cleanly around ${goToGun.name.split(' ').pop()} (+${Math.round(bonus * 100)}%)`);
  }

  const startingRuc = starters.find(p => p.pos === 'RUC');
  const startingKf  = starters.find(p => p.pos === 'KF');
  if (startingRuc?.archetype === 'Intercept Marker' && startingKf?.archetype === 'Intercept Marker') {
    const bonus = coach === 'auerbach' ? 0.08 : 0.05;
    synergy('bully-ball', 'defense', bonus,
      `Bully Ball Forward Line${coach === 'auerbach' ? ' ⭐ Barassi' : ''}: Combined intercept markers completely overwhelm every contest (+${Math.round(bonus * 100)}%)`);
  }

  const eliteScorers = starters.filter(p => p.goals > 2.5);
  if (eliteScorers.length >= 2) {
    const bonus = coach === 'jackson' ? 0.09 : coach === 'rivers' ? 0.09 : 0.07;
    synergy('dynamic-duo', 'offense', bonus,
      `Dynamic Duo${coach === 'jackson' ? ' ⭐ Sheedy' : coach === 'rivers' ? ' ⭐ Fagan' : ''}: Explosive scoreboard-impact tandem active (+${Math.round(bonus * 100)}%)`);
  }

  const rucKfClearances = starters
    .filter(p => p.pos === 'RUC' || p.pos === 'KF')
    .reduce((sum, p) => sum + p.clearances, 0);
  if (starters.filter(p => p.pos === 'RUC' || p.pos === 'KF').length === 2 && rucKfClearances >= 3.0) {
    synergy('contest-patrol', 'defense', 0.05,
      'Contest Patrol: Tall-line clearance pressure active (+5%)');
  }

  if (sGoalSneakCount >= 2 && sLockdownCount >= 2) {
    const bonus = coach === 'kerr' ? 0.09 : 0.07;
    synergy('two-way-precision', 'defense', bonus,
      `Two-Way Precision${coach === 'kerr' ? ' ⭐ Clarkson' : ''}: Flawless accuracy-and-defence symmetry (+${Math.round(bonus * 100)}%)`);
  }

  const hbMidTackles = starters
    .filter(p => p.pos === 'HB' || p.pos === 'MID')
    .reduce((sum, p) => sum + p.tackles, 0);
  if (starters.filter(p => p.pos === 'HB' || p.pos === 'MID').length === 2 && hbMidTackles >= 7.0) {
    synergy('perimeter-clamps', 'defense', 0.05,
      'Perimeter Clamps: Stifling on-ball tackling pressure (+5%)');
  }

  // Tall line: KD + RUC + KF — the three positions that regularly contest marks.
  const tallLine = starters.filter(p => p.pos === 'KD' || p.pos === 'RUC' || p.pos === 'KF');
  const tallLineMarks = tallLine.reduce((sum, p) => sum + p.marks, 0);
  if (tallLine.length >= 2 && tallLineMarks > 16.0) {
    const bonus = coach === 'auerbach' ? 0.09 : 0.07;
    synergy('pack-crashers', 'defense', bonus,
      `Pack Crashers${coach === 'auerbach' ? ' ⭐ Barassi' : ''}: Tall line dominates every marking contest (${tallLineMarks.toFixed(1)} combined marks) (+${Math.round(bonus * 100)}%)`);
  }

  // Two-Way Pillars: Ruck Bull finally gets a positive synergy identity
  const sRuckBullCount = sA.filter(a => a === 'Ruck Bull').length;
  if (sRuckBullCount >= 2) {
    const bonus = (coach === 'kerr' || coach === 'auerbach') ? 0.09 : 0.08;
    synergy('two-way-pillars', 'defense', bonus,
      `Two-Way Pillars${coach === 'kerr' ? ' ⭐ Clarkson' : coach === 'auerbach' ? ' ⭐ Barassi' : ''}: 2+ Ruck Bulls in the six — competitive at every contest (+${Math.round(bonus * 100)}%)`);
  }

  // Width and Drive: Goal Sneak spaces the ground for the Power Forward to attack
  const sHasPowerForward = sA.includes('Power Forward');
  if (sHasGoalSneak && sHasPowerForward) {
    const bonus = coach === 'kerr' ? 0.08 : 0.06;
    synergy('width-and-drive', 'offense', bonus,
      `Width and Drive${coach === 'kerr' ? ' ⭐ Clarkson' : ''}: Goal Sneak's precision opens the corridor for the Power Forward to attack (+${Math.round(bonus * 100)}%)`);
  }

  // Lockdown Stars: Ruck Bull + Lockdown Defender eliminate any matchup
  const sHasRuckBull = sA.includes('Ruck Bull');
  if (sHasRuckBull && sHasLockdown) {
    const bonus = (coach === 'riley' || coach === 'auerbach') ? 0.08 : 0.06;
    synergy('lockdown-stars', 'defense', bonus,
      `Lockdown Stars${coach === 'riley' ? ' ⭐ Jeans' : coach === 'auerbach' ? ' ⭐ Barassi' : ''}: Ruck Bull and Lockdown Defender erase any matchup (+${Math.round(bonus * 100)}%)`);
  }

  // ── PHASE 3: TRAIT SYNERGIES ──────────────────────────────────────────────────

  // Pre-computed trait counts used across synergies and penalties.
  const sTBallWinner      = sT.filter(t => t === 'Ball Winner').length;
  const sTEliteDisposal   = sT.filter(t => t === 'Elite Disposal').length;
  const sTInterceptKing   = sT.filter(t => t === 'Intercept King').length;
  const sTEliteKick       = sT.filter(t => t === 'Elite Kick').length;
  const sTShutdownBack    = sT.filter(t => t === 'Shutdown Back').length;
  const sTVolumeGK        = sT.filter(t => t === 'Volume Goalkicker').length;
  const sTBigGamePlayer   = sT.filter(t => t === 'Big Game Player').length;
  const sTTeamMan         = sT.filter(t => t === 'Team Man').length;
  const sTHitoutMachine   = sT.filter(t => t === 'Hit-out Machine').length;
  const sTPressureMachine = sT.filter(t => t === 'Pressure Machine').length;
  const sTBigFinalsPerf   = sT.filter(t => t === 'Big Finals Performer').length;
  const sTTagger          = sT.filter(t => t === 'Tagger').length;
  const sTOnballGeneral   = sT.filter(t => t === 'Onball General').length;
  const sTContestedMarker = sT.filter(t => t === 'Contested Marker').length;
  const sTSetShotSpec     = sT.filter(t => t === 'Set Shot Specialist').length;
  const sTRunAndCarry     = sT.filter(t => t === 'Run and Carry').length;
  const sTAerialist       = sT.filter(t => t === 'Aerialist').length;
  const sTLineBreaker     = sT.filter(t => t === 'Line-Breaker').length;

  // ── Synergies ─────────────────────────────────────────────────────────────────

  // Twin Engines: Ball Winner + Elite Disposal on two DIFFERENT starters
  const bwStarters = starters.filter(p => (p.traits || []).includes('Ball Winner'));
  const edStarters = starters.filter(p => (p.traits || []).includes('Elite Disposal'));
  const bwEdUnion  = new Set([...bwStarters, ...edStarters].map(p => p.id));
  if (sTBallWinner >= 1 && sTEliteDisposal >= 1 && bwEdUnion.size >= 2) {
    synergy('twin-engines', 'offense', 0.08,
      'Twin Engines: A Ball Winner and an Elite Disposal user in the six — dual ball-winning overload (+8%)');
  }

  // Modern Trifecta: all three pillars of modern midfield play in the six
  if (sTEliteDisposal >= 1 && sTInterceptKing >= 1 && sTEliteKick >= 1) {
    synergy('modern-trifecta', 'offense', 0.08,
      'Modern Trifecta: Elite Disposal + Intercept King + Elite Kick in the six (+8%)');
  }

  // Turnover Factory: two intercepting threats
  if (sTInterceptKing >= 2) {
    synergy('turnover-factory', 'defense', 0.07,
      'Turnover Factory: 2+ Intercept Kings in the six — permanent pressure at every intercept (+7%)');
  }

  // Defensive Wall: intercepting and run-down defence both sealed
  if (sTInterceptKing >= 1 && sTShutdownBack >= 1) {
    synergy('defensive-wall', 'defense', 0.07,
      'Defensive Wall: Intercept King and Shutdown Back both in the six — every avenue sealed (+7%)');
  }

  // Marks and Movement: aerial control meets ball use
  if (sTHitoutMachine >= 1 && sTEliteKick >= 1) {
    synergy('marks-and-movement', 'offense', 0.06,
      'Marks and Movement: Hit-out Machine and Elite Kick in the six (+6%)');
  }

  // Clutch Culture: no chokers anywhere
  if (sTBigGamePlayer >= 4) {
    synergy('clutch-culture', 'intangibles', 0.06,
      `Clutch Culture: ${sTBigGamePlayer} Big Game Players in the six — built for close finals (+6%)`);
  }

  // Team First Culture: selfless starters free up the stars
  if (sTTeamMan >= 2) {
    synergy('team-first-culture', 'intangibles', 0.06,
      'Team First Culture: 2+ Team Men in the six — selfless core frees the stars (+6%)');
  }

  // Two-Way Foundation: modern shutdown-and-kick backbone
  if (sTShutdownBack >= 1 && sTEliteKick >= 1) {
    synergy('two-way-foundation', 'defense', 0.05,
      'Two-Way Foundation: Shutdown Back and Elite Kick in the six (+5%)');
  }

  // Precision Kicking: maximum ball-use gravity
  if (sTEliteKick >= 3) {
    synergy('precision-kicking', 'offense', 0.05,
      `Precision Kicking: ${sTEliteKick} Elite Kicks in the six — every entry finds a target (+5%)`);
  }

  // Ice In Their Veins: multiple closers dominate finals footy
  if (sTBigFinalsPerf >= 2) {
    synergy('ice-veins', 'intangibles', 0.05,
      `Ice In Their Veins: ${sTBigFinalsPerf} Big Finals Performers in the six thrive under pressure (+5%)`);
  }

  // Extra Effort: relentless pressure generates extra ball
  if (sTPressureMachine >= 1) {
    synergy('extra-effort', 'intangibles', 0.05,
      'Extra Effort: A Pressure Machine on the roster — relentless effort generates extra ball (+5%)');
  }

  // Pinpoint Kicking: a Ball Winner dissects a spread ground
  if (sTBallWinner >= 1 && sTEliteKick >= 2) {
    const bonus = coach === 'holzman' ? 0.09 : 0.07;
    synergy('pinpoint-kicking', 'offense', bonus,
      `Pinpoint Kicking${coach === 'holzman' ? ' ⭐ Hafey' : ''}: A Ball Winner finds ${sTEliteKick} accurate targets spread wide (+${Math.round(bonus * 100)}%)`);
  }

  // Hands in the Contest: contested marking creates for accurate kicks around him
  if (sTContestedMarker >= 1 && sTEliteKick >= 2) {
    synergy('hands-in-the-contest', 'offense', 0.07,
      `Hands in the Contest: A Contested Marker creates for ${sTEliteKick} accurate kicks around him (+7%)`);
  }

  // Ruck-Rover Combination: classic AFL guard-big orchestration on two starters
  const ogStarters = starters.filter(p => (p.traits || []).includes('Onball General'));
  const cmStarters = starters.filter(p => (p.traits || []).includes('Contested Marker'));
  const ogCmUnion  = new Set([...ogStarters, ...cmStarters].map(p => p.id));
  if (sTOnballGeneral >= 1 && sTContestedMarker >= 1 && ogCmUnion.size >= 2) {
    const bonus = coach === 'popovich' ? 0.09 : 0.07;
    synergy('ruck-rover-combination', 'offense', bonus,
      `Ruck-Rover Combination${coach === 'popovich' ? ' ⭐ Matthews' : ''}: Onball General and Contested Marker run endless clearance patterns (+${Math.round(bonus * 100)}%)`);
  }

  // Run With Anyone: multiple positionless taggers erase mismatches
  if (sTTagger >= 2) {
    const bonus = (coach === 'riley' || coach === 'rivers') ? 0.09 : 0.07;
    synergy('run-with-anyone', 'defense', bonus,
      `Run With Anyone${coach === 'riley' ? ' ⭐ Jeans' : coach === 'rivers' ? ' ⭐ Fagan' : ''}: ${sTTagger} Taggers switch onto any opponent without leaking a mismatch (+${Math.round(bonus * 100)}%)`);
  }

  // Two-Way Wing Corps: wings who carry it AND defend their opponent
  if (sTRunAndCarry >= 2) {
    const bonus = coach === 'kerr' ? 0.08 : 0.06;
    synergy('two-way-wing-corps', 'defense', bonus,
      `Two-Way Wing Corps${coach === 'kerr' ? ' ⭐ Clarkson' : ''}: ${sTRunAndCarry} true two-way wings — drive on offense, clamps on defense (+${Math.round(bonus * 100)}%)`);
  }

  // Set Shot Snipers: shot creation that needs no run-up
  if (sTSetShotSpec >= 2) {
    const bonus = coach === 'jackson' ? 0.08 : 0.06;
    synergy('set-shot-snipers', 'offense', bonus,
      `Set Shot Snipers${coach === 'jackson' ? ' ⭐ Sheedy' : ''}: ${sTSetShotSpec} Set Shot Specialists nail it from anywhere (+${Math.round(bonus * 100)}%)`);
  }

  // Hanger City: an elite user puts the Aerialist on a permanent speccy track
  if (sTAerialist >= 1 && (sTBallWinner >= 1 || sTEliteDisposal >= 1)) {
    synergy('hanger-city', 'offense', 0.04,
      'Hanger City: An elite ball-user puts the Aerialist on a permanent speccy track (+4%)');
  }

  // ── PHASE 3B: EXPANSION SYNERGIES ────────────────────────────────────────────
  // Balanced-coverage pass: gives every archetype and live trait at least one
  // positive identity, and thickens the intangibles family.

  // Downhill Attack: multiple line-breakers bend the defense every trip
  if (sTLineBreaker >= 2) {
    const bonus = coach === 'riley' ? 0.08 : 0.06;
    synergy('downhill-attack', 'offense', bonus,
      `Downhill Attack${coach === 'riley' ? ' ⭐ Jeans' : ''}: ${sTLineBreaker} Line-Breakers put relentless corridor pressure on every trip (+${Math.round(bonus * 100)}%)`);
  }

  // Green Light: a gun with a table-setter to feed him
  const vgkStarters = starters.filter(p => (p.traits || []).includes('Volume Goalkicker'));
  const vgkOgUnion   = new Set([...vgkStarters, ...ogStarters].map(p => p.id));
  if (sTVolumeGK >= 1 && sTOnballGeneral >= 1 && vgkOgUnion.size >= 2) {
    const bonus = coach === 'holzman' ? 0.08 : 0.06;
    synergy('green-light', 'offense', bonus,
      `Green Light${coach === 'holzman' ? ' ⭐ Hafey' : ''}: An Onball General keeps the Volume Goalkicker fed with clean looks (+${Math.round(bonus * 100)}%)`);
  }

  // Marking Contest Kings: twin contested-marking targets winning it over the top
  if (sTContestedMarker >= 2) {
    const bonus = coach === 'jackson' ? 0.08 : 0.06;
    synergy('marking-contest-kings', 'offense', bonus,
      `Marking Contest Kings${coach === 'jackson' ? ' ⭐ Sheedy' : ''}: ${sTContestedMarker} Contested Markers win the ball above their opponent all day (+${Math.round(bonus * 100)}%)`);
  }

  // Every Kind of Shot: set shots, general play, and crumbing snaps all covered
  if (sTEliteKick >= 1 && sTSetShotSpec >= 1 && (sTLineBreaker >= 1 || sTContestedMarker >= 1)) {
    synergy('every-kind-of-shot', 'offense', 0.07,
      'Every Kind of Shot: Set shots, general play, and crumbing snaps all covered — nothing to scheme away (+7%)');
  }

  // No-Fly Zone: intercepting eraser plus a positionless tagger
  if (sTInterceptKing >= 1 && sTTagger >= 1) {
    const bonus = coach === 'rivers' ? 0.08 : 0.06;
    synergy('no-fly-zone', 'defense', bonus,
      `No-Fly Zone${coach === 'rivers' ? ' ⭐ Fagan' : ''}: Intercept King and Tagger close every avenue (+${Math.round(bonus * 100)}%)`);
  }

  // Junkyard Crew: grit plus clamps — loose balls never reach the outlet
  if (sTPressureMachine >= 1 && sTShutdownBack >= 1) {
    const bonus = coach === 'auerbach' ? 0.07 : 0.05;
    synergy('junkyard-crew', 'defense', bonus,
      `Junkyard Crew${coach === 'auerbach' ? ' ⭐ Barassi' : ''}: Pressure Machine and Shutdown Back turn every loose ball into a stop (+${Math.round(bonus * 100)}%)`);
  }

  // Ruck Domination: two dedicated hitout winners control first use of the ball
  if (sTHitoutMachine >= 2) {
    const bonus = coach === 'auerbach' ? 0.08 : 0.06;
    synergy('ruck-domination', 'defense', bonus,
      `Ruck Domination${coach === 'auerbach' ? ' ⭐ Barassi' : ''}: ${sTHitoutMachine} Hit-out Machines win first use of the footy at every contest (+${Math.round(bonus * 100)}%)`);
  }

  // Two-Way Anchor: a do-everything Ruck Bull backstopped by an intercept king
  if (sHasRuckBull && sTInterceptKing >= 1) {
    const bonus = coach === 'kerr' ? 0.08 : 0.06;
    synergy('two-way-anchor', 'defense', bonus,
      `Two-Way Anchor${coach === 'kerr' ? ' ⭐ Clarkson' : ''}: Ruck Bull pressures the ball with an Intercept King backstopping (+${Math.round(bonus * 100)}%)`);
  }

  // Captains' Council: ladders above Team First Culture (2+ Team Men)
  if (sTTeamMan >= 3) {
    synergy('captains-council', 'intangibles', 0.06,
      `Captains' Council: ${sTTeamMan} Team Men set the locker-room tone — zero agendas, all wins (+6%)`);
  }

  // Clutch Set Shots: crunch-time set-shot shotmaking on two different starters
  const bfpStarters = starters.filter(p => (p.traits || []).includes('Big Finals Performer'));
  const ssStarters   = starters.filter(p => (p.traits || []).includes('Set Shot Specialist'));
  const bfpSsUnion   = new Set([...bfpStarters, ...ssStarters].map(p => p.id));
  if (sTBigFinalsPerf >= 1 && sTSetShotSpec >= 1 && bfpSsUnion.size >= 2) {
    synergy('clutch-set-shots', 'intangibles', 0.05,
      'Clutch Set Shots: Big Finals Performer and Set Shot Specialist trade match-winners when it matters (+5%)');
  }

  // Lunch-Pail Crew: ladders above Extra Effort (1+ Pressure Machine)
  if (sTPressureMachine >= 2) {
    synergy('lunch-pail-crew', 'intangibles', 0.06,
      `Lunch-Pail Crew: ${sTPressureMachine} Pressure Machines — every 50/50 ball belongs to you (+6%)`);
  }

  // No-Ego Star: a Ruck Bull who also does the dirty work (same player)
  const noEgoStar = starters.find(
    p => p.archetype === 'Ruck Bull' && (p.traits || []).includes('Team Man')
  );
  if (noEgoStar) {
    synergy('no-ego-star', 'intangibles', 0.05,
      `No-Ego Star: ${noEgoStar.name.split(' ').pop()} stars on both ends and still does the dirty work (+5%)`);
  }

  // ── PHASE 4: PENALTIES ────────────────────────────────────────────────────────

  if (sPowerIMCount >= 3 && !sHasGoalSneak) {
    penalty('congested-forward-line', 0.07,
      'Congested Forward Line: Too many crowding forwards, no sharpshooter (-7%)');
  }

  if (sBallMagnetCount >= 3) {
    const teamMen = sT.filter(t => t === 'Team Man').length;
    if (coach !== 'rivers') {
      let amt = coach === 'jackson' ? 0.03 : 0.07;
      amt     = Math.max(0, amt - teamMen * 0.015);
      if (amt > 0) {
        penalty('clashing-egos', amt,
          `Clashing Egos${coach === 'jackson' ? ' (softened by Sheedy)' : ''}: Too many ball-dominant players in the six (-${Math.round(amt * 100)}%)`);
      }
    }
  }

  if (!sHasBallMagnet && starters.length > 5) {
    penalty('no-ball-users', 0.07,
      'No Ball Users: Zero Ball Magnets in the six — no one to drive it forward (-7%)');
  }

  if (coach !== 'riley' && coach !== 'auerbach') {
    const defLiabilityCount = starters.filter(p => (p.tackles + p.clearances) < 2.5).length;
    if (defLiabilityCount >= 3) {
      penalty('defensive-liability', 0.04,
        'Defensive Liability: 3+ starters have weak defensive output (-4%)');
    }
  }

  const totalTallMarks = tallLine.reduce((s, p) => s + p.marks, 0);
  if (tallLine.length >= 2 && !sHasInterceptMkr && totalTallMarks < 12.0) {
    penalty('cant-win-a-contest', 0.07,
      `Can't Win a Contest: Tall line combines for only ${totalTallMarks.toFixed(1)} marks with no Intercept Marker in sight (-7%)`);
  }

  const hasTallDefend = tallLine.some(
    p => p.archetype === 'Lockdown Defender' || p.archetype === 'Intercept Marker'
  );
  if (tallLine.length === 3 && !hasTallDefend) {
    const amt = coach === 'kerr' ? 0.10 : coach === 'auerbach' ? 0.11 : 0.07;
    penalty('defensive-sieve', amt,
      `Defensive Sieve${coach === 'kerr' ? ' (heightened by Clarkson)' : coach === 'auerbach' ? ' (critical for Barassi)' : ''}: Starting tall line offers zero protection at the drop of the ball (-${Math.round(amt * 100)}%)`);
  }

  const highUsageCount = starters.filter(p => p.goals > 2.5 && p.disposals < 16.0).length;
  if (highUsageCount >= 3) {
    penalty('ball-hogs', 0.07,
      'Ball Hogs: 3+ starters chase the highlight reel but rarely find a teammate, stalling ball movement (-7%)');
  }

  const midSlotsFilled = starters.filter(p => ['HB', 'MID', 'SF'].includes(p.pos)).length;
  const midWeakCount   = starters.filter(p => ['HB', 'MID', 'SF'].includes(p.pos) && p.marks < 3.0).length;
  if (midSlotsFilled === 3 && midWeakCount === 3) {
    penalty('undersized-across-the-middle', 0.05,
      'Undersized Across the Middle: Ball-winning group struggles in the air (-5%)');
  }

  const weakScoringStarters = starters.filter(p => p.goals < 0.4).length;
  if (weakScoringStarters >= 3) {
    penalty('nobody-to-kick-a-goal', 0.07,
      'Nobody to Kick a Goal: 3+ starters barely trouble the scoreboard, killing forward-line threat (-7%)');
  }

  if (coach !== 'auerbach') {
    const rucKfClearancesLow = starters
      .filter(p => p.pos === 'RUC' || p.pos === 'KF')
      .reduce((sum, p) => sum + p.clearances, 0);
    if (starters.filter(p => p.pos === 'RUC' || p.pos === 'KF').length === 2 && rucKfClearancesLow < 2.0) {
      penalty('no-contest-presence', 0.07,
        'No Contest Presence: Tall line\'s clearance work falls below 2.0 combined (-7%)');
    }
  }

  // 3 or more starters locked to the same position — role clarity collapses
  // Exception: if secondary positions allow at least one player to slide over,
  // the logjam resolves automatically and no penalty is applied.
  const starterPosCounts = starters.reduce((acc, p) => {
    acc[p.pos] = (acc[p.pos] || 0) + 1; return acc;
  }, {});
  if (Object.values(starterPosCounts).some(n => n >= 3) && !logjamResolvable(starters)) {
    penalty('positional-logjam', 0.12,
      'Positional Logjam: 3+ starters play the same position — role clarity breaks down (-12%)');
  }

  // One-Note Roster: 4+ starters sharing one archetype — a single gear the
  // opponent can scheme against. Ruck Bull is exempt: it is the versatility
  // archetype — four of them is the opposite of one-note.
  const archCounts = sA.reduce((acc, a) => { if (a) acc[a] = (acc[a] || 0) + 1; return acc; }, {});
  const dominantArch = Object.entries(archCounts).find(([a, n]) => n >= 4 && a !== 'Ruck Bull');
  if (dominantArch) {
    penalty('one-note-roster', 0.06,
      `One-Note Roster: ${dominantArch[1]} starters share the ${dominantArch[0]} archetype — one gear, easy to scheme against (-6%)`);
  }

  // No Marking Target: RUC + KF with zero interior scoring touch
  const rucKfStarters = starters.filter(p => p.pos === 'RUC' || p.pos === 'KF');
  if (rucKfStarters.length === 2 && !rucKfStarters.some(
    p => p.archetype === 'Intercept Marker' ||
         (p.traits || []).includes('Contested Marker') ||
         p.goals >= 1.8
  )) {
    penalty('no-marking-target', 0.05,
      'No Marking Target: Neither tall player can win it one-on-one — the defense never has to respect them (-5%)');
  }

  // Nobody to Manufacture a Goal: nobody on the ground can create their own shot
  // when the play breaks down. A 2.5+ goals/game player self-creates by
  // definition — traits alone under-tag elite scorers, so they exempt the roster.
  if (starters.length >= 6 &&
      sTSetShotSpec === 0 && sTContestedMarker === 0 && sTLineBreaker === 0 && sTBigFinalsPerf === 0 &&
      !starters.some(p => p.goals > 2.5)) {
    penalty('nobody-to-manufacture-a-goal', 0.05,
      'Nobody to Manufacture a Goal: No self-generators anywhere — when the passage breaks down, the ball just gets turned over (-5%)');
  }

  // ── PHASE 5: TRAIT PENALTIES ─────────────────────────────────────────────────

  // Everyone Wants the Ball: ball-dominant starters with nobody to facilitate
  if (sTVolumeGK >= 3 && sTEliteDisposal === 0 && starters.length >= 6) {
    penalty('everyone-wants-the-ball', 0.07,
      'Everyone Wants the Ball: 3+ Volume Goalkickers in the six with no Elite Disposal user anywhere to feed them (-7%)');
  }

  // Undefended Inside 50: no interior protection at all
  if (sTInterceptKing === 0 && starters.length >= 6) {
    penalty('undefended-inside-50', 0.06,
      'Undefended Inside 50: No Intercept King in the six — every entry goes uncontested (-6%)');
  }

  // Mental Fragility: team folds in tight finals
  if (sTBigGamePlayer === 0 && starters.length >= 6) {
    penalty('mental-fragility', 0.06,
      'Mental Fragility: No Big Game Players in the six — team folds in tight finals (-6%)');
  }

  // Too Many Cooks: roster-wide ball-dominant congestion
  if (sTVolumeGK >= 4) {
    penalty('too-many-cooks', 0.07,
      `Too Many Cooks: ${sTVolumeGK} Volume Goalkickers in the six — everyone wants the shot, nobody moves it on (-7%)`);
  }

  // No Outlet: no ball movement and no elite disposal user in the six
  if (sTEliteKick === 0 && sTEliteDisposal === 0 && starters.length >= 6) {
    penalty('no-outlet', 0.05,
      'No Outlet: No Elite Kicks and no Elite Disposal user in the six — ball movement collapses under pressure (-5%)');
  }

  // Scoring Drought: lockdown-heavy lineup with no scorers anywhere
  if (sTShutdownBack >= 3 && sTVolumeGK === 0 && starters.length >= 6) {
    penalty('scoring-drought', 0.05,
      'Scoring Drought: 3+ Shutdown Backs in the six with no Volume Goalkickers anywhere to score (-5%)');
  }

  // No Contest Up Tall: kicking width without any intercepting presence
  if (sTEliteKick >= 3 && sTInterceptKing === 0 && starters.length >= 6) {
    penalty('no-contest-up-tall', 0.05,
      'No Contest Up Tall: 3+ Elite Kicks but no Intercept King anywhere — beaten in the air all day (-5%)');
  }

  // ── PHASE 5B: EXPANSION PENALTIES ────────────────────────────────────────────
  // Counterweights for the Phase 3B synergies (stacking one identity plateaus)
  // plus absence verdicts for trait groups that previously had no penalty
  // pathway. Absence checks are guarded by starters.length >= 6 — a partial
  // roster mid-draft or an AI-GM candidate score must not be indicted for
  // pieces it hasn't drafted yet.

  // All Gas No Brakes: line-breakers with nobody controlling it — counterweight
  // to Downhill Attack.
  if (sTLineBreaker >= 3 && sTOnballGeneral === 0 && sTBallWinner === 0 && starters.length >= 6) {
    penalty('all-gas-no-brakes', 0.05,
      'All Gas No Brakes: 3+ Line-Breakers with no Onball General or Ball Winner to control it — turnovers pile up (-5%)');
  }

  // Turnstile Defence: no shutdown, tagging, or two-way defenders anywhere
  if (sTShutdownBack === 0 && sTTagger === 0 && sTRunAndCarry === 0 && starters.length >= 6) {
    penalty('turnstile-defence', 0.06,
      'Turnstile Defence: No Shutdown Back, Tagger, or Run and Carry defender anywhere — opponents walk through the midfield (-6%)');
  }

  // Second Efforts Missing: trait-side counterpart to the stat-based Can't Win
  // a Contest — skipped when that already fired so one weakness isn't billed
  // twice. An 8+ marks starter controls the air by definition — traits
  // under-tag elite markers (same reasoning as the manufacture-a-goal exemption).
  if (sTHitoutMachine === 0 && sTPressureMachine === 0 && starters.length >= 6 &&
      !starters.some(p => p.marks >= 8.0) &&
      !entries.some(e => e.id === 'cant-win-a-contest')) {
    penalty('second-efforts-missing', 0.05,
      'Second Efforts Missing: No Hit-out Machine or Pressure Machine — opponents win every loose ball (-5%)');
  }

  // Handball Chains Only: no transition game at all — walk it up every trip
  if (sTLineBreaker === 0 && !sHasPowerForward &&
      !starters.some(p => p.archetype === 'Ball Magnet' && p.disposals > 26.0) &&
      starters.length >= 6) {
    penalty('handball-chains-only', 0.04,
      'Handball Chains Only: No Line-Breakers and no up-tempo Ball Magnet — zero easy transition goals (-4%)');
  }

  // Congested Marking Contest: high-low contested markers with no kick to
  // punish the double — counterweight to Marking Contest Kings.
  if (sTContestedMarker >= 2 && sTEliteKick === 0) {
    penalty('congested-marking-contest', 0.05,
      'Congested Marking Contest: 2+ Contested Markers with zero Elite Kicks — defenses double up without consequence (-5%)');
  }

  // Nobody Steps Up: too selfless — nobody takes over. Deliberate tension with
  // Captains' Council: 3+ Team Men only cash in alongside a real spearhead.
  if (sTTeamMan >= 3 && !starters.some(p => p.goals > 2.0) && starters.length >= 6) {
    penalty('nobody-steps-up', 0.05,
      'Nobody Steps Up: 3+ Team Men but no genuine spearhead to defer to — everyone shares it, nobody wins the game (-5%)');
  }

  // Closer Logjam: diminishing returns by design — with Ice In Their Veins
  // (+5% at 2+) a third Big Finals Performer nets out to roughly +1%.
  if (sTBigFinalsPerf >= 3) {
    penalty('closer-logjam', 0.04,
      `Closer Logjam: ${sTBigFinalsPerf} Big Finals Performers all want the last say — crunch-time footy stalls (-4%)`);
  }

  // Whose Team Is It: star-stacking without a connector.
  if (starters.filter(p => p.goals > 2.2).length >= 4 && sTTeamMan === 0 && starters.length >= 6) {
    penalty('whose-team-is-it', 0.05,
      'Whose Team Is It: 4+ go-to scorers and zero Team Men — no one connects the pieces (-5%)');
  }

  // Gunners Galore: milder cousin of Everyone Wants the Ball; fires when the
  // table-setter traits are missing entirely. Skipped when that already fired
  // so the same shape isn't billed twice.
  if (sTVolumeGK >= 3 && sTOnballGeneral === 0 && sTBallWinner === 0 && starters.length >= 6 &&
      !entries.some(e => e.id === 'everyone-wants-the-ball')) {
    penalty('gunners-galore', 0.04,
      'Gunners Galore: 3+ Volume Goalkickers with no Onball General or Ball Winner to set it up (-4%)');
  }

  // Soft Two-Way: keeps the One-Note Roster exemption honest — stacking
  // Ruck Bulls is only fine when the defensive tags back it up.
  const rbStarters = starters.filter(p => p.archetype === 'Ruck Bull');
  const DEF_TRAITS = ['Shutdown Back', 'Tagger', 'Run and Carry', 'Intercept King'];
  if (rbStarters.length >= 3 &&
      !rbStarters.some(p => (p.traits || []).some(t => DEF_TRAITS.includes(t)))) {
    penalty('soft-two-way', 0.04,
      'Soft Two-Way: 3+ Ruck Bulls but none carry a real defensive tag — the label doesn\'t stop anyone (-4%)');
  }

  // ── FAMILY CAPS + FINAL SCORE ────────────────────────────────────────────────
  // Sum positives per family; overflow past the family cap is trimmed and
  // reported as an info line so the player learns to diversify. Penalties are
  // never capped.
  let chemBonus = 0;
  const familySums = {};
  for (const e of entries) {
    if (e.kind === 'synergy') familySums[e.family] = (familySums[e.family] || 0) + e.bonus;
    else if (e.kind === 'penalty') chemBonus += e.bonus;
  }
  for (const [family, sum] of Object.entries(familySums)) {
    const cap = FAMILY_CAPS[family] ?? Infinity;
    if (sum > cap + 1e-9) {
      chemBonus += cap;
      add(`cap-${family}`, 'info', family, 0,
        `${FAMILY_LABEL[family]} synergies maxed: capped at +${Math.round(cap * 100)}% — diversify the build to gain more`);
    } else {
      chemBonus += sum;
    }
  }

  const chemScore  = chemScoreFromBonus(chemBonus);
  const chemReport = entries.map(e => (e.kind === 'penalty' ? '🔴 ' : '🟢 ') + e.label);
  return { chemBonus, chemScore, chemReport, chemEntries: entries, lineupAssignment: assignment };
}

/**
 * Returns true if the positional logjam (3+ starters at the same pos) can be
 * resolved by sliding one or more players to their secondary position.
 *
 * Uses backtracking over each player's [primary, ...secondary] options.
 * Worst case: 2^6 = 64 paths — negligible.
 *
 * @param {object[]} starters
 * @returns {boolean}
 */
function logjamResolvable(starters) {
  const posOptions = starters.map(p => [p.pos, ...(p.secondaryPos || [])]);

  function tryAssign(idx, counts) {
    if (idx === posOptions.length) {
      return Object.values(counts).every(n => n < 3);
    }
    for (const pos of posOptions[idx]) {
      counts[pos] = (counts[pos] || 0) + 1;
      if (tryAssign(idx + 1, counts)) {
        counts[pos]--;
        return true;
      }
      counts[pos]--;
    }
    return false;
  }

  return tryAssign(0, {});
}
