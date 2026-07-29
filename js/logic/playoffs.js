/**
 * js/logic/playoffs.js — AFL Final Eight bracket display & round advancement
 *
 * Real AFL Final Eight structure (the "McIntyre Final 8 System"), four weeks:
 *
 *   Week 1: Qualifying Final 1 (1v4), Qualifying Final 2 (2v3),
 *           Elimination Final 1 (5v8), Elimination Final 2 (6v7).
 *           EF losers are eliminated. QF losers survive to Week 2.
 *           QF winners get the double-chance BYE straight to Week 3.
 *   Week 2 (Semi Finals): QF1 loser vs EF2 winner; QF2 loser vs EF1 winner.
 *           (Note the cross: QF1's loser meets EF2's winner, not EF1's.)
 *   Week 3 (Preliminary Finals): QF1 winner vs SF2 winner; QF2 winner vs SF1 winner.
 *   Week 4: Grand Final — the two Preliminary Final winners.
 *
 * Every match is single elimination (simulateSeries() now returns a single
 * game's result, not a best-of-N series) — there is no best-of-N in real AFL
 * finals. See docs/afl-port-plan.md §6.4.
 */

// Labels for Week 1's four matches, in the exact order buildBracket()
// (state.js) returns them: QF1, QF2, EF1, EF2.
export const WEEK1_LABELS = [
  { label: 'Qualifying Final 1', sublabel: '1 v 4' },
  { label: 'Qualifying Final 2', sublabel: '2 v 3' },
  { label: 'Elimination Final 1', sublabel: '5 v 8' },
  { label: 'Elimination Final 2', sublabel: '6 v 7' },
];

export const ROUND_NAMES = ['Finals Week 1', 'Semi Finals', 'Preliminary Finals', 'Grand Final'];

/** @param {object} result  single-game result with teamA, teamB, won */
export function seriesWinner(result) {
  return result.won ? result.teamA : result.teamB;
}

/** @param {object} result  single-game result with teamA, teamB, won */
export function seriesLoser(result) {
  return result.won ? result.teamB : result.teamA;
}

/** Scores for top/bottom teams in a matchup result. */
export function matchupScores(result, topTeam, bottomTeam) {
  const topIsA = result.teamA.name === topTeam.name;
  return {
    topScore:    topIsA ? result.playerWins : result.oppWins,
    bottomScore: topIsA ? result.oppWins   : result.playerWins,
    topWon:      topIsA ? result.won       : !result.won,
  };
}

function emptySlot(top, bottom, extra = {}) {
  return {
    top, bottom,
    topScore: null, bottomScore: null, topWon: null,
    complete: false, live: false,
    ...extra,
  };
}

function fillSlot(slot, result) {
  if (!result || !slot.top || !slot.bottom) return slot;
  const s = matchupScores(result, slot.top, slot.bottom);
  return { ...slot, topScore: s.topScore, bottomScore: s.bottomScore, topWon: s.topWon, complete: true };
}

/**
 * Builds the full four-week bracket tree for rendering.
 * @param {object} po  S.playoffs
 */
export function getBracketDisplayState(po) {
  const r0 = po.rounds[0]; // Week 1 results: [QF1, QF2, EF1, EF2]
  const r1 = po.rounds[1]; // Week 2 results: [SF1, SF2]
  const r2 = po.rounds[2]; // Week 3 results: [PF1, PF2]
  const r3 = po.rounds[3]; // Week 4 result:  [GF]

  const week1 = po.initialBracket.map(([top, bottom], i) => {
    const slot = emptySlot(top, bottom, WEEK1_LABELS[i]);
    return fillSlot(slot, r0?.[i]);
  });

  const qf1Winner = r0 ? seriesWinner(r0[0]) : null;
  const qf1Loser  = r0 ? seriesLoser(r0[0])  : null;
  const qf2Winner = r0 ? seriesWinner(r0[1]) : null;
  const qf2Loser  = r0 ? seriesLoser(r0[1])  : null;
  const ef1Winner = r0 ? seriesWinner(r0[2]) : null;
  const ef2Winner = r0 ? seriesWinner(r0[3]) : null;

  const sf1 = fillSlot(
    emptySlot(qf1Loser, ef2Winner, { label: 'Semi Final 1' }), r1?.[0]);
  const sf2 = fillSlot(
    emptySlot(qf2Loser, ef1Winner, { label: 'Semi Final 2' }), r1?.[1]);

  const week2 = {
    matchups: [sf1, sf2],
    byes: [qf1Winner, qf2Winner], // double-chance — these two skip Week 2 entirely
  };

  const sf1Winner = r1 ? seriesWinner(r1[0]) : null;
  const sf2Winner = r1 ? seriesWinner(r1[1]) : null;

  const pf1 = fillSlot(
    emptySlot(qf1Winner, sf2Winner, { label: 'Preliminary Final 1' }), r2?.[0]);
  const pf2 = fillSlot(
    emptySlot(qf2Winner, sf1Winner, { label: 'Preliminary Final 2' }), r2?.[1]);

  const week3 = { matchups: [pf1, pf2] };

  const pf1Winner = r2 ? seriesWinner(r2[0]) : null;
  const pf2Winner = r2 ? seriesWinner(r2[1]) : null;

  const gf = fillSlot(
    emptySlot(pf1Winner, pf2Winner, { label: 'Grand Final' }), r3?.[0]);

  const week4 = { matchups: [gf] };

  let champion = null;
  if (r3?.[0]) champion = seriesWinner(r3[0]);
  else if (po.championTeam) champion = po.championTeam;

  // Live tick-state overlay for the active round
  const ts = po.tickState;
  if (ts?.results) {
    const ri = po.currentRound;
    const targetSlots =
      ri === 0 ? week1 :
      ri === 1 ? week2.matchups :
      ri === 2 ? week3.matchups :
      week4.matchups;
    ts.results.forEach((sr, i) => {
      const slot = targetSlots[i];
      if (!slot) return;
      const rev = sr.games.slice(0, ts.revealedGames);
      const topScore    = rev.filter(g => g === 'W').length;
      const bottomScore = rev.filter(g => g === 'L').length;
      Object.assign(slot, {
        topScore, bottomScore,
        live: !ts.done, complete: ts.done,
        topWon: ts.done ? sr.won : null,
      });
    });
  }

  return { week1, week2, week3, week4, champion, currentRound: po.currentRound, roundNames: ROUND_NAMES };
}

