#!/usr/bin/env gjs
/* gjs-flow-test.js — Exercise the REAL opencode-go provider in GJS.
 *
 * Mocks only the HTTP layer (_getJson / _getCsv) with canned Usage API
 * responses, then runs the full fetch() pipeline. Validates:
 *   1. JSON path: real-cost entries (total, model cost-dist, token mix,
 *      daily cost bars, recent-calls chart with cursor pagination)
 *   2. legacy cookie-only accounts get the migration error
 *   3. missing key → attempted=false
 *   4. rows failure → recent chart skipped, rest intact; JSON 401 with
 *      header-only CSV fallback → single zero total
 *   5. JSON down + zero-charge CSV → token-based fallback entries
 *
 * Run from project root:  gjs -m gjs-flow-test.js
 */
import { opencodeGoProvider as P } from './providers/opencode-go.js';

// ── Mock HTTP layer: route by URL substring ──
let jsonRoutes = [];   // [[substring, data|Error], ...] first match wins
let csvResponse = null;
P._getJson = function (_session, url, _key, _what) {
    for (const [sub, val] of jsonRoutes) {
        if (url.includes(sub)) {
            if (val instanceof Error) return Promise.reject(val);
            return Promise.resolve(val);
        }
    }
    return Promise.reject(new Error(`unmocked URL: ${url}`));
};
P._getCsv = function () { return Promise.resolve(csvResponse); };

// ── Canned JSON payloads (values are strings, like the real API) ──
const SUMMARY = {
    totalRequests: '125',
    totalInputTokens: '1000000',
    totalOutputTokens: '200000',
    totalCacheReadTokens: '5000000',
    totalCacheWrite5mTokens: '1000',
    totalCacheWrite1hTokens: '0',
    totalCostMicroCents: '3989000000',
};
const MODELS = { items: [
    { model: 'model-a', provider: 'opencode-go', totalRequests: '100',
      totalCostMicroCents: '3000000000' },
    { model: 'model-b', provider: 'opencode-go', totalRequests: '25',
      totalCostMicroCents: '989000000' },
]};
const BYDAY = [
    { date: '2026-09-01', totalCostMicroCents: '2000000000', totalTokens: '3000000', totalRequests: '60' },
    { date: '2026-09-02', totalCostMicroCents: '1989000000', totalTokens: '3201000', totalRequests: '65' },
];
const GOSTATUS = { access: { meters: {
    fiveHour: { limitMicroCents: '1200000000', usedMicroCents: '600000000',
        resetsAt: '2026-09-20T15:52:28.000Z' },
    week: { limitMicroCents: '3000000000', usedMicroCents: '2768353382',
        resetsAt: '2026-09-21T00:00:00.000Z' },
    month: { limitMicroCents: '6000000000', usedMicroCents: '5851761679' },
}}};
const rowItem = (id, model, cost, date) => ({
    id, model, costMicroCents: String(cost), createdAt: `${date}T10:00:00.000Z`,
    inputTokens: 100, outputTokens: 50,
});
const ROWS_P1 = { items: Array.from({ length: 10 }, (_, i) =>
    rowItem(100 + i, i % 2 ? 'model-b' : 'model-a', 1000 * (i + 1), '2026-09-02')),
    nextCursor: 'cursor-1' };
const ROWS_P2 = { items: Array.from({ length: 5 }, (_, i) =>
    rowItem(200 + i, 'model-a', 500 * (i + 1), '2026-09-01')),
    nextCursor: null };

function jsonOk() {
    // NOTE: cursor route first — page-2 URL also contains '/rows?range='.
    jsonRoutes = [
        ['cursor=', ROWS_P2],
        ['/rows', ROWS_P1],
        ['/summary', SUMMARY],
        ['/models', MODELS],
        ['/cost-by-day', BYDAY],
        ['/go/status', GOSTATUS],
    ];
}

// ── Canned CSV payloads (fallback path) ──
const HEADER = 'id,user_email,service_account_name,app,provider,model,' +
    'input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,' +
    'cache_write_5m_tokens,cache_write_1h_tokens,reasoning_mode,' +
    'reasoning_effort,reasoning_budget_tokens,reasoning_source,' +
    'billing_source,cost_micro_cents,created_at,service,quantity';
const csvRow = (id, model, cost, date, input = 100, output = 50) =>
    `${id},a@x.com,,,anthropic,${model},${input},${output},0,10,0,0,effort,,,"api",managed-inference,${cost},${date}T10:00:00Z,,1`;

function result(ok, msg) {
    print(`  ${ok ? '✓ PASS' : '✗ FAIL'} — ${msg}`);
    return !!ok;
}

let allOk = true;
const kinds = (res) => (res.entries || []).map(e => e.kind).join(',');

