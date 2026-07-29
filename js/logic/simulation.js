/**
 * js/logic/simulation.js — Season & Finals Simulation Engine
 *
 * Starters-only format: team strength comes entirely from the starting six.
 * A sigmoid maps adjustedStrength → per-game win probability.
 * Chemistry bonuses/penalties (from chemistry.js) are baked into
 * adjustedStrength before the sigmoid is applied.
 *
 * Exports:
 *   simulateSeason(starters, coach, profile?)  → full result object
 *   simulateSeries(playerStr, oppStr) → single-game finals result object
 *   simulateDynastySeries(playerSeason, opponent) → head-to-head shaped series result
 */

import { DB }                  from '../data/players.js';
import { calculateChemistry, chemScoreFromBonus } from '../logic/chemistry.js';
import { TEAMS, pickCosmetic, S } from '../logic/state.js';
import { eraFactor, eraAdjustedStat, eraAdjustedLine, decadeFromBucketKey } from '../logic/era.js';
import { getModeConfig }       from '../logic/modes.js';

// ── Sigmoid tuning knobs ──────────────────────────────────────────────────────
// SIM_K:      steepness — lower = more gradual spread between good/bad teams
// SIM_CENTER: adjustedStrength that maps to exactly 50% win rate
//             (raise to make 22-0 rarer, lower to make it easier)
// WIN_CAP:    per-game win probability ceiling — 0.90 means even a maxed
//             roster can lose any given week, so 22-0 is never guaranteed
//
// AFL port note: the NBA original's constants (K 3.5, CENTER 1.8, CAP 0.99)
// were fitted to an 82-game season via 400-sample sweeps against its live
// DB, targeting P(82-0) ≈ 1.5% for star-chasing builds. A 22-game season
// needs a much lower per-game ceiling to hit the same target — p^82 = 0.015
// only needs p ≈ 0.95, but p^22 = 0.015 needs p ≈ 0.83. The values below are
// an ANALYTICAL re-derivation from the NBA original's own documented strength
// anchors (star-chasing median strength ≈ 2.36, p90 ≈ 2.75; random median
// ≈ 1.41, p90 ≈ 1.78) rather than a fresh empirical sweep — the ratio-based
// strength formula is scale-invariant to the underlying stat units, so the
// NBA original's strength distribution is a reasonable stand-in until a real
// sweep can run against a full AFL dataset (docs/afl-port-plan.md §9). With
// these constants: star-chasing median strength 2.36 → winPct ≈ 0.70 →
// ~15/22 wins; p90 2.75 → winPct ≈ 0.82 → P(22-0) ≈ 1.3%. Random median
// strength 1.41 → winPct ≈ 0.29 → ~6/22 wins; p90 1.78 → winPct ≈ 0.45 →
// ~10/22 wins.
const SIM_K      = 1.8;
const SIM_CENTER = 1.9;
const WIN_CAP    = 0.90;

let _baselinesCache = null;

/**
 * Derives the dynamic STARTER_BASE from the live DB.
 * Treats the top ~71.4% of players (by composite score) as the starter tier.
 * Stats are era-adjusted (see era.js) before ranking and averaging, so the
 * tier isn't just "whoever played in the highest-possession decade" — a
 * 1970s midfielder's raw disposal count and a 2010s midfielder's raw
 * disposal count are compared on the same footing.
 * Memoized — DB never changes after startup so the sort runs at most once.
 */
function computeSimBaselines() {
  if (_baselinesCache) return _baselinesCache;
  const STATS = ['goals', 'marks', 'disposals', 'tackles', 'clearances'];
  const all   = [];
  for (const [bucketKey, players] of Object.entries(DB)) {
    const decade = decadeFromBucketKey(bucketKey);
    for (const p of players) all.push({ ...eraAdjustedLine({ ...p, decade }) });
  }
  const score  = p => p.goals * 0.35 + p.marks * 0.20 + p.disposals * 0.20 + p.tackles * 0.15 + p.clearances * 0.10;
  const sorted = [...all].sort((a, b) => score(b) - score(a));
  const cut    = Math.round(sorted.length * 5 / 7); // tier cut unchanged — keeps STARTER_BASE proportion identical
  const sTier  = sorted.slice(0, cut);
  const avg    = (arr, stat) => arr.reduce((s, p) => s + p[stat], 0) / arr.length;
  _baselinesCache = {
    STARTER_BASE: Object.fromEntries(STATS.map(k => [k, avg(sTier, k) * 6])), // 6-player starting lineup
  };
  return _baselinesCache;
}

