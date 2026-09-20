#!/usr/bin/env gjs
/* gjs-flow-test.js — Exercise the REAL opencode-go provider in GJS.
 *
 * Mocks only the HTTP layer (_getCsv) with a canned Usage API export, then
 * runs the full fetch() → entry builders pipeline. Validates:
 *   1. entries built from one CSV (total, cost-dist, token-mix, stacked, recent)
 *   2. legacy cookie-only accounts get the migration error
 *   3. missing key → attempted=false
 *   4. HTTP 401 maps to the key error, header-only CSV → zero total
 *
 * Run from project root:  gjs -m gjs-flow-test.js
 */
import { opencodeGoProvider as P } from './providers/opencode-go.js';

const HEADER = 'id,user_email,service_account_name,app,provider,model,' +
    'input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,' +
    'cache_write_5m_tokens,cache_write_1h_tokens,reasoning_mode,' +
    'reasoning_effort,reasoning_budget_tokens,reasoning_source,' +
    'billing_source,cost_micro_cents,created_at,service,quantity';

function row(id, model, cost, date, input = 100, output = 50) {
    return `${id},a@x.com,,,anthropic,${model},${input},${output},0,10,0,0,effort,,,"api",managed-inference,${cost},${date}T10:00:00Z,,1`;
}

const CSV = HEADER + '\n' +
    row('1', 'claude-sonnet-4-5', 300000000, '2026-09-01') + '\n' +
    row('2', 'claude-sonnet-4-5', 100000000, '2026-09-02') + '\n' +
    row('3', 'gpt-5', 200000000, '2026-09-02') + '\n';

// ── Mock the HTTP layer ──
let nextResponse = { status: 200, body: CSV };
P._getCsv = function () { return Promise.resolve(nextResponse); };

function result(ok, msg) {
    print(`  ${ok ? '✓ PASS' : '✗ FAIL'} — ${msg}`);
    return !!ok;
}

let allOk = true;
const kinds = (res) => (res.entries || []).map(e => e.kind).join(',');

async function main() {
    // ── TEST 1: full pipeline ──
    print('══ TEST 1: fetch builds all entries ══');
    nextResponse = { status: 200, body: CSV };
    {
        const res = await P.fetch(null, { apiKey: 'oc_sk_test' });
        print(`  attempted=${res.attempted} kinds=[${kinds(res)}]`);
        allOk &= result(res.attempted === true && (res.errors || []).length === 0,
            'attempted, no errors');
        const dist = res.entries.find(e => e.name === 'OpenCode Go Cost Dist');
        const mix = res.entries.find(e => e.name === 'OpenCode Go Token Mix');
        const stacked = res.entries.find(e => e.kind === 'stackedbarchart');
        const recent = res.entries.find(e => e.kind === 'barchart');
        const total = res.entries.find(e => e.kind === 'value');
        allOk &= result(dist?.segments?.length === 2 && dist.totalCost === 600000000,
            `cost-dist: 2 models, total 600000000 (got ${dist?.totalCost})`);
        allOk &= result(dist.segments[0].model === 'claude-sonnet-4-5',
            `top model first ("${dist?.segments?.[0]?.model}")`);
        allOk &= result(mix?.segments?.length >= 3, `token-mix types (${mix?.segments?.length})`);
        allOk &= result(stacked?.buckets?.length === 2, `stacked days (${stacked?.buckets?.length})`);
        allOk &= result(recent?.bars?.length === 3, `recent bars (${recent?.bars?.length})`);
        allOk &= result(typeof total?.value === 'string' && total.value.includes('$6.00'),
            `total value ("${total?.value}")`);
    }
    print('');

    // ── TEST 2: legacy cookie account → migration error ──
    print('══ TEST 2: legacy credentials get migration guidance ══');
    {
        const res = await P.fetch(null, { workspaceId: 'wrk_x', authCookie: 'abc' });
        allOk &= result(res.attempted === true && /service API key/i.test(res.errors?.[0] || ''),
            `migration error ("${(res.errors?.[0] || '').slice(0, 60)}…")`);
    }
    print('');

    // ── TEST 3: no credentials → not attempted ──
    print('══ TEST 3: empty credentials ══');
    {
        const res = await P.fetch(null, {});
        allOk &= result(res.attempted === false, 'attempted=false');
    }
    print('');

    // ── TEST 4: 401 + header-only ──
    print('══ TEST 4: HTTP status mapping + empty export ══');
    {
        nextResponse = { status: 401, body: '{"error":"unauthorized"}' };
        const unauth = await P.fetch(null, { apiKey: 'oc_sk_bad' });
        allOk &= result(/API key/i.test(unauth.errors?.[0] || ''),
            `401 → key error ("${(unauth.errors?.[0] || '').slice(0, 60)}…")`);

        nextResponse = { status: 200, body: HEADER + '\n' };
        const empty = await P.fetch(null, { apiKey: 'oc_sk_test' });
        allOk &= result(empty.entries?.length === 1 && empty.entries[0].kind === 'value',
            'header-only CSV → single zero total, no error');
    }
    print('');

    // ── TEST 5: `go`-plan export (all cost_micro_cents=0) → token fallback ──
    print('══ TEST 5: zero-charge export falls back to tokens ══');
    const zeroCsv = HEADER + '\n' +
        row('1', 'claude-sonnet-4-5', 0, '2026-09-01', 1000, 200) + '\n' +
        row('2', 'gpt-5', 0, '2026-09-02', 500, 100) + '\n';
    nextResponse = { status: 200, body: zeroCsv };
    const zres = await P.fetch(null, { apiKey: 'oc_sk_test' });
    const zdist = zres.entries.find(e => e.name === 'OpenCode Go Cost Dist');
    const zrecent = zres.entries.find(e => e.kind === 'barchart');
    const zstacked = zres.entries.find(e => e.kind === 'stackedbarchart');
    const ztotal = zres.entries.find(e => e.kind === 'value');
    print(`  kinds=[${(zres.entries || []).map(e => e.kind).join(',')}]`);
    allOk &= result(zres.entries.length === 5, `all 5 entries present (got ${zres.entries.length})`);
    allOk &= result(zdist?.unit === 'tokens' && zdist.totalCost === 1820,
        `model share by tokens, total 1820 (got ${zdist?.totalCost} ${zdist?.unit})`);
    allOk &= result(zrecent?.unit === 'tokens' && zrecent.bars.length === 2,
        `recent by tokens (${zrecent?.bars?.length} bars)`);
    allOk &= result(zstacked?.unit === 'tokens' && zstacked.buckets.length === 2,
        `stacked by tokens (${zstacked?.buckets?.length} days)`);
    allOk &= result(/no per-request charge/.test(ztotal?.value || ''),
        `total explains billing ("${ztotal?.value}")`);
    print('');

    print(allOk ? '══ ALL TESTS PASSED ══' : '══ SOME TESTS FAILED ══');
}

main();
