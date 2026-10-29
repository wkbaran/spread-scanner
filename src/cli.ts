import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { FileCache, noCache } from './cache.ts';
import { loadConfig } from './config.ts';
import { DEFAULT_CREDENTIALS_PATH, loadCredentials } from './credentials.ts';
import { summarize } from './format.ts';
import { loadHoldings } from './held.ts';
import { Http } from './http.ts';
import { NyFed } from './providers/nyfed.ts';
import { resolveRate } from './rate.ts';
import { Fmp } from './providers/fmp.ts';
import { Tastytrade } from './providers/tastytrade.ts';
import { rankScan } from './rank.ts';
import { REPORT_ASSETS, renderReport } from './report.ts';
import { publishDirectory, s3Settings } from './s3.ts';
import { scan } from './scan.ts';
import { addDays, easternDate } from './dates.ts';
import { formatValidation, validationReport } from './validate.ts';
import type { DailyBar } from './providers/fmp.ts';
import type { RankedScan } from './types.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Where runs/, report/, .cache/ and config/local.json live. The repository by default; the container
 * sets SPREAD_SCANNER_STATE_DIR to its volume so the code and the data can be replaced separately.
 */
const stateDir = resolve(process.env.SPREAD_SCANNER_STATE_DIR ?? root);

const USAGE = `Usage:
  node src/cli.ts scan [--symbols A,B,C | --symbols-file FILE] [options]
    With no symbols it starts from every optionable stock and fund and narrows by liquidity,
    the earnings rule and how rich IV is (config "universe"). With symbols it scans exactly those.
  node src/cli.ts report [--run FILE] [--out DIR] [--held FILE]
    Builds the browser report from a saved scan (default: the latest in runs/) into report/.
    --held is spread-book's latest.json (default: SPREAD_BOOK_BRIEF), whose open spreads the page marks.
  node src/cli.ts validate [--runs DIR] [--min-age-days N]
    Checks the saved runs that are old enough against what the market did next.
  node src/cli.ts publish [--dir DIR]
    Uploads the built report (default: report/) to the S3 bucket named by S3_BUCKET.

  --symbols LIST        comma-separated underlyings
  --symbols-file FILE   one symbol per line (blank lines and # comments are skipped)
  --config FILE         settings that override config/default.json (default: config/local.json when present)
  --credentials FILE    KEY=value lines (default: ${DEFAULT_CREDENTIALS_PATH})
  --out DIR             where the result file goes (default: runs)
  --limit N             candidates to print (default: 40)
  --per-symbol N        at most N printed per underlying, 0 for all (default: 3); the file keeps every candidate
  --no-cache            do not read or write .cache/

runs/, report/, .cache/ and config/local.json are read from SPREAD_SCANNER_STATE_DIR when it is set.
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

/** The newest saved scan in `dir`, or null. File names start with the time, so the last sorts newest. */
export function latestRun(dir: string): string | null {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('-scan.json')).sort() : [];
  const last = files.at(-1);
  return last === undefined ? null : join(dir, last);
}

function report(values: { run?: string; out?: string; held?: string }): number {
  const file = values.run ?? latestRun(join(stateDir, 'runs'));
  if (file === null || !existsSync(file)) {
    process.stderr.write('No saved scan to report on. Run a scan first, or pass --run FILE.\n');
    return 1;
  }
  const scanned = JSON.parse(readFileSync(file, 'utf8')) as RankedScan;
  const out = resolve(values.out ?? join(stateDir, 'report'));
  const web = join(root, 'web');
  // Read now, not at scan time, so the page carries the newest positions spread-book has pulled.
  const held = loadHoldings(values.held ?? process.env.SPREAD_BOOK_BRIEF, (m) => void process.stderr.write(`${m}\n`));
  if (held !== null) process.stdout.write(`${held.spreads.length} spreads held in spread-book (as of ${held.asOf ?? 'unknown'})\n`);
  writeAtomic(join(out, 'index.html'), renderReport(readFileSync(join(web, 'index.html'), 'utf8'), { ...scanned, held }));
  for (const asset of REPORT_ASSETS) copyFileSync(join(web, asset), join(out, asset));
  process.stdout.write(`Wrote ${join(out, 'index.html')}\nOpen ${pathToFileURL(join(out, 'index.html')).href}\n`);
  return 0;
}

async function publish(values: { dir?: string }): Promise<number> {
  const dir = resolve(values.dir ?? join(stateDir, 'report'));
  if (!existsSync(join(dir, 'index.html'))) {
    process.stderr.write(`Nothing to publish: ${join(dir, 'index.html')} does not exist. Run report first.\n`);
    return 1;
  }
  const settings = s3Settings(process.env);
  const keys = await publishDirectory(dir, settings);
  process.stdout.write(`Published ${keys.length} files to s3://${settings.bucket}\n`);
  return 0;
}

