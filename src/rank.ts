import { blendedVolatility } from './volatility.ts';
import type { Candidate, Components, RankWeights, RankedCandidate, RankedScan, Ranks, ScanResult, SymbolInfo } from './types.ts';

/**
 * Each value's rank among the non-null values, 0 for the lowest and 1 for the highest, ties sharing
 * their average rank. Null stays null. A lone value ranks 0.5: there is nothing to compare it with.
 */
export function percentRanks(values: Array<number | null>): Array<number | null> {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return values.map(() => null);
  if (present.length === 1) return values.map((v) => (v === null ? null : 0.5));
  const sorted = [...present].sort((a, b) => a - b);
  const rankOf = (v: number): number => {
    const first = sorted.indexOf(v);
    const last = sorted.lastIndexOf(v);
    return (first + last) / 2 / (sorted.length - 1);
  };
  return values.map((v) => (v === null ? null : rankOf(v)));
}

/**
 * A score for each underlying from what tastytrade's metrics already say, before any option is
 * quoted: its IV percentile and its IV over realised volatility, ranked across the list and
 * weighted as in the full ranking. A name with no historical volatility is judged on the
 * percentile alone. This only decides which names are worth the expensive calls.
 */
export function preScores(infos: Array<Pick<SymbolInfo, 'ivIndex' | 'ivPercentile' | 'hv30' | 'hv60' | 'hv90'>>, weights: RankWeights): number[] {
  const percentile = percentRanks(infos.map((i) => i.ivPercentile));
  const overHv = percentRanks(
    infos.map((i) => {
      const blend = blendedVolatility(i);
      return i.ivIndex !== null && blend !== null ? i.ivIndex / blend : null;
    }),
  );
  const only: RankWeights = { ivPercentile: weights.ivPercentile, ivOverHv: weights.ivOverHv, returnOnRisk: 0, pop: 0, legSpread: 0, distance: 0 };
  return infos.map((_, i) =>
    weightedScore({ ivPercentile: percentile[i] ?? null, ivOverHv: overHv[i] ?? null, returnOnRisk: null, pop: null, legSpread: null, distance: null }, only),
  );
}

const worstLegSpread = (c: Candidate): number => {
  const pct = (q: { bid: number; ask: number }): number => ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 100;
  return Math.max(pct(c.spread.short), pct(c.spread.long));
};

export function components(c: Candidate, info: SymbolInfo): Components {
  const s = c.spread;
  const blend = blendedVolatility(info);
  // One standard deviation by the short option's own volatility, the one its delta was computed with;
  // the IV index only when the option has none. The page's ruler draws the same distance (web/model.js).
  const strikeIv = s.short.iv > 0 ? s.short.iv : info.ivIndex;
  const expectedMove = strikeIv === null ? null : info.spot * strikeIv * Math.sqrt(s.dte / 365);
  return {
    ivRank: info.ivRank,
    ivPercentile: info.ivPercentile,
    ivOverHv: info.ivIndex !== null && blend !== null ? info.ivIndex / blend : null,
    returnOnRisk: s.creditNatural / (s.width - s.creditNatural),
    pop: s.popPct,
    legSpread: worstLegSpread(c),
    distance: expectedMove === null || expectedMove === 0 ? 0 : Math.abs(info.spot - s.short.strike) / expectedMove,
  };
}

/** A weighted average of the ranks that exist. Weights of components with no data drop out. */
export function weightedScore(ranks: Ranks, weights: RankWeights): number {
  let sum = 0;
  let total = 0;
  for (const key of Object.keys(weights) as Array<keyof RankWeights>) {
    const rank = ranks[key];
    if (rank === null || weights[key] === 0) continue;
    sum += weights[key] * rank;
    total += weights[key];
  }
  return total === 0 ? 0.5 : sum / total;
}

/**
 * Scores every candidate and sorts best first. The underlying's own figures (IV percentile,
 * IV over realised volatility) are ranked across underlyings, not across spreads, so a name
 * with forty spreads does not count forty times. The spread's figures are ranked across spreads.
 * A first version of the weighting: the weights are a guess, which is why the inputs of every run
 * are kept, so the score can be checked against what the volatility did next.
 */
export function rankScan(result: ScanResult, weights: RankWeights): RankedScan {
  const raw = result.candidates.map((c) => components(c, result.symbols[c.symbol] as SymbolInfo));

  const symbols = [...new Set(result.candidates.map((c) => c.symbol))];
  const symbolComponents = new Map(symbols.map((s) => [s, raw[result.candidates.findIndex((c) => c.symbol === s)] as Components] as const));
  const underlyingRank = (key: 'ivPercentile' | 'ivOverHv'): Map<string, number | null> => {
    const ranks = percentRanks(symbols.map((s) => (symbolComponents.get(s) as Components)[key]));
    return new Map(symbols.map((s, i) => [s, ranks[i] as number | null] as const));
  };
  const ivPercentileRank = underlyingRank('ivPercentile');
  const ivOverHvRank = underlyingRank('ivOverHv');

  const returnOnRisk = percentRanks(raw.map((r) => r.returnOnRisk));
  const pop = percentRanks(raw.map((r) => r.pop));
  const legSpread = percentRanks(raw.map((r) => -r.legSpread)); // tighter is better
  const distance = percentRanks(raw.map((r) => r.distance));

  const ranked: RankedCandidate[] = result.candidates.map((c, i) => {
    const ranks: Ranks = {
      ivPercentile: ivPercentileRank.get(c.symbol) ?? null,
      ivOverHv: ivOverHvRank.get(c.symbol) ?? null,
      returnOnRisk: returnOnRisk[i] ?? null,
      pop: pop[i] ?? null,
      legSpread: legSpread[i] ?? null,
      distance: distance[i] ?? null,
    };
    return { ...c, components: raw[i] as Components, ranks, score: weightedScore(ranks, weights) };
  });
  ranked.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol) || a.spread.short.strike - b.spread.short.strike);
  return { ...result, weights, candidates: ranked };
}