// ── Coach system progress ─────────────────────────────────────────────────────
// Every coach earns the same boost envelope: FLOOR guaranteed, FLOOR + RANGE
// at full system mastery. Progress (0→1) is a steerable drafting objective,
// keyed to quantities the sim already computes so it self-normalizes to the
// live player database. Partial-roster-safe: the draft screen calls this
// every round to drive the live system meter.
const COACH_BOOST_FLOOR = 0.008;
const COACH_BOOST_RANGE = 0.032;

const clamp01 = v => Math.max(0, Math.min(1, v));

/** Avg per-stat ratio of the filled starters vs a pro-rated baseline → 0..1. */
function statRatioProgress(players, stats, base, slotCount) {
  if (!players.length) return 0;
  const frac = players.length / slotCount;
  let sum = 0;
  for (const k of stats) {
    const tot = players.reduce((s, p) => s + eraAdjustedStat(p, k), 0);
    sum += tot / (base[k] * frac);
  }
  // 1.0 = tier-average roster, 1.3 = elite → full meter
  return clamp01(((sum / stats.length) - 1.0) / 0.30);
}

/**
 * @param {string} coach     coach id
 * @param {object[]} starters filled starter players (0–6 during draft)
 * @returns {{ progress: number, metric: string }}
 */
export function coachSystemProgress(coach, starters) {
  const { STARTER_BASE } = computeSimBaselines();

  if (coach === 'jackson') {
    const stars = starters.filter(p => (p.popularity ?? 50) >= 85).length;
    return { progress: clamp01(stars / 5), metric: `${stars}/5 stars` };
  }
  if (coach === 'kerr') {
    const sharpshooters = starters.filter(p => p.archetype === 'Goal Sneak').length;
    return { progress: clamp01(sharpshooters / 3), metric: `${sharpshooters}/3 sharpshooters` };
  }
  if (coach === 'popovich') {
    // Contested Footy — efficient team scoring off clearance work.
    const p = statRatioProgress(starters, ['goals'], STARTER_BASE, 6);
    return { progress: p, metric: `Offense ${Math.round(p * 100)}%` };
  }
  if (coach === 'rivers') {
    // Cohesion — no weak links: keyed to the worst starter stat ratio,
    // the same signal the sim's balance penalty punishes.
    if (!starters.length) return { progress: 0, metric: 'Balance 0%' };
    const frac = starters.length / 6;
    let minRatio = Infinity;
    for (const k of ['goals', 'marks', 'disposals', 'tackles', 'clearances']) {
      const tot = starters.reduce((s, p) => s + eraAdjustedStat(p, k), 0);
      minRatio = Math.min(minRatio, tot / (STARTER_BASE[k] * frac));
    }
    const p = clamp01((minRatio - 0.70) / 0.25);
    return { progress: p, metric: `Balance ${Math.round(p * 100)}%` };
  }
  const starterSystems = {
    auerbach: { stats: ['marks', 'clearances'], label: 'Tall-line D' },
    riley:    { stats: ['tackles'],              label: 'Pressure D' },
    holzman:  { stats: ['disposals'],            label: 'Ball movement' },
  };
  const sys = starterSystems[coach];
  if (sys) {
    const p = statRatioProgress(starters, sys.stats, STARTER_BASE, 6);
    return { progress: p, metric: `${sys.label} ${Math.round(p * 100)}%` };
  }
  return { progress: 0, metric: '' };
}

