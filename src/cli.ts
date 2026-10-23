import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FileCache, noCache } from './cache.ts';
import { loadConfig } from './config.ts';
import { DEFAULT_CREDENTIALS_PATH, loadCredentials } from './credentials.ts';
import { summarize } from './format.ts';
import { Http } from './http.ts';
import { Fmp } from './providers/fmp.ts';
import { Tastytrade } from './providers/tastytrade.ts';
import { rankScan } from './rank.ts';
import { scan } from './scan.ts';
import { addDays, easternDate } from './dates.ts';
import { formatValidation, validationReport } from './validate.ts';
import type { DailyBar } from './providers/fmp.ts';
import type { RankedScan } from './types.ts';
import { readdirSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage:
  node src/cli.ts scan (--symbols A,B,C | --symbols-file FILE) [options]
  node src/cli.ts validate [--runs DIR] [--min-age-days N]
    Checks the saved runs that are old enough against what the market did next.

  --symbols LIST        comma-separated underlyings
  --symbols-file FILE   one symbol per line (blank lines and # comments are skipped)
  --config FILE         settings that override config/default.json (default: config/local.json when present)
  --credentials FILE    KEY=value lines (default: ${DEFAULT_CREDENTIALS_PATH})
  --out DIR             where the result file goes (default: runs)
  --limit N             candidates to print (default: 40)
  --per-symbol N        at most N printed per underlying, 0 for all (default: 3); the file keeps every candidate
  --no-cache            do not read or write .cache/
`;

export function readSymbols(list: string | undefined, file: string | undefined): string[] {
  const out: string[] = [];
  if (list !== undefined) out.push(...list.split(','));
  if (file !== undefined) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const text = line.replace(/#.*/, '').trim();
      if (text !== '') out.push(...text.split(/[\s,]+/));
    }
  }
  return out.map((s) => s.trim().toUpperCase()).filter((s) => s !== '');
}

/** Write through a temporary file and a rename, so a reader never sees half a result. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

async function validate(values: { runs?: string; credentials?: string; 'min-age-days'?: string }): Promise<number> {
  const dir = values.runs ?? join(root, 'runs');
  const today = easternDate(new Date());
  const minAge = Number(values['min-age-days'] ?? 21);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('-scan.json')).sort() : [];
  const runs = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as RankedScan).filter((r) => r.today <= addDays(today, -minAge));
  if (runs.length === 0) {
    process.stdout.write(`No saved run is ${minAge} days old yet (${files.length} saved in ${dir}). Keep scanning; this needs weeks of history.\n`);
    return 0;
  }
  const credentials = loadCredentials(values.credentials);
  const fmp = new Fmp(credentials.fmp.apiKey, new Http({ userAgent: 'spread-scanner/0.1', minIntervalMs: 250 }));
  const cache = new FileCache(join(root, '.cache'));
  const first = runs.map((r) => r.today).sort()[0] as string;
  const symbols = [...new Set(runs.flatMap((r) => Object.keys(r.symbols)))];
  const bars = new Map<string, DailyBar[]>();
  for (const symbol of symbols) {
    bars.set(symbol, await cache.getOrFetch(`fmp-bars-${symbol}-${first}-${today}`, 12 * 3_600_000, () => fmp.dailyBars(symbol, addDays(first, -5), today)));
  }
  process.stdout.write(`${formatValidation(validationReport(runs, bars, today))}\n`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      symbols: { type: 'string' },
      'symbols-file': { type: 'string' },
      config: { type: 'string' },
      credentials: { type: 'string' },
      out: { type: 'string' },
      limit: { type: 'string' },
      'per-symbol': { type: 'string' },
      runs: { type: 'string' },
      'min-age-days': { type: 'string' },
      'no-cache': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help === true || (positionals[0] !== 'scan' && positionals[0] !== 'validate')) {
    process.stderr.write(USAGE);
    return values.help === true ? 0 : 2;
  }
  if (positionals[0] === 'validate') return validate(values);
  const symbols = readSymbols(values.symbols, values['symbols-file']);
  if (symbols.length === 0) {
    process.stderr.write(`No symbols given.\n\n${USAGE}`);
    return 2;
  }

  const localPath = values.config ?? join(root, 'config', 'local.json');
  if (values.config !== undefined && !existsSync(values.config)) throw new Error(`Config file not found: ${values.config}`);
  const cfg = loadConfig(join(root, 'config', 'default.json'), localPath);
  const credentials = loadCredentials(values.credentials);

  const tt = new Tastytrade(credentials.tastytrade, new Http({ userAgent: 'spread-scanner/0.1', minIntervalMs: 300 }));
  const fmp = new Fmp(credentials.fmp.apiKey, new Http({ userAgent: 'spread-scanner/0.1', minIntervalMs: 250 }));
  const cache = values['no-cache'] === true ? noCache : new FileCache(join(root, '.cache'));

  const started = Date.now();
  const scanned = await scan(symbols, cfg, { tt, fmp, cache, log: (message) => process.stderr.write(`${message}\n`) });

  const result = rankScan(scanned, cfg.ranking.weights);
  const stamp = result.generatedAt.replace(/[:.]/g, '-').slice(0, 19);
  const file = join(values.out ?? join(root, 'runs'), `${stamp}-scan.json`);
  writeAtomic(file, JSON.stringify(result));
  process.stdout.write(`${summarize(result, Number(values.limit ?? 40), Number(values['per-symbol'] ?? 3))}\n\nWrote ${file} (${((Date.now() - started) / 1000).toFixed(1)} s)\n`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
