/**
 * js/logic/era.js — Dual Era Normalization (disposal volume + scoring)
 *
 * Counting stats aren't era-neutral, but AFL moved on two axes that run in
 * OPPOSITE directions, unlike the NBA original's single pace factor:
 *   - Disposal volume has climbed steadily (interchange rotations, faster
 *     ball movement) — a modern midfielder racks up more of the ball than
 *     an equally dominant 1970s midfielder did, purely because there's more
 *     ball flowing through the game now.
 *   - Scoring has fallen (defensive structures, congestion, "the flood") —
 *     a 1980s forward's goals came in a much higher-scoring league than a
 *     2020s forward's.
 * So disposals/marks/tackles/clearances (possession-volume stats) get
 * rescaled by DISPOSAL_FACTOR; goals (a scoreboard stat) gets rescaled by
 * SCORING_FACTOR, in the opposite direction.
 *
 * The league-average anchors below are documented estimates of real trends
 * (interchange-rotation growth, the post-2000s scoring decline), not a
 * scrape of actual AFL Tables league totals — re-derive them from real data
 * before this port leaves MVP status (see docs/afl-port-plan.md §4.3/§9).
 * Both factor tables reference the 2020s, matching the NBA original's
 * convention of normalizing to the most recent decade.
 */

// Approximate league-average team disposals per game, by decade.
const DISPOSAL_LEAGUE_AVG = {
  '1970s': 330,
  '1980s': 340,
  '1990s': 360,
  '2000s': 380,
  '2010s': 395,
  '2020s': 385,
};

// Approximate league-average team score (points) per game, by decade.
const SCORING_LEAGUE_AVG = {
  '1970s': 98,
  '1980s': 108,
  '1990s': 102,
  '2000s': 88,
  '2010s': 86,
  '2020s': 78,
};

const REFERENCE_DISPOSAL = DISPOSAL_LEAGUE_AVG['2020s'];
const REFERENCE_SCORING  = SCORING_LEAGUE_AVG['2020s'];

// Which of the two factors each counting stat uses.
const STAT_FACTOR_KIND = {
  goals:      'scoring',
  marks:      'disposal',
  disposals:  'disposal',
  tackles:    'disposal',
  clearances: 'disposal',
};

/**
 * Multiplier that rescales a decade's raw stat to modern-equivalent volume.
 * @param {string} decade
 * @param {'disposal'|'scoring'} kind
 */
export function eraFactor(decade, kind = 'disposal') {
  if (kind === 'scoring') {
    const avg = decade && SCORING_LEAGUE_AVG[decade];
    return avg ? REFERENCE_SCORING / avg : 1;
  }
  const avg = decade && DISPOSAL_LEAGUE_AVG[decade];
  return avg ? REFERENCE_DISPOSAL / avg : 1;
}

/** A single stat (goals/marks/disposals/tackles/clearances), era-rescaled. */
export function eraAdjustedStat(player, key) {
  const kind = STAT_FACTOR_KIND[key] || 'disposal';
  return (player?.[key] || 0) * eraFactor(player?.decade, kind);
}

const COUNTING_STATS = ['goals', 'marks', 'disposals', 'tackles', 'clearances'];

/** All five counting stats, era-rescaled, as a fresh object. */
export function eraAdjustedLine(player) {
  const line = {};
  for (const k of COUNTING_STATS) line[k] = eraAdjustedStat(player, k);
  return line;
}

/** Extracts the '1970s'-style decade suffix from a "Club_1970s" DB bucket key. */
export function decadeFromBucketKey(key) {
  return key.match(/_(\d{4}s)$/)?.[1] ?? null;
}