// ── Loss diagnosis ────────────────────────────────────────────────────────────
// Human-readable labels for each tracked stat.
const STAT_LABEL = {
  goals:      'scoring',
  marks:      'marking',
  disposals:  'ball use',
  tackles:    'defensive pressure',
  clearances: 'clearance work',
};

// Which position slot is most accountable for generating each stat.
// The first position in each array is "most responsible" and so on down.
// This ensures a RUC with low disposals is never indicted for a ball-use
// gap — the MID owns that slot.
const STAT_ROLE_PRIORITY = {
  goals:      ['KF', 'SF', 'MID', 'RUC', 'HB', 'KD'],
  marks:      ['RUC', 'KF', 'KD', 'HB', 'MID', 'SF'],
  disposals:  ['MID', 'HB', 'SF', 'KD', 'RUC', 'KF'],
  tackles:    ['MID', 'SF', 'HB', 'KD', 'RUC', 'KF'],
  clearances: ['MID', 'RUC', 'HB', 'KD', 'KF', 'SF'],
};

// Plain-English draft advice for each stat gap.
const STAT_DRAFT_FIX = {
  goals:      'a more potent forward — look for strong scoring at KF or SF',
  marks:      'a dominant overhead mark — target a RUC or KF with elite marking',
  disposals:  'a ball-winning midfielder — look for strong disposals at MID',
  tackles:    'a pressure defender — target a MID or HB with high tackle numbers',
  clearances: 'a clearance winner — look for a MID or RUC with strong clearance numbers',
};

/**
 * Packages the engine's balance-penalty diagnosis into a structured object
 * the UI can display verbatim — no re-derivation on the UI side needed.
 *
 * Culprit selection uses position-role priority so a ruck is never blamed
 * for a ball-use gap, a defender is never blamed for a scoring gap, etc.
 * Tie-breaking follows: (1) role priority, (2) worst contributor relative to
 * per-player baseline, (3) lowest raw stat value, (4) draft-slot order.
 *
 * @param {object[]} starters
 * @param {string}   weakestStat   — 'goals'|'marks'|'disposals'|'tackles'|'clearances'
 * @param {number}   balancePenalty
 * @param {object}   sRatio        — team stat / STARTER_BASE per stat
 * @param {object}   STARTER_BASE  — 6-player aggregate baselines
 * @returns {object|null}
 */
function buildLossDiagnosis(starters, weakestStat, balancePenalty, sRatio, STARTER_BASE) {
  if (!weakestStat || !starters.length) return null;

  const statLabel      = STAT_LABEL[weakestStat] || weakestStat;
  const teamRatio      = sRatio[weakestStat];
  const perPlayerBase  = STARTER_BASE[weakestStat] / 6; // expected per-starter contribution
  const rolePriority   = STAT_ROLE_PRIORITY[weakestStat] || ['KD', 'HB', 'MID', 'RUC', 'KF', 'SF'];

  // All comparisons below use era-adjusted stats (STARTER_BASE is itself
  // era-adjusted) so a 1970s starter isn't cleared — or a 2010s starter
  // isn't indicted — purely because of the possession volume their era played.
  const adj = p => eraAdjustedStat(p, weakestStat);

  // Build a position → player map for fast lookup. Two starters can share a
  // natural position — keep the weaker one for the weakest stat, since the
  // culprit search below indicts the worst contributor at each role.
  const byPos = {};
  for (const p of starters) {
    if (!byPos[p.pos] || adj(p) < adj(byPos[p.pos])) byPos[p.pos] = p;
  }

  // ── Step 1: find the role-priority player whose stat is below per-player baseline.
  let culprit    = null;
  let culpritPos = null;

  for (const rolePos of rolePriority) {
    const p = byPos[rolePos];
    if (p && adj(p) < perPlayerBase) {
      culprit    = p;
      culpritPos = rolePos;
      break;
    }
  }

  // ── Step 2: every role-priority player is at or above baseline, but the team
  // ratio is still low (secondary positions are dragging).
  if (!culprit) {
    for (const rolePos of rolePriority) {
      const p = byPos[rolePos];
      if (p && (!culprit || adj(p) < adj(culprit))) {
        culprit    = p;
        culpritPos = rolePos;
      }
    }
  }

  // ── Step 3: safety net — position not filled; fall back to lowest raw value.
  if (!culprit) {
    for (const p of starters) {
      if (!culprit || adj(p) < adj(culprit)) culprit = p;
    }
    culpritPos = culprit?.pos ?? null;
  }

  // If the culprit is actually at or above the per-player baseline the weakness
  // is genuinely team-wide, not a single-player failure — flag it that way.
  // Require a meaningfully-sized gap (15%+ below baseline) before singling
  // anyone out; a marginal shortfall falls back to the team-wide framing.
  const CULPRIT_MARGIN   = 0.85;
  const culpritBelowBase = culprit ? adj(culprit) < perPlayerBase * CULPRIT_MARGIN : false;

  return {
    primaryCause:      'balance_penalty',
    statKey:           weakestStat,
    statLabel,
    teamRatio:         +teamRatio.toFixed(3),
    penaltyAmount:     +balancePenalty.toFixed(4),
    culpritId:         culprit?.id          ?? null,
    culpritName:       culprit?.name        ?? null,
    culpritPos,
    culpritStat:       culprit ? +adj(culprit).toFixed(1) : null,
    perPlayerBase:     +perPlayerBase.toFixed(1),
    culpritBelowBase,
    recommendedFix:    STAT_DRAFT_FIX[weakestStat] ?? `a stronger ${statLabel} contributor`,
  };
}

