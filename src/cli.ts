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
import { scan } from './scan.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: node src/cli.ts scan (--symbols A,B,C | --symbols-file FILE) [options]

  --symbols LIST        comma-separated underlyings
  --symbols-file FILE   one symbol per line (blank lines and # comments are skipped)
  --config FILE         settings that override config/default.json (default: config/local.json when present)
  --credentials FILE    KEY=value lines (default: ${DEFAULT_CREDENTIALS_PATH})
  --out DIR             where the result file goes (default: runs)
  --limit N             candidates to print (default: 40)
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
      'no-cache': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help === true || positionals[0] !== 'scan') {
    process.stderr.write(USAGE);
    return values.help === true ? 0 : 2;
  }
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

  const result = await scan(symbols, cfg, { tt, fmp, cache, log: (message) => process.stderr.write(`${message}\n`) });

  const stamp = result.generatedAt.replace(/[:.]/g, '-').slice(0, 19);
  const file = join(values.out ?? join(root, 'runs'), `${stamp}-scan.json`);
  writeAtomic(file, JSON.stringify(result));
  process.stdout.write(`${summarize(result, Number(values.limit ?? 40))}\n\nWrote ${file}\n`);
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
