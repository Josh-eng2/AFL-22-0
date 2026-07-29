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