// ── Per-player season stat lines ──────────────────────────────────────────────
// Believable individual box-score lines for a simulated season. Each starter's
// line tracks their real per-game averages, perturbed by a per-season "form"
// roll (a hot/cold year) and gently coupled to team success — so two sims of the
// same roster differ without drifting away from who the player really is.
//
// Generated ONCE inside simulateSeason() and frozen into the result — never in
// the renderer — so the numbers shown on the end screen are identical to the
// ones saved to the leaderboard.
const PLAYER_STAT_KEYS = ['goals', 'marks', 'disposals', 'tackles', 'clearances'];
// per-game key → season-total key
const SEASON_TOTAL_KEY = { goals: 'gls', marks: 'mks', disposals: 'dsp', tackles: 'tck', clearances: 'clr' };

/** Standard-normal sample via Box–Muller. */
function gaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Generates believable per-player season lines + a stat-leader summary.
 *
 * @param {object[]} starters
 * @param {number}   winPct  team per-game win probability (0..1)
 * @returns {{ playerStats: object[], statLeaders: object, simTotals: object }}
 */
function simulatePlayerStats(starters, winPct) {
  // Team-success coupling: a juggernaut lifts everyone slightly, a cellar team
  // drags them down — deliberately gentle so it never distorts who the player is.
  const teamFactor = 1 + (clampNum(winPct, 0, 1) - 0.5) * 0.04; // 0.98 … 1.02
  const gp = 22;

  const playerStats = starters.map(p => {
    // One hot/cold roll per season. Season averages over 22 games are stable in
    // reality, so the swing is tight — a 3.5-goal/game forward lands ~3.2–3.8, not 2.5–4.5.
    const form = clampNum(1 + gaussian() * 0.035, 0.91, 1.09);
    const line = { id: p.id, name: p.name, pos: p.pos, gp };
    for (const k of PLAYER_STAT_KEYS) {
      const perGame = Math.max(0, (p[k] || 0) * form * teamFactor);
      const rounded = Math.round(perGame * 10) / 10;
      line[k] = rounded;
      line[SEASON_TOTAL_KEY[k]] = Math.round(rounded * gp); // season total
    }
    return line;
  });

  // Best starter in each category this season.
  const leaderFor = k => {
    let best = null;
    for (const l of playerStats) if (!best || l[k] > best[k]) best = l;
    return best ? { id: best.id, name: best.name, val: best[k] } : null;
  };
  const statLeaders = {
    scoring:    leaderFor('goals'),
    marking:    leaderFor('marks'),
    disposals:  leaderFor('disposals'),
    tackling:   leaderFor('tackles'),
    clearances: leaderFor('clearances'),
  };

  const simTotals = PLAYER_STAT_KEYS.reduce((acc, k) => {
    acc[k] = +playerStats.reduce((s, l) => s + l[k], 0).toFixed(1);
    return acc;
  }, {});

  return { playerStats, statLeaders, simTotals };
}