async function validate(values: { runs?: string; credentials?: string; 'min-age-days'?: string }): Promise<number> {
  const dir = values.runs ?? join(stateDir, 'runs');
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
  const cache = new FileCache(join(stateDir, '.cache'));
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
      run: { type: 'string' },
      held: { type: 'string' },
      dir: { type: 'string' },
      'min-age-days': { type: 'string' },
      'no-cache': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help === true || !['scan', 'validate', 'report', 'publish'].includes(positionals[0] ?? '')) {
    process.stderr.write(USAGE);
    return values.help === true ? 0 : 2;
  }
  if (positionals[0] === 'validate') return validate(values);
  if (positionals[0] === 'report') return report(values);
  if (positionals[0] === 'publish') return publish(values);
  const explicit = values.symbols !== undefined || values['symbols-file'] !== undefined;
  const given = readSymbols(values.symbols, values['symbols-file']);
  if (explicit && given.length === 0) {
    process.stderr.write(`No symbols in the list given.\n\n${USAGE}`);
    return 2;
  }

  const localPath = values.config ?? join(stateDir, 'config', 'local.json');
  if (values.config !== undefined && !existsSync(values.config)) throw new Error(`Config file not found: ${values.config}`);
  const cfg = loadConfig(join(root, 'config', 'default.json'), localPath);
  const credentials = loadCredentials(values.credentials);

  const tt = new Tastytrade(credentials.tastytrade, new Http({ userAgent: 'spread-scanner/0.1', minIntervalMs: 300 }));
  const fmp = new Fmp(credentials.fmp.apiKey, new Http({ userAgent: 'spread-scanner/0.1', minIntervalMs: 250 }));
  const cache = values['no-cache'] === true ? noCache : new FileCache(join(stateDir, '.cache'));

  const started = Date.now();
  const log = (message: string): void => void process.stderr.write(`${message}\n`);
  // No list given: start from every optionable name and let the funnel narrow it (config `universe`).
  const symbols = explicit ? given : await cache.getOrFetch('optionable-equities', 12 * 3_600_000, () => tt.optionableEquities());
  if (!explicit) log(`${symbols.length} optionable stocks and funds`);
  // The strike band wants a risk-free rate; take SOFR so it follows the market, and record what was used.
  const rate = await resolveRate(cfg, () => new NyFed(new Http({ userAgent: 'spread-scanner/0.1', minIntervalMs: 0 })).sofr(), cache, log);
  log(`rate ${(rate.value * 100).toFixed(2)}% (${rate.source})`);
  const withRate = { ...cfg, strikeSelection: { ...cfg.strikeSelection, rate: rate.value } };
  const scanned = await scan(symbols, withRate, { tt, fmp, cache, log, funnel: !explicit, rateSource: rate.source });

  const result = rankScan(scanned, cfg.ranking.weights);
  const stamp = result.generatedAt.replace(/[:.]/g, '-').slice(0, 19);
  const file = join(values.out ?? join(stateDir, 'runs'), `${stamp}-scan.json`);
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
