#!/usr/bin/env gjs
/* gjs-flow-test.js — Exercise the REAL opencode-go provider in GJS.
 *
 * Imports providers/opencode-go.js directly and runs phase-1 (_buildCostDistribution)
 * + phase-2 (_continueCostFetch) against the cached getUsageInfo pages, mocking
 * only the HTTP layer (_postGetUsageInfo). Validates:
 *   1. cold cache → full dataset (300), onCostDistUpdate fires
 *   2. truncated cache (50) → self-heals to full dataset (the "stops at 50" bug)
 *   3. full cache + no new calls → phase 2 cheap (caught up after 1 page)
 *   4. cost + token distribution built correctly (id present, models listed)
 *
 * Run from project root:  gjs -m gjs-flow-test.js
 */
import GLib from 'gi://GLib';
import { opencodeGoProvider as P } from './providers/opencode-go.js';

const CACHE_DIR = '/tmp/opencode-go-usage_data';
const WS = 'wrk_test';
const COOKIE = 'cookie';
const SERVER_ID = 'serverid';

// ── Load + cache raw page text ──
const rawPages = {};
{
    const dir = GLib.Dir.open(CACHE_DIR, 0);
    let name;
    while ((name = dir.read_name()) !== null) {
        const m = name.match(/^page-(\d+)\.txt$/);
        if (!m) continue;
        const [ok, contents] = GLib.file_get_contents(`${CACHE_DIR}/${name}`);
        rawPages[parseInt(m[1])] = new TextDecoder().decode(contents);
    }
}
const maxPage = Math.max(...Object.keys(rawPages).map(Number));
const TOTAL = (maxPage + 1) * 50;

// ── Mock the HTTP layer: page N → parsed cached page, or null beyond cache ──
let httpCalls = 0;
P._postGetUsageInfo = function (_session, _ws, _cookie, _sid, page) {
    httpCalls++;
    const text = rawPages[page];
    if (!text) return Promise.resolve(null);
    return Promise.resolve(this._parseUsageRecords(text));
};

let updateCount = 0;
const callbacks = () => ({ onCostDistUpdate: () => { updateCount++; } });

function reset() {
    httpCalls = 0;
    updateCount = 0;
    P.__ws = {};   // clear per-workspace state
}

const ws = () => P._wsState(WS);

// Mirror what fetch() will do: phase 1 → wire token-mix entry → phase 2.
async function runFlow(costDistMinInterval = 0) {
    const dist = await P._buildCostDistribution(null, WS, COOKIE, SERVER_ID);
    if (dist) ws()._tokenMixEntry = P._buildTokenBreakdown(ws()._costDistCache.records);
    await P._continueCostFetch(null, WS, COOKIE, SERVER_ID, callbacks(), costDistMinInterval);
    return dist;
}

function result(ok, msg) {
    print(`  ${ok ? '✓ PASS' : '✗ FAIL'} — ${msg}`);
    return ok;
}

let allOk = true;

async function main() {
    print(`GJS flow test — cached pages 0..${maxPage} (${TOTAL} records)\n`);

    // ── TEST 1: cold cache ──
    print('══ TEST 1: cold cache (first-ever fetch) ══');
    reset();
    await runFlow(0);
    const n1 = ws()._costDistCache.records.length;
    print(`  records after phase 1+2: ${n1}  (HTTP calls: ${httpCalls})`);
    print(`  onCostDistUpdate fired: ${updateCount} time(s)`);
    allOk &= result(n1 === TOTAL && updateCount >= 1,
        `${n1}/${TOTAL} records, ${updateCount} updates`);
    print('');

    // ── TEST 2: truncated cache (50) — self-heal ──
    print('══ TEST 2: truncated cache (50) — must self-heal past 50 ══');
    reset();
    ws()._costDistCache = { records: P._parseUsageRecords(rawPages[0]).slice() }; // only page 0
    await runFlow(0);
    const n2 = ws()._costDistCache.records.length;
    print(`  records: ${n2}  (started at 50)`);
    allOk &= result(n2 === TOTAL, `self-healed ${n2}/${TOTAL}`);
    print('');

    // ── TEST 3: full cache, no new calls — cheap refresh ──
    print('══ TEST 3: full cache, no new calls — phase 2 should be cheap ══');
    reset();
    const full = [];
    for (let pg = 0; pg <= maxPage; pg++) full.push(...P._parseUsageRecords(rawPages[pg]));
    ws()._costDistCache = { records: full };
    await runFlow(0);
    const phase2Calls = httpCalls - 1;   // phase 1 = 1 call (page 0)
    print(`  phase-2 HTTP calls: ${phase2Calls}  (page 1 fully known → caught up)`);
    allOk &= result(phase2Calls === 1, `${phase2Calls} call(s)`);
    print('');

    // ── TEST 4: id present + distribution ──
    print('══ TEST 4: record shape + cost/token distribution ══');
    reset();
    await runFlow(0);
    const recs = ws()._costDistCache.records;
    const hasId = recs.every(r => typeof r.id === 'string' && r.id.startsWith('usg_'));
    const distEntry = ws()._costDistEntry;
    const tmEntry = ws()._tokenMixEntry;
    print(`  every record has usg_ id: ${hasId}`);
    print(`  cost-dist: "${distEntry?.label}", ${distEntry?.segments?.length} model segment(s), total=${distEntry?.totalCost}`);
    if (distEntry?.segments) for (const s of distEntry.segments)
        print(`    ${s.model}: ${s.value} ($${(s.value / 1e8).toFixed(4)})`);
    print(`  token-mix: "${tmEntry?.label}", ${tmEntry?.segments?.length} type(s), total=${tmEntry?.totalCost}`);
    allOk &= result(hasId && distEntry?.segments?.length >= 1 && tmEntry?.segments?.length >= 1,
        `id=${hasId}, models=${distEntry?.segments?.length}, token-types=${tmEntry?.segments?.length}`);
    print('');

    // ── TEST 5: costDistMinInterval throttle ──
    print('══ TEST 5: phase 2 throttled when fetched recently ══');
    reset();
    await runFlow(0);                 // first run: phase 2 executes, sets lastFullMs
    const callsAfterFirst = httpCalls;
    updateCount = 0;
    await runFlow(3600);              // within 1h window → phase 2 must skip
    const secondRunCalls = httpCalls - callsAfterFirst;
    const phase2CallsT5 = secondRunCalls - 1;   // phase 1 always makes 1 call (page 0)
    print(`  second-run phase-2 calls: ${phase2CallsT5} (expected 0: throttled)`);
    allOk &= result(phase2CallsT5 === 0, `throttled (${phase2CallsT5} calls)`);
    print('');

    print(allOk ? '══ ALL TESTS PASSED ══' : '══ SOME TESTS FAILED ══');
}

main();