/**
 * Splits a total-points value into goals (worth 6) + behinds (worth 1) at a
 * plausible AFL conversion rate, guaranteeing goals*6+behinds === points
 * exactly (the remainder always absorbs into behinds, so it stays exact even
 * though the split point is randomized).
 */
function splitScore(points) {
  const behindsGuess = Math.min(points, 4 + Math.floor(Math.random() * 12)); // 4-15, clamped
  const goals        = Math.floor((points - behindsGuess) / 6);
  const behinds       = points - goals * 6;
  return { goals, behinds, points };
}

/**
 * Simulates a full 22-game home-and-away season.
 *
 * @param {object[]} starters  6 starting player objects
 * @param {string|null} coach
 * @param {string} [profile]   'classic' | 'defense' | 'fans' — defaults from S.mode
 * @returns {object}
 */
export function simulateSeason(starters, coach = null, profile = null) {
  const simProfile = profile || getModeConfig(S?.mode).simProfile || 'classic';

  // Era-adjusted totals drive the win-probability engine, so a roster stacked
  // with high-possession-era players doesn't out-strength an equally good
  // roster from a lower-possession era just because of the ball flowing more.
  const sumStats = arr => arr.reduce(
    (acc, p) => {
      const adj = eraAdjustedLine(p);
      return {
        goals:      acc.goals      + adj.goals,
        marks:      acc.marks      + adj.marks,
        disposals:  acc.disposals  + adj.disposals,
        tackles:    acc.tackles    + adj.tackles,
        clearances: acc.clearances + adj.clearances,
      };
    },
    { goals: 0, marks: 0, disposals: 0, tackles: 0, clearances: 0 }
  );

  const sTotals = sumStats(starters);

  const { STARTER_BASE } = computeSimBaselines();

  const sRatio = {
    goals:      sTotals.goals      / STARTER_BASE.goals,
    marks:      sTotals.marks      / STARTER_BASE.marks,
    disposals:  sTotals.disposals  / STARTER_BASE.disposals,
    tackles:    sTotals.tackles    / STARTER_BASE.tackles,
    clearances: sTotals.clearances / STARTER_BASE.clearances,
  };

  // Starters-only: the starting six IS the team.
  const ratio = sRatio;

  const weights = simProfile === 'defense'
    ? { goals: 0.10, marks: 0.30, disposals: 0.10, tackles: 0.25, clearances: 0.25 }
    : { goals: 0.35, marks: 0.20, disposals: 0.20, tackles: 0.15, clearances: 0.10 };

  const strength =
    ratio.goals      * weights.goals +
    ratio.marks      * weights.marks +
    ratio.disposals  * weights.disposals +
    ratio.tackles    * weights.tackles +
    ratio.clearances * weights.clearances;

  // Defense mode: prefer diagnosing marks/tackles/clearances shortfalls first.
  const diagEntries = simProfile === 'defense'
    ? Object.entries(sRatio).filter(([k]) => k === 'marks' || k === 'tackles' || k === 'clearances')
    : Object.entries(sRatio);
  const weakestStatEntry = (diagEntries.length ? diagEntries : Object.entries(sRatio))
    .reduce((min, e) => e[1] < min[1] ? e : min);
  const weakestStat      = weakestStatEntry[0];
  const minStarterRatio  = weakestStatEntry[1];
  const balancePenalty   = minStarterRatio < 0.82 ? (0.82 - minStarterRatio) * 0.8 : 0;

  const lossDiagnosis = buildLossDiagnosis(starters, weakestStat, balancePenalty, sRatio, STARTER_BASE);

  let { chemBonus, chemScore, chemReport, chemEntries, lineupAssignment } = calculateChemistry(starters, coach);

  if (simProfile === 'defense') {
    // Structured families replace label-regex sniffing, which silently breaks
    // whenever a synergy is renamed and misclassifies edge cases.
    const hasDef = chemEntries.some(e => e.kind === 'synergy' && e.family === 'defense');
    const hasOff = chemEntries.some(e => e.kind === 'synergy' && e.family === 'offense');
    if (hasDef) chemBonus *= 1.35;
    else if (hasOff) chemBonus *= 0.75;
    chemScore = chemScoreFromBonus(chemBonus);
  }

  // Unified coach boost — every coach has the same floor and the same
  // reachable ceiling; only the SYSTEM you must draft toward differs.
  const coachBoost = coach
    ? COACH_BOOST_FLOOR + coachSystemProgress(coach, starters).progress * COACH_BOOST_RANGE
    : 0;

  const baseStrength = Math.max(0, strength - balancePenalty + chemBonus + coachBoost);

  // ── Popularity / Fan-Hype modifier ───────────────────────────────────────
  const POP_FLOOR   = 35;
  const POP_CEIL    = 100;
  const MUL_MIN     = simProfile === 'fans' ? 0.90 : 0.97;
  const MUL_MAX     = simProfile === 'fans' ? 1.12 : 1.04;
  const allPlayers  = starters;
  const avgPop      = allPlayers.length
    ? allPlayers.reduce((s, p) => s + (p.popularity || 50), 0) / allPlayers.length
    : 50;
  const popNorm     = Math.max(0, Math.min(1, (avgPop - POP_FLOOR) / (POP_CEIL - POP_FLOOR)));
  const popMul      = MUL_MIN + popNorm * (MUL_MAX - MUL_MIN);

  // ── Player-Rating modifier ────────────────────────────────────────────────
  // Keyed to `overall`. The AFL stub DB's overall distribution currently
  // averages ~77 (vs the NBA original's ~87) — a real 2K-style composite
  // rating pipeline doesn't exist yet for AFL (see docs/afl-port-plan.md
  // §4.4), so `overall` just mirrors the stats-derived `rating` for now.
  // RATING_MID tracks that ~77 mean; revisit once the real dataset lands.
  const RATING_MID  = 77;
  const RATING_SPAN = 10;
  const RATING_AMP  = 0.04;
  const avgRating   = allPlayers.length
    ? allPlayers.reduce((s, p) => s + (p.overall ?? 77), 0) / allPlayers.length
    : 77;
  const ratingNorm  = Math.max(-1, Math.min(1, (avgRating - RATING_MID) / RATING_SPAN));
  const ratingMul   = 1 + ratingNorm * RATING_AMP;

  const adjustedStrength = baseStrength * popMul * ratingMul;
  const popEloDelta    = +(baseStrength * (popMul - 1)).toFixed(3);
  const ratingEloDelta = +(baseStrength * popMul * (ratingMul - 1)).toFixed(3);

  const fansM = +(Math.pow(popNorm, 1.5) * 38 + 2).toFixed(1);

  const winPct = Math.min(WIN_CAP, 1 / (1 + Math.exp(-SIM_K * (adjustedStrength - SIM_CENTER))));

  let wins = 0;
  const games = [];
  for (let i = 0; i < 22; i++) {
    const won = Math.random() < winPct;
    if (won) wins++;
    games.push({ won });
  }
  wins = Math.max(0, Math.min(22, wins));
  decorateSeasonGames(games, winPct);

  const totals = { ...sTotals };

  const { playerStats, statLeaders, simTotals } = simulatePlayerStats(starters, winPct);

  const teamPressure = +(sTotals.tackles + sTotals.clearances).toFixed(1);

  return {
    wins,
    losses:     22 - wins,
    winPct:     +(winPct * 100).toFixed(1),
    strength:   +adjustedStrength.toFixed(3),
    baseStrength: +baseStrength.toFixed(3),
    totals, ratio, sTotals,
    balancePenalty: +balancePenalty.toFixed(4), weakestStat, lossDiagnosis,
    chemScore, chemReport, chemEntries, lineupAssignment,
    avgPopularity: +avgPop.toFixed(1),
    popEloDelta,
    avgRating:  +avgRating.toFixed(1),
    ratingMul:  +ratingMul.toFixed(4),
    ratingEloDelta,
    playerStats, statLeaders, simTotals,
    fansM,
    coachBoost: +coachBoost.toFixed(3),
    games,
    simProfile,
    teamPressure,
  };
}