async function main() {
    // ── TEST 1: JSON path, real costs ──
    print('══ TEST 1: JSON usage endpoints → cost entries ══');
    jsonOk();
    {
        const res = await P.fetch(null, { apiKey: 'oc_sk_test' });
        print(`  attempted=${res.attempted} kinds=[${kinds(res)}] errors=${JSON.stringify(res.errors)}`);
        allOk &= result(res.attempted === true && (res.errors || []).length === 0,
            'attempted, no errors');
        const total = res.entries.find(e => e.kind === 'value');
        const quotas = res.entries.filter(e => e.kind === 'percent');
        const dist = res.entries.find(e => e.name === 'OpenCode Go Cost Dist');
        const mix = res.entries.find(e => e.name === 'OpenCode Go Token Mix');
        const daily = res.entries.find(e => e.name === 'OpenCode Go Daily');
        const recent = res.entries.find(e => e.name === 'OpenCode Go Recent');
        allOk &= result(total?.value === '$39.89 (125 calls)',
            `total value ("${total?.value}")`);
        allOk &= result(quotas.length === 3 &&
            quotas[0].label === '5h:' && Math.abs(quotas[0].percentUsed - 50) < 1e-9 &&
            quotas[0].resetTimeIso === '2026-09-20T15:52:28.000Z' &&
            quotas[1].label === 'Weekly:' &&
            quotas[2].label === 'Monthly:' && quotas[2].resetTimeIso === null,
            `quota bars 5h/weekly/monthly on top (got [${quotas.map(q => `${q.label}${Math.round(q.percentUsed)}%`).join(',')}])`);
        allOk &= result(dist?.unit === 'cost' && dist.totalCost === 3989000000 &&
            dist.segments.length === 2 && dist.segments[0].model === 'model-a',
            `cost-dist: 2 models, $39.89 total, top first`);
        allOk &= result(mix?.unit === 'tokens' && mix.totalCost === 6201000 &&
            mix.segments.length === 4,
            `token mix: 4 types, 6201000 tokens (got ${mix?.totalCost})`);
        allOk &= result(daily?.bars?.length === 2 &&
            daily.bars.reduce((s, b) => s + b.value, 0) === 3989000000,
            `daily: 2 bars summing to total`);
        allOk &= result(recent?.unit === 'cost' && recent.bars.length === 15,
            `recent: 15 bars across 2 pages (got ${recent?.bars?.length})`);
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

    // ── TEST 4: rows down → recent skipped; JSON 401 → CSV fallback ──
    print('══ TEST 4: partial + full JSON failure ══');
    {
        jsonOk();
        jsonRoutes.unshift(['/rows', new Error('rows boom')]);
        const partial = await P.fetch(null, { apiKey: 'oc_sk_test' });
        allOk &= result(partial.entries.length === 7 &&
            !partial.entries.some(e => e.name === 'OpenCode Go Recent') &&
            partial.entries.filter(e => e.kind === 'percent').length === 3,
            `rows failure → 7 entries, no recent, quotas intact (got ${partial.entries.length})`);

        jsonRoutes = [['/summary', new Error('HTTP 401')],
            ['/models', new Error('HTTP 401')],
            ['/cost-by-day', new Error('HTTP 401')]];
        csvResponse = { status: 200, body: HEADER + '\n' };
        const fallback = await P.fetch(null, { apiKey: 'oc_sk_test' });
        allOk &= result(fallback.entries?.length === 1 && fallback.entries[0].kind === 'value',
            'JSON 401 + header-only CSV → single zero total');
    }
    print('');

    // ── TEST 5: JSON down + zero-charge CSV → token fallback ──
    print('══ TEST 5: zero-charge CSV fallback uses tokens ══');
    {
        jsonRoutes = [['/summary', new Error('down')], ['/models', new Error('down')],
            ['/cost-by-day', new Error('down')]];
        csvResponse = { status: 200, body: HEADER + '\n' +
            csvRow('1', 'claude-sonnet-4-5', 0, '2026-09-01', 1000, 200) + '\n' +
            csvRow('2', 'gpt-5', 0, '2026-09-02', 500, 100) + '\n' };
        const res = await P.fetch(null, { apiKey: 'oc_sk_test' });
        const dist = res.entries.find(e => e.name === 'OpenCode Go Cost Dist');
        const recent = res.entries.find(e => e.kind === 'barchart');
        const stacked = res.entries.find(e => e.kind === 'stackedbarchart');
        const total = res.entries.find(e => e.kind === 'value');
        print(`  kinds=[${kinds(res)}]`);
        allOk &= result(res.entries.length === 5, `all 5 entries present (got ${res.entries.length})`);
        allOk &= result(dist?.unit === 'tokens' && dist.totalCost === 1820,
            `model share by tokens, total 1820 (got ${dist?.totalCost} ${dist?.unit})`);
        allOk &= result(recent?.unit === 'tokens' && recent.bars.length === 2,
            `recent by tokens (${recent?.bars?.length} bars)`);
        allOk &= result(stacked?.unit === 'tokens' && stacked.buckets.length === 2,
            `stacked by tokens (${stacked?.buckets?.length} days)`);
        allOk &= result(/no per-request charge/.test(total?.value || ''),
            `total explains billing ("${total?.value}")`);
    }
    print('');

    // ── TEST 6: go-status down → quotas skipped, rest intact ──
    print('══ TEST 6: go-status failure skips quota bars ══');
    {
        jsonOk();
        jsonRoutes.unshift(['/go/status', new Error('forbidden')]);
        const res = await P.fetch(null, { apiKey: 'oc_sk_test' });
        allOk &= result(res.entries.length === 5 &&
            !res.entries.some(e => e.kind === 'percent'),
            `no quotas, 5 cost entries (got ${res.entries.length})`);
    }
    print('');

    print(allOk ? '══ ALL TESTS PASSED ══' : '══ SOME TESTS FAILED ══');
}

main();
