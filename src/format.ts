import type { RankedCandidate, RankedScan } from './types.ts';

const pad = (value: string | number, width: number, left = false): string => {
  const s = String(value);
  return left ? s.padEnd(width) : s.padStart(width);
};

const pct = (fraction: number | null): string => (fraction === null ? '-' : String(Math.round(fraction * 100)));

export function candidateLine(c: RankedCandidate, info: RankedScan['symbols'][string] | undefined): string {
  const s = c.spread;
  return [
    pad(c.symbol, 6, true),
    pad(s.side === 'put' ? 'P' : 'C', 1),
    pad(s.expiration.slice(5), 5),
    pad(s.dte, 3),
    pad(`${s.short.strike}/${s.long.strike}`, 11),
    pad(s.width, 3),
    pad(s.creditMid.toFixed(2), 6),
    pad(Math.round(s.maxRisk), 5),
    pad(s.profitPct.toFixed(0), 4),
    pad(s.popPct.toFixed(0), 4),
    pad(s.slippagePct.toFixed(0), 4),
    pad(pct(info?.ivPercentile ?? null), 4),
    pad(c.components.ivOverHv === null ? '-' : c.components.ivOverHv.toFixed(2), 5),
    pad(Math.round(c.score * 100), 5),
  ].join(' ');
}

export const HEADER = [
  pad('SYMBOL', 6, true), 'S', pad('EXP', 5), pad('DTE', 3), pad('SHORT/LONG', 11), pad('W', 3),
  pad('CREDIT', 6), pad('RISK$', 5), pad('ROR%', 4), pad('POP%', 4), pad('SLIP', 4), pad('IVPC', 4), pad('IV/HV', 5), pad('SCORE', 5),
].join(' ');

/** The best `perSymbol` candidates of each underlying, keeping the overall order. 0 keeps them all. */
export function topPerSymbol(candidates: RankedCandidate[], perSymbol: number): RankedCandidate[] {
  if (perSymbol <= 0) return candidates;
  const seen = new Map<string, number>();
  return candidates.filter((c) => {
    const n = (seen.get(c.symbol) ?? 0) + 1;
    seen.set(c.symbol, n);
    return n <= perSymbol;
  });
}

/** What a scan did, then its candidates, best score first. */
export function summarize(result: RankedScan, limit: number, perSymbol = 0): string {
  const lines: string[] = [];
  lines.push(`${result.universe} symbols on ${result.today}: ${Object.keys(result.symbols).length} produced ${result.candidates.length} candidate spreads`);
  for (const d of result.dropped) {
    const sample = d.symbols.slice(0, 6).join(', ');
    lines.push(`  dropped ${pad(d.symbols.length, 4)}  ${d.reason}${sample === '' ? '' : `  (${sample}${d.symbols.length > 6 ? ', ...' : ''})`}`);
  }
  const shown = topPerSymbol(result.candidates, perSymbol);
  if (shown.length > 0) {
    lines.push('', perSymbol > 0 ? `${HEADER}   (best ${perSymbol} per symbol)` : HEADER);
    for (const c of shown.slice(0, limit)) lines.push(candidateLine(c, result.symbols[c.symbol]));
    if (result.candidates.length > Math.min(limit, shown.length)) lines.push(`... ${result.candidates.length - Math.min(limit, shown.length)} more in the output file`);
  }
  return lines.join('\n');
}