/**
 * Decorates a season's win/loss sequence with opponents, scores (goals and
 * behinds, plus total points), and margins. Stronger teams (higher winPct)
 * win bigger; losses skew close so they read as heartbreakers rather than
 * blowouts.
 */
function decorateSeasonGames(games, winPct) {
  let lastOpp = null;
  for (const g of games) {
    // pickCosmetic, not pick: the daily seed governs draft OFFERS only —
    // season dressing drawing from the seeded stream contradicted that
    // invariant (documented in state.js) whenever a daily run simulated.
    let opp = pickCosmetic(TEAMS);
    // Re-draw until the opponent differs from the previous game's (bounded —
    // a single retry still let back-to-back repeats slip through ~0.1% of rows)
    for (let t = 0; t < 5 && opp === lastOpp; t++) opp = pickCosmetic(TEAMS);
    lastOpp = opp;

    const r      = Math.random();
    const exp    = g.won ? Math.max(0.55, 1.6 - winPct) : 2.2;
    const margin = 2 + Math.floor(Math.pow(r, exp) * 44);    // 2–46, AFL margins run wider than a basketball game
    const base   = 60 + Math.floor(Math.random() * 46);       // 60–105 typical AFL team score

    g.opp    = opp;
    g.ps     = g.won ? base + Math.ceil(margin / 2) : base - Math.floor(margin / 2);
    g.os     = g.won ? base - Math.floor(margin / 2) : base + Math.ceil(margin / 2);
    g.margin = margin;
    g.type   = margin >= 25 ? 'blowout' : margin >= 12 ? 'solid' : 'close';

    const psSplit = splitScore(Math.max(0, g.ps));
    const osSplit = splitScore(Math.max(0, g.os));
    g.psGoals   = psSplit.goals;
    g.psBehinds = psSplit.behinds;
    g.osGoals   = osSplit.goals;
    g.osBehinds = osSplit.behinds;
  }
}

