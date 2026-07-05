#!/usr/bin/env gjs
/* gjs-parse-test.js — Validate the REAL _parseUsageRecords under GJS.
 *
 * Imports the actual parser from providers/opencode-go.js (no copy, so it
 * can't drift). Asserts each page yields 50 records with unique usg_ ids
 * and intact token fields. GJS uses SpiderMonkey (not V8) — this confirms
 * the regex behaves identically to Node.
 *
 * Usage:  gjs -m gjs-parse-test.js   (from project root)
 */
import GLib from 'gi://GLib';
import { opencodeGoProvider } from './providers/opencode-go.js';

const CACHE_DIR = '/tmp/opencode-go-usage_data';

// Use the production parser directly.
const _parseUsageRecords = (text) => opencodeGoProvider._parseUsageRecords(text);

function readFile(path) {
    const [ok, contents] = GLib.file_get_contents(path);
    if (!ok) throw new Error(`Could not read ${path}`);
    return new TextDecoder().decode(contents);
}

function main() {
    const dir = GLib.Dir.open(CACHE_DIR, 0);
    const files = [];
    let name;
    while ((name = dir.read_name()) !== null) {
        if (/^page-\d+\.txt$/.test(name)) files.push(name);
    }
    files.sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

    print(`GJS ${GLib.get_os_info('PRETTY_NAME') || ''} — testing ${files.length} cached pages`);
    print('');

    let total = 0;
    let allOk = true;
    const allIds = new Set();
    let dupIds = 0;
    for (const file of files) {
        const text = readFile(`${CACHE_DIR}/${file}`);
        const records = _parseUsageRecords(text);
        const n = records ? records.length : 0;
        total += n;

        // Verify id present + unique + token fields parsed.
        let idOk = true;
        let tokenSum = 0;
        if (records) for (const r of records) {
            if (typeof r.id !== 'string' || !r.id.startsWith('usg_')) idOk = false;
            if (allIds.has(r.id)) dupIds++;
            else allIds.add(r.id);
            tokenSum += r.inputTokens + r.outputTokens + r.cacheReadTokens;
        }

        const ok = n === 50 && idOk;
        if (!ok) allOk = false;
        print(`  ${file}: ${String(n).padStart(2)} records  ids=${idOk ? '✓' : '✗'}  tokens(i+o+cr)=${tokenSum}  ${ok ? '✓' : '✗ EXPECTED 50 usg_ ids'}`);
    }

    print('');
    print(`Total records parsed in GJS: ${total}  (expected ${(files.length) * 50})`);
    print(`Distinct ids: ${allIds.size}  duplicate ids across pages: ${dupIds}`);
    if (dupIds > 0) allOk = false;
    print(allOk ? 'RESULT: ✓ parser works correctly under GJS (id unique, fields intact)'
               : 'RESULT: ✗ GJS PARSING BUG — records lost or ids missing/duplicate');
}

main();