/**
 * Applies a completed round's results and advances bracket state to the next
 * week. Always simulates the full bracket — player elimination does not halt
 * advancement (CPU-vs-CPU matches keep resolving so the bracket completes).
 *
 * @returns {'champion'|'complete'|'eliminated'|'advanced'}
 */
export function applyPlayoffRound(po, results) {
  po.rounds.push(results);

  const playerIdx = results.findIndex(r => r.teamA.isPlayer || r.teamB.isPlayer);
  if (playerIdx >= 0 && !po.eliminated) {
    const playerResult = results[playerIdx];
    const playerWon = playerResult.teamA.isPlayer ? playerResult.won : !playerResult.won;
    // Week 1 is the double-chance week: losing a Qualifying Final (index 0
    // or 1, per WEEK1_LABELS' QF1/QF2/EF1/EF2 order) drops the player to the
    // Semi Finals, it does NOT eliminate them — only an Elimination Final
    // loss (index 2 or 3) does. Every later round is straight knockout.
    const survivableLoss = po.currentRound === 0 && playerIdx < 2;
    if (!playerWon && !survivableLoss) {
      po.eliminated   = true;
      po.eliminatedIn = po.roundNames[po.currentRound];
    }
  }

  if (po.currentRound === 0) {
    // Week 1 (QF1, QF2, EF1, EF2) -> Week 2 (Semi Finals), with a bye for
    // both Qualifying Final winners.
    const [qf1, qf2, ef1, ef2] = results;
    const qf1Loser  = seriesLoser(qf1);
    const qf2Loser  = seriesLoser(qf2);
    const ef1Winner = seriesWinner(ef1);
    const ef2Winner = seriesWinner(ef2);
    po.qfWinners = [seriesWinner(qf1), seriesWinner(qf2)]; // saved for Week 3
    po.bracket = [[qf1Loser, ef2Winner], [qf2Loser, ef1Winner]];
    po.currentRound = 1;
    return po.eliminated ? 'eliminated' : 'advanced';
  }

  if (po.currentRound === 1) {
    // Week 2 (Semi Finals) -> Week 3 (Preliminary Finals). The two Week-1
    // bye teams (Qualifying Final winners) rejoin here.
    const [sf1, sf2] = results;
    const sf1Winner = seriesWinner(sf1);
    const sf2Winner = seriesWinner(sf2);
    po.bracket = [[po.qfWinners[0], sf2Winner], [po.qfWinners[1], sf1Winner]];
    po.currentRound = 2;
    return po.eliminated ? 'eliminated' : 'advanced';
  }

  if (po.currentRound === 2) {
    // Week 3 (Preliminary Finals) -> Week 4 (Grand Final).
    const [pf1, pf2] = results;
    po.bracket = [[seriesWinner(pf1), seriesWinner(pf2)]];
    po.currentRound = 3;
    return po.eliminated ? 'eliminated' : 'advanced';
  }

  // Week 4 (Grand Final) — the bracket is decided.
  po.championTeam = seriesWinner(results[0]);
  po.champion     = !!po.championTeam?.isPlayer;
  po.currentRound = 4;
  return po.champion ? 'champion' : 'complete';
}