/**
 * Generates a realistic AFL scoreline for one head-to-head game (goals and
 * behinds on each side, decomposed from a points total in the 60-135 range).
 */
function generateGameScore(p1Strength, p2Strength) {
  const p1WinProb = 1 / (1 + Math.exp(-6 * (p1Strength - p2Strength)));
  const p1Wins    = Math.random() < p1WinProb;

  const base   = 60 + Math.floor(Math.random() * 46);   // 60–105
  // Margin: skewed toward close games (square the random to weight lower values)
  const r      = Math.random();
  const margin = 2 + Math.floor(r * r * 44);             // 2–45, skewed low

  const winnerScore = base + Math.floor(margin / 2);
  const loserScore  = base - Math.ceil(margin / 2);

  const p1Score = p1Wins ? winnerScore : loserScore;
  const p2Score = p1Wins ? loserScore  : winnerScore;
  const p1Split = splitScore(Math.max(0, p1Score));
  const p2Split = splitScore(Math.max(0, p2Score));

  return {
    p1Score, p2Score,
    p1Goals: p1Split.goals, p1Behinds: p1Split.behinds,
    p2Goals: p2Split.goals, p2Behinds: p2Split.behinds,
    p1Won:   p1Wins,
  };
}

/**
 * Simulates a head-to-head best-of-3 Challenge Series between two drafted
 * rosters (1v1 / GM vs AI). AFL has no real best-of-N series format — this
 * is a fantasy exhibition format, not a claim about how AFL is played (see
 * docs/afl-port-plan.md D6).
 * Returns season stats for both teams + the series outcome.
 *
 * @param {object[]} p1Starters  @param {string|null} p1Coach
 * @param {object[]} p2Starters  @param {string|null} p2Coach
 * @returns {{ p1Season, p2Season, series, winner: 'p1'|'p2' }}
 */
