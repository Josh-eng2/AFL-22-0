/**
 * Shared season-tier labels — used by the results screen AND share cards so
 * the emotional punchline never disagrees with the clipboard caption.
 *
 * Thresholds (wins out of 22):
 *   22      → PERFECT SEASON
 *   ≥19     → Historic Season
 *   ≥16     → Flag Contender
 *   ≥8      → Finals Contender  (aligned with the Finals qualification floor)
 *   else    → Rebuild Required
 */
export function seasonTier(wins) {
  const w = Number(wins) || 0;
  if (w === 22) return { id: 'perfect',  label: 'PERFECT SEASON',    emoji: '🏆' };
  if (w >= 19)  return { id: 'historic', label: 'Historic Season',   emoji: '🔥' };
  if (w >= 16)  return { id: 'elite',    label: 'Flag Contender',    emoji: '⭐' };
  if (w >= 8)   return { id: 'playoff',  label: 'Finals Contender',  emoji: '✅' };
  return            { id: 'rebuild', label: 'Rebuild Required',  emoji: '📋' };
}

/**
 * Single-letter season grade for the results hero's gold badge.
 *
 * Deliberately finer-grained than seasonTier — the tier label already sits
 * beside the badge, so a grade that only had five steps would just repeat it.
 * The bands still line up with the tier boundaries (22 → S, 19 → A+, 16 → A,
 * 8 → B) so the letter and the label never tell different stories.
 *
 * Rescaled from the NBA original's 82-game ladder (82/73/65/55/41/30/20),
 * anchored on this game's own tier cuts rather than by proportion: B is the
 * finals floor at 8 wins, and B+ splits the gap to the Flag Contender cut.
 */
export function seasonGrade(wins) {
  const w = Number(wins) || 0;
  if (w === 22) return 'S';
  if (w >= 19)  return 'A+';
  if (w >= 16)  return 'A';
  if (w >= 12)  return 'B+';
  if (w >= 8)   return 'B';
  if (w >= 6)   return 'C';
  if (w >= 4)   return 'D';
  return 'F';
}
