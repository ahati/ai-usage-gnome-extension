#!/usr/bin/env gjs
/* gjs-parse-test.js — Validate the Usage API CSV parser under GJS.
 *
 * Imports the real _parseCsv from providers/opencode-go.js (no copy, so it
 * can't drift). Covers: quoted commas/newlines, web-search rows (blank
 * model), header-only file, and numeric coercion. GJS uses SpiderMonkey
 * (not V8) — this confirms the parser behaves identically to Node.
 *
 * Usage:  gjs -m gjs-parse-test.js   (from project root)
 */
import { opencodeGoProvider as P } from './providers/opencode-go.js';

const HEADER = 'id,user_email,service_account_name,app,provider,model,' +
    'input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,' +
    'cache_write_5m_tokens,cache_write_1h_tokens,reasoning_mode,' +
    'reasoning_effort,reasoning_budget_tokens,reasoning_source,' +
    'billing_source,cost_micro_cents,created_at,service,quantity';

function result(ok, msg) {
    print(`  ${ok ? '✓ PASS' : '✗ FAIL'} — ${msg}`);
    return !!ok;
}

let allOk = true;

// ── TEST 1: basic rows + web-search row ──
print('══ TEST 1: inference + web-search rows ══');
{
    const csv = HEADER + '\n' +
        '101,alice@example.com,,opencode,anthropic,claude-sonnet-4-5,1000,200,50,300,0,0,effort,,,"api",managed-inference,374228,2026-09-01T10:00:00Z,,1\n' +
        'service:9,,,,,,,,,,,,,,,,,0,2026-09-01T11:00:00Z,web-search,2\n';
    const recs = P._parseCsv(csv);
    print(`  records: ${recs.length}`);
    const r0 = recs[0] || {};
    const r1 = recs[1] || {};
    allOk &= result(recs.length === 2, `2 records (got ${recs.length})`);
    allOk &= result(r0.model === 'claude-sonnet-4-5' && r0.cost === 374228 &&
        r0.inputTokens === 1000 && r0.timeMs > 0 && r0.date === '2026-09-01',
        'inference row fields intact');
    allOk &= result(r1.model === '' && r1.service === 'web-search' && r1.cost === 0,
        'web-search row: blank model, service set');
    allOk &= result(P._modelKey(r1) === 'web-search', 'web-search display key');
}
print('');

// ── TEST 2: quoted commas / quotes / newlines ──
print('══ TEST 2: RFC-4180 quoting ══');
{
    const csv = HEADER + '\n' +
        '102,bob@example.com,,"my, app",openai,"gpt-4o, mini",10,20,0,0,0,0,disabled,,,"ui",credit,5000,2026-09-02T00:00:00Z,,1\n' +
        '103,carol@example.com,,"line1\nline2",deepseek,deepseek-chat,1,1,0,0,0,0,disabled,,,"api",byok,0,2026-09-02T01:00:00Z,,1\n';
    const recs = P._parseCsv(csv);
    allOk &= result(recs.length === 2, `2 records (got ${recs.length})`);
    allOk &= result(recs[0]?.model === 'gpt-4o, mini', `quoted comma in model ("${recs[0]?.model}")`);
    allOk &= result(recs[1]?.model === 'deepseek-chat', 'quoted newline inside other field');
}
print('');

// ── TEST 3: header-only + empty ──
print('══ TEST 3: header-only / empty files ══');
{
    const headerOnly = P._parseCsv(HEADER + '\n');
    const empty = P._parseCsv('');
    allOk &= result(Array.isArray(headerOnly) && headerOnly.length === 0, 'header-only → 0 rows');
    allOk &= result(Array.isArray(empty) && empty.length === 0, 'empty → 0 rows');
}
print('');

// ── TEST 4: column order independence + bad numbers ──
print('══ TEST 4: shuffled columns, blank numerics ══');
{
    const csv = 'model,cost_micro_cents,created_at,input_tokens,id\n' +
        'kimi-k2,abc,2026-09-03T05:00:00Z,,xyz-1\n';
    const recs = P._parseCsv(csv);
    allOk &= result(recs.length === 1, `1 record (got ${recs.length})`);
    allOk &= result(recs[0]?.cost === 0 && recs[0]?.inputTokens === 0,
        'non-numeric / blank numerics coerce to 0');
    allOk &= result(recs[0]?.date === '2026-09-03', 'date sliced from created_at');
}
print('');

print(allOk ? '══ ALL TESTS PASSED ══' : '══ SOME TESTS FAILED ══');