export function simulateHeadToHeadSeries(p1Starters, p1Coach, p2Starters, p2Coach) {
  const p1Season = simulateSeason(p1Starters, p1Coach);
  const p2Season = simulateSeason(p2Starters, p2Coach);

  const p1Str = p1Season.strength;
  const p2Str = p2Season.strength;

  // Pre-compute all games with realistic scores. Best-of-3: first to 2.
  const games = [];
  let p1Wins = 0, p2Wins = 0;
  while (p1Wins < 2 && p2Wins < 2) {
    const g = generateGameScore(p1Str, p2Str);
    if (g.p1Won) p1Wins++; else p2Wins++;
    games.push({ gameNum: games.length + 1, ...g, p1WinsAfter: p1Wins, p2WinsAfter: p2Wins });
  }

  const winner = p1Wins === 2 ? 'p1' : 'p2';
  // backwards-compat shape used by renderSeriesResult
  const series = {
    playerWins: p1Wins,
    oppWins:    p2Wins,
    games:      games.map(g => g.p1Won ? 'W' : 'L'),
    won:        winner === 'p1',
  };

  return { p1Season, p2Season, games, p1Wins, p2Wins, winner, series };
}

/**
 * Best-of-3 Challenge Series vs a Dynasty Duel CPU team (no opposing roster
 * cards). Returns the same shape as simulateHeadToHeadSeries for shared
 * series UI.
 */
export function simulateDynastySeries(playerSeason, opponent) {
  const p1Str = playerSeason.strength;
  const p2Str = opponent.strength;
  const p2Season = {
    strength: p2Str,
    chemScore: 88,
    chemReport: [`🟢 Legendary dynasty: ${opponent.name}`],
    wins: 19,
    losses: 3,
    avgPopularity: 92,
    fansM: 38,
    teamPressure: 0,
  };

  const games = [];
  let p1Wins = 0, p2Wins = 0;
  while (p1Wins < 2 && p2Wins < 2) {
    const g = generateGameScore(p1Str, p2Str);
    if (g.p1Won) p1Wins++; else p2Wins++;
    games.push({ gameNum: games.length + 1, ...g, p1WinsAfter: p1Wins, p2WinsAfter: p2Wins });
  }

  const winner = p1Wins === 2 ? 'p1' : 'p2';
  const series = {
    playerWins: p1Wins,
    oppWins:    p2Wins,
    games:      games.map(g => g.p1Won ? 'W' : 'L'),
    won:        winner === 'p1',
  };

  return { p1Season: playerSeason, p2Season, games, p1Wins, p2Wins, winner, series, opponent };
}

/**
 * Simulates a single AFL final (every round of the Final Eight is single
 * elimination — no best-of-N in real AFL finals). Kept as a "series" shape
 * ({ playerWins, oppWins, games, won }) so playoffs.js's bracket-scoring
 * helpers (matchupScores etc.) don't need to know the round is one game —
 * playerWins/oppWins just land at 1/0 or 0/1.
 *
 * @param {number} playerStrength
 * @param {number} opponentStrength
 * @returns {{ playerWins: number, oppWins: number, games: string[], won: boolean }}
 */
export function simulateSeries(playerStrength, opponentStrength) {
  const pWin = 1 / (1 + Math.exp(-6 * (playerStrength - opponentStrength)));
  const won  = Math.random() < pWin;
  return {
    playerWins: won ? 1 : 0,
    oppWins:    won ? 0 : 1,
    games:      [won ? 'W' : 'L'],
    won,
  };
}
