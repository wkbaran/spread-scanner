import { existsSync, readFileSync } from 'node:fs';
import type { HeldSpread, Holdings } from './types.ts';

/**
 * The spreads open in spread-book, from its brief (`latest.json`, schema `spread-book/brief@1`), so the report
 * can mark the ones you hold. Only plain put and call spreads with two numeric strikes are kept: those are the
 * only ones a candidate can be. spread-book names a spread the way OptionStrat does ("775/770"), strikes in
 * either order, and gives the short strike itself; the long strike is the other one.
 */
export function readHoldings(brief: unknown): Holdings | null {
  if (typeof brief !== 'object' || brief === null) return null;
  const b = brief as { schema?: unknown; generatedAt?: unknown; positions?: unknown };
  if (b.schema !== 'spread-book/brief@1' || !Array.isArray(b.positions)) return null;
  const spreads: HeldSpread[] = [];
  for (const p of b.positions as Record<string, unknown>[]) {
    if (p.kind !== 'put' && p.kind !== 'call') continue;
    if (typeof p.underlying !== 'string' || typeof p.expiration !== 'string' || typeof p.strikes !== 'string') continue;
    const legs = p.strikes.split('/').map(Number);
    const short = p.shortStrike;
    if (legs.length !== 2 || !legs.every(Number.isFinite) || typeof short !== 'number' || !legs.includes(short)) continue;
    const long = legs[0] === short ? (legs[1] as number) : (legs[0] as number);
    if (long === short) continue;
    spreads.push({
      symbol: p.underlying,
      side: p.kind,
      expiration: p.expiration,
      shortStrike: short,
      longStrike: long,
      name: typeof p.name === 'string' ? p.name : `${p.underlying} ${p.strikes}`,
      // spread-book's spreadKey (book.js): its report selects the spread named by ?spread=<this>.
      key: [p.name, p.expiration, p.strikes].join('|'),
      returnPct: typeof p.returnPct === 'number' ? p.returnPct : null,
      exit: p.exit === 'close' || p.exit === 'stop' ? p.exit : null,
    });
  }
  return { asOf: typeof b.generatedAt === 'string' ? b.generatedAt : null, spreads };
}

/** The brief at `file`, or null with the reason logged. Never throws: a report without holdings is still a report. */
export function loadHoldings(file: string | undefined, log: (message: string) => void): Holdings | null {
  if (file === undefined || file === '') return null;
  if (!existsSync(file)) {
    log(`No spread-book brief at ${file}: the report marks no held spreads.`);
    return null;
  }
  try {
    const holdings = readHoldings(JSON.parse(readFileSync(file, 'utf8')));
    if (holdings === null) log(`${file} is not a spread-book brief: the report marks no held spreads.`);
    return holdings;
  } catch (error) {
    log(`Could not read ${file} (${error instanceof Error ? error.message : String(error)}): the report marks no held spreads.`);
    return null;
  }
}
