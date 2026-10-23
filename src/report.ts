import type { RankedScan } from './types.ts';

export const DATA_MARKER = '<!--SCAN-DATA-->';

/** The files the report page loads next to index.html. */
export const REPORT_ASSETS = ['model.js', 'app.js', 'palette.js'];

/**
 * JSON that is safe inside a <script> element: a `<` could close the tag early (`</script>`) or
 * open a comment, and U+2028 and U+2029 end a line in older JavaScript. Escaping them as \u
 * sequences leaves the JSON's meaning unchanged.
 */
const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), 'g');
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), 'g');

export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(LINE_SEPARATOR, '\\u2028').replace(PARAGRAPH_SEPARATOR, '\\u2029');
}

/** index.html with the scan inlined, so the page opens straight from disk with no server. */
export function renderReport(template: string, scan: RankedScan): string {
  if (!template.includes(DATA_MARKER)) throw new Error(`The page template has no ${DATA_MARKER} placeholder`);
  return template.replace(DATA_MARKER, () => `<script id="scan-data" type="application/json">${jsonForScript(scan)}</script>`);
}
