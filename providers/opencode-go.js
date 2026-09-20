/* OpenCode provider — Console usage APIs.
 *
 * Primary: JSON usage endpoints (same Console origin as the dashboard):
 *   GET {CONSOLE_URL}/api/v1/usage/export      (documented, CSV)
 *   GET {CONSOLE_URL}/api/usage/summary        (totals + real costs)
 *   GET {CONSOLE_URL}/api/usage/models         (per-model aggregates)
 *   GET {CONSOLE_URL}/api/usage/cost-by-day    (per-day cost totals)
 *   GET {CONSOLE_URL}/api/usage/rows           (per-request log, cursor pages)
 * See https://opencode.ai/console/guides/usage and the workspace Logs page.
 *
 * Auth: service account API key (oc_sk_...) in the Authorization header.
 * User session tokens are rejected. The workspace is derived from the key,
 * so no workspace ID is sent.
 *
 * Why two paths: the CSV export reports cost_micro_cents=0 for `go`-plan
 * usage, while the JSON endpoints report the real per-request costs (the
 * same numbers shown under Logs in Console). So costs come from JSON;
 * the CSV export stays as a fallback (token-based charts) if the JSON
 * endpoints ever reject the service key.
 *
 * Values arrive as JSON strings ("12471") — always coerce with _num().
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import { modelColor } from './colors.js';
import { USER_AGENT } from './constants.js';
import { fmtCost, fmtNum, xLabelShort } from './utils.js';
import * as logger from '../logger.js';

const DEFAULT_CONSOLE_URL = 'https://opencode.ai/console';
const RANGE = '30d';
const MAX_RECENT = 50;
const ROW_PAGES = 5;   // rows endpoint pages at 10/page → 5 pages = 50 calls

const TOKEN_COLORS = {
    'Input': '#3584e4',
    'Output': '#26a269',
    'Reasoning': '#9141ac',
    'Cache read': '#ff7800',
    'Cache write 5m': '#f6d32d',
    'Cache write 1h': '#e5a50a',
};

export const opencodeGoProvider = {
    id: 'opencode-go',
    label: 'OpenCode Go',
    logoFile: 'opencode-logo.svg',
    fullColorLogo: true,

    needsAuth(credentials) {
        return !!(credentials.apiKey);
    },

    async fetch(session, credentials) {
        const apiKey = (credentials.apiKey || '').trim();
        const base = this._baseUrl(credentials);

        if (!apiKey) {
            // Accounts created before the Usage API migration used a
            // workspace ID + auth cookie. Those no longer work — point the
            // user at the fix instead of failing silently.
            if (credentials.workspaceId || credentials.authCookie) {
                return { attempted: true, entries: [],
                    errors: ['OpenCode: usage tracking now needs a service API key (oc_sk_...). ' +
                        'Create one in Console and update this account in Preferences. ' +
                        'See https://opencode.ai/console/guides/usage'] };
            }
            return { attempted: false };
        }

        // Primary path: JSON endpoints with real costs.
        try {
            return await this._fetchJson(session, base, apiKey);
        } catch (e) {
            logger.warn('OpenCode JSON usage API failed, falling back to CSV export:', e.message || e);
            return await this._fetchCsv(session, base, apiKey);
        }
    },

    /* Console base URL: per-account override or the default. The guide's
     * example strips a trailing slash — do the same. */
    _baseUrl(credentials) {
        const raw = (credentials.consoleUrl || '').trim() || DEFAULT_CONSOLE_URL;
        return raw.replace(/\/$/, '');
    },

    /* Coerce the API's string-encoded numbers ("12471") safely. */
    _num(v) {
        const n = Number(v);
        return isNaN(n) ? 0 : n;
    },

    /* ── JSON path (real costs) ── */

    async _fetchJson(session, base, apiKey) {
        const q = `range=${encodeURIComponent(RANGE)}`;
        const [summary, models, byDay] = await Promise.all([
            this._getJson(session, `${base}/api/usage/summary?${q}`, apiKey, 'summary'),
            this._getJson(session, `${base}/api/usage/models?${q}`, apiKey, 'models'),
            this._getJson(session, `${base}/api/usage/cost-by-day?${q}`, apiKey, 'cost-by-day'),
        ]);

        // Recent calls are best-effort: cursor pages of the request log.
        let recent = null;
        try {
            const rows = await this._fetchRecentRows(session, base, apiKey);
            recent = this._buildRecentCostChart(rows);
        } catch (e) {
            logger.warn('OpenCode request-log rows failed, skipping recent chart:', e.message || e);
        }

        const entries = [];
        const total = this._buildCostTotal(summary);
        if (total) entries.push(total);
        const dist = this._buildModelCostEntry(models);
        if (dist) entries.push(dist);
        const mix = this._buildTokenMixFromSummary(summary);
        if (mix) entries.push(mix);
        const daily = this._buildDailyCostChart(byDay);
        if (daily) entries.push(daily);
        if (recent) entries.push(recent);

        if (entries.length === 0) {
            throw new Error('empty JSON usage response');
        }
        logger.info('OpenCode Usage API (JSON):',
            `${summary.totalRequests} requests, ${fmtCost(this._num(summary.totalCostMicroCents))}`);
        return { attempted: true, entries, errors: [] };
    },

    /* GET a JSON usage endpoint. Throws on transport errors, non-200
     * status, or unparseable bodies so fetch() can fall back to CSV. */
    async _getJson(session, url, apiKey, what) {
        const { status, body } = await new Promise((resolve, reject) => {
            const msg = Soup.Message.new('GET', url);
            msg.get_request_headers().append('User-Agent', USER_AGENT);
            msg.get_request_headers().append('Accept', 'application/json');
            msg.get_request_headers().append('Authorization', `Bearer ${apiKey}`);

            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null,
                (s, res) => {
                    try {
                        const respBytes = s.send_and_read_finish(res);
                        const text = new TextDecoder().decode(
                            respBytes?.get_data() ?? new Uint8Array(0));
                        resolve({ status: msg.get_status(), body: text });
                    } catch (e) { reject(e); }
                });
        });

        if (status === 401)
            throw new Error('missing, invalid, expired, or revoked service API key');
        if (status === 403)
            throw new Error('service account is not allowed to read usage');
        if (status !== 200)
            throw new Error(`${what}: HTTP ${status}`);
        try {
            return JSON.parse(body);
        } catch (e) {
            throw new Error(`${what}: invalid JSON response`);
        }
    },

    /* First pages of the request log (newest-first, 10/page) up to
     * MAX_RECENT records, following nextCursor. */
    async _fetchRecentRows(session, base, apiKey) {
        const all = [];
        let cursor = null;
        for (let pg = 0; pg < ROW_PAGES && all.length < MAX_RECENT; pg++) {
            let url = `${base}/api/usage/rows?range=${encodeURIComponent(RANGE)}`;
            if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
            const data = await this._getJson(session, url, apiKey, 'rows');
            const items = Array.isArray(data.items) ? data.items : [];
            if (items.length === 0) break;
            for (const it of items) {
                if (all.length >= MAX_RECENT) break;
                all.push({
                    id: String(it.id ?? ''),
                    model: it.model || it.service || '(unknown)',
                    cost: this._num(it.costMicroCents),
                    timeMs: it.createdAt ? new Date(it.createdAt).getTime() || 0 : 0,
                });
            }
            cursor = data.nextCursor || null;
            if (!cursor) break;
        }
        return all;
    },

    _buildCostTotal(summary) {
        const cost = this._num(summary.totalCostMicroCents);
        const reqs = this._num(summary.totalRequests);
        return {
            kind: 'value', name: 'OpenCode Total', group: 'OpenCode Go',
            label: `Total cost (${RANGE}):`,
            value: `${fmtCost(cost)} (${fmtNum(reqs)} calls)`,
        };
    },

    /* Cost share per model from /models (real charges), descending. */
    _buildModelCostEntry(modelsData) {
        const items = Array.isArray(modelsData.items) ? modelsData.items : [];
        const rows = items
            .map((it, i) => ({
                model: it.model || '(unknown)',
                color: modelColor(it.model, i),
                value: this._num(it.totalCostMicroCents),
            }))
            .filter(r => r.value > 0)
            .sort((a, b) => b.value - a.value);
        if (rows.length === 0) return null;

        const totalCost = rows.reduce((s, r) => s + r.value, 0);
        const legend = rows.map(r => ({ name: r.model, color: r.color, total: r.value }));
        return {
            kind: 'costdistribution', name: 'OpenCode Go Cost Dist',
            group: 'OpenCode Go',
            label: `Cost by model (${RANGE})`,
            segments: rows, legend, totalCost, unit: 'cost',
        };
    },

    /* Token-type mix from /summary totals. The summary has no reasoning
     * total, so that slice is omitted (it is ~0.2% of volume anyway). */
    _buildTokenMixFromSummary(summary) {
        const raw = [
            { model: 'Input', value: this._num(summary.totalInputTokens) },
            { model: 'Output', value: this._num(summary.totalOutputTokens) },
            { model: 'Reasoning', value: 0 },
            { model: 'Cache read', value: this._num(summary.totalCacheReadTokens) },
            { model: 'Cache write 5m', value: this._num(summary.totalCacheWrite5mTokens) },
            { model: 'Cache write 1h', value: this._num(summary.totalCacheWrite1hTokens) },
        ].map(s => ({ ...s, color: TOKEN_COLORS[s.model] }));

        const segments = raw
            .filter(s => s.value > 0)
            .sort((a, b) => b.value - a.value);
        const total = segments.reduce((s, seg) => s + seg.value, 0);
        if (total === 0) return null;

        const legend = segments.map(s => ({ name: s.model, color: s.color, total: s.value }));
        return {
            kind: 'costdistribution', name: 'OpenCode Go Token Mix',
            group: 'OpenCode Go',
            label: `Token mix (${RANGE})`,
            segments, legend, totalCost: total, unit: 'tokens',
        };
    },

    /* One bar per calendar day from /cost-by-day (real charges). */
    _buildDailyCostChart(byDayData) {
        const items = Array.isArray(byDayData) ? byDayData : byDayData.items || [];
        const color = modelColor('__day__', 0);
        const bars = items
            .filter(d => d.date)
            .sort((a, b) => (a.date < b.date ? -1 : 1))
            .map(d => ({
                value: this._num(d.totalCostMicroCents),
                color,
                label: xLabelShort(d.date),
            }));
        if (bars.length === 0 || !bars.some(b => b.value > 0)) return null;

        const total = bars.reduce((s, b) => s + b.value, 0);
        return {
            kind: 'barchart', name: 'OpenCode Go Daily',
            group: 'OpenCode Go', label: `Cost by day (${RANGE})`,
            bars, legend: [{ name: 'Total', color, total }],
            granularity: 'daily', unit: 'cost',
        };
    },

    /* Recent calls by real per-request cost, oldest → newest (left → right). */
    _buildRecentCostChart(rows) {
        if (!rows || rows.length === 0) return null;

        const modelIndex = new Map();
        for (const r of rows) {
            if (!modelIndex.has(r.model))
                modelIndex.set(r.model, modelColor(r.model, modelIndex.size));
        }
        const bars = rows.slice().reverse().map(r => ({
            value: r.cost || 0,
            color: modelIndex.get(r.model),
            label: '',
        }));
        if (!bars.some(b => b.value > 0)) return null;

        const legend = [...modelIndex.entries()].map(([name, color]) => ({
            name, color, total: null,
        }));
        return {
            kind: 'barchart', name: 'OpenCode Go Recent',
            group: 'OpenCode Go', label: `Recent ${rows.length} calls (by cost)`,
            bars, legend, granularity: 'calls', unit: 'cost',
        };
    },

    /* ── CSV fallback path (zero-charge-safe token charts) ── */

    async _fetchCsv(session, base, apiKey) {
        const url = `${base}/api/v1/usage/export?` +
            `scope=organization&range=${encodeURIComponent(RANGE)}`;

        let status, body;
        try {
            ({ status, body } = await this._getCsv(session, url, apiKey));
        } catch (e) {
            return { attempted: true, entries: [],
                errors: [`OpenCode: ${e.message || e}`] };
        }

        if (status !== 200 || body === null) {
            return { attempted: true, entries: [],
                errors: [this._httpError(status, body)] };
        }

        const records = this._parseCsv(body);
        if (!records || records.length === 0) {
            return { attempted: true, entries: [{
                kind: 'value', name: 'OpenCode Total', group: 'OpenCode Go',
                label: `Total cost (${RANGE}):`, value: fmtCost(0),
            }], errors: [] };
        }

        logger.info('OpenCode Usage API (CSV fallback):', `${records.length} records from ${base}`);

        // `go`-plan usage exports with zero charge — fall back to token
        // volume for the per-model charts so they stay meaningful.
        const useCost = records.some(r => (r.cost || 0) > 0);

        const entries = [];
        const total = this._buildTotal(records, useCost);
        if (total) entries.push(total);
        const dist = this._buildCostEntry(records, useCost);
        if (dist) entries.push(dist);
        const mix = this._buildTokenBreakdown(records);
        if (mix) entries.push(mix);
        const stacked = this._buildStackedCostChart(records, useCost);
        if (stacked) entries.push(stacked);
        const recent = this._buildRecentChart(records, useCost);
        if (recent) entries.push(recent);

        if (entries.length === 0) {
            return { attempted: true, entries: [],
                errors: ['OpenCode: no usable records in usage export'] };
        }
        return { attempted: true, entries, errors: [] };
    },

    /* GET the CSV export with status preserved (401/403/400 need distinct
     * messages, so httpGet's null-on-error shape won't do). */
    async _getCsv(session, url, apiKey) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('GET', url);
            msg.get_request_headers().append('User-Agent', USER_AGENT);
            msg.get_request_headers().append('Accept', 'text/csv');
            msg.get_request_headers().append('Authorization', `Bearer ${apiKey}`);

            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null,
                (s, res) => {
                    try {
                        const respBytes = s.send_and_read_finish(res);
                        const text = new TextDecoder().decode(
                            respBytes?.get_data() ?? new Uint8Array(0));
                        resolve({ status: msg.get_status(), body: text });
                    } catch (e) { reject(e); }
                });
        });
    },

    _httpError(status, body) {
        const detail = (body || '').trim().substring(0, 160);
        const suffix = detail ? `: ${detail}` : '';
        if (status === 400)
            return `OpenCode: bad request (missing/invalid params or scope filter)${suffix}`;
        if (status === 401)
            return 'OpenCode: missing, invalid, expired, or revoked service API key. ' +
                'Create a new key in Console and update Preferences.';
        if (status === 403)
            return 'OpenCode: service account is not allowed to read usage.';
        return `OpenCode: HTTP ${status || 'error'}${suffix}`;
    },

    /* ── CSV parsing ── */

    /* Minimal RFC-4180 parse: quoted fields may contain commas, quotes
     * (doubled) and newlines. Returns an array of row objects keyed by the
     * header names. Unquoted numbers/fields pass through as strings. */
    _parseCsv(text) {
        // Strip BOM; header-only file → no rows.
        const src = text.replace(/^\uFEFF/, '');
        const rows = [];
        let field = '', row = [], inQuotes = false;

        for (let i = 0; i < src.length; i++) {
            const ch = src[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (src[i + 1] === '"') { field += '"'; i++; }
                    else inQuotes = false;
                } else field += ch;
            } else if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                row.push(field); field = '';
            } else if (ch === '\n') {
                row.push(field); field = '';
                rows.push(row); row = [];
            } else if (ch === '\r') {
                // ignore, \n handles the break
            } else field += ch;
        }
        // Trailing field without newline.
        if (field !== '' || row.length > 0) {
            row.push(field);
            rows.push(row);
        }
        // Drop blank lines (single empty field).
        const nonEmpty = rows.filter(r => !(r.length === 1 && r[0] === ''));
        if (nonEmpty.length < 2) return [];

        const header = nonEmpty[0].map(h => h.trim());
        const records = [];
        for (let r = 1; r < nonEmpty.length; r++) {
            const cols = nonEmpty[r];
            const get = (name) => {
                const idx = header.indexOf(name);
                return idx >= 0 && idx < cols.length ? cols[idx].trim() : '';
            };
            const num = (name) => {
                const v = parseInt(get(name), 10);
                return isNaN(v) ? 0 : v;
            };
            const createdAt = get('created_at');
            records.push({
                id: get('id'),
                model: get('model'),
                provider: get('provider'),
                service: get('service'),
                billingSource: get('billing_source'),
                inputTokens: num('input_tokens'),
                outputTokens: num('output_tokens'),
                reasoningTokens: num('reasoning_tokens'),
                cacheReadTokens: num('cache_read_tokens'),
                cacheWrite5mTokens: num('cache_write_5m_tokens'),
                cacheWrite1hTokens: num('cache_write_1h_tokens'),
                // cost_micro_cents: 1 USD = 100,000,000 (same scale the old
                // SSR `cost` field used, so fmtCost applies unchanged).
                cost: num('cost_micro_cents'),
                date: createdAt.slice(0, 10),
                timeMs: createdAt ? new Date(createdAt).getTime() || 0 : 0,
            });
        }
        return records;
    },

    /* Display key for a record. Search rows leave provider/model blank and
     * identify via service=web-search — keep them as their own segment so
     * cost totals match billing. */
    _modelKey(r) {
        if (r.model) return r.model;
        if (r.service) return r.service;
        return '(unknown)';
    },

    /* Token volume of one record (all six token columns). Chart metric when
     * no record carries a charge. */
    _tokens(r) {
        return (r.inputTokens || 0) + (r.outputTokens || 0) +
            (r.reasoningTokens || 0) + (r.cacheReadTokens || 0) +
            (r.cacheWrite5mTokens || 0) + (r.cacheWrite1hTokens || 0);
    },

    /* Chart metric: microcents when charges exist, else token volume. */
    _metric(r, useCost) {
        return useCost ? (r.cost || 0) : this._tokens(r);
    },

    /* ── CSV-path entries (same kinds/shapes charting.js already renders) ── */

    _buildTotal(records, useCost) {
        const totalCost = records.reduce((s, r) => s + (r.cost || 0), 0);
        if (useCost) {
            return {
                kind: 'value', name: 'OpenCode Total', group: 'OpenCode Go',
                label: `Total cost (${RANGE}, ${records.length} records):`,
                value: `${fmtCost(totalCost)} (${fmtNum(records.length)} calls)`,
            };
        }
        // Zero-charge export (e.g. `go` plan): show how it was billed.
        const sources = [...new Set(records.map(r => r.billingSource || 'unknown'))];
        return {
            kind: 'value', name: 'OpenCode Total', group: 'OpenCode Go',
            label: `Usage (${RANGE}, ${records.length} records):`,
            value: `${sources.join('/')} · ${fmtNum(records.length)} calls (no per-request charge)`,
        };
    },

    /* Cost share per model — or token share when nothing carries a charge. */
    _buildCostEntry(records, useCost) {
        const order = [];
        const byModel = new Map();
        for (const r of records) {
            const key = this._modelKey(r);
            if (!byModel.has(key)) {
                byModel.set(key, 0);
                order.push(key);
            }
            byModel.set(key, byModel.get(key) + this._metric(r, useCost));
        }
        const totalCost = [...byModel.values()].reduce((s, v) => s + v, 0);
        if (totalCost === 0) return null;

        const segments = order
            .map((name, i) => ({ model: name, color: modelColor(name, i), value: byModel.get(name) }))
            .sort((a, b) => b.value - a.value);
        const legend = segments.map(s => ({ name: s.model, color: s.color, total: s.value }));

        return {
            kind: 'costdistribution', name: 'OpenCode Go Cost Dist',
            group: 'OpenCode Go',
            label: useCost
                ? `Cost distribution (${RANGE}, ${records.length} calls)`
                : `Model share by tokens (${RANGE}, ${records.length} calls)`,
            segments, legend, totalCost, unit: useCost ? 'cost' : 'tokens',
        };
    },

    /* Token-type breakdown across all records. Cache-write segments appear
     * only when they contain data. */
    _buildTokenBreakdown(records) {
        let inputSum = 0, outputSum = 0, reasoningSum = 0,
            cacheReadSum = 0, cacheWrite5mSum = 0, cacheWrite1hSum = 0;
        for (const r of records) {
            inputSum += r.inputTokens || 0;
            outputSum += r.outputTokens || 0;
            reasoningSum += r.reasoningTokens || 0;
            cacheReadSum += r.cacheReadTokens || 0;
            cacheWrite5mSum += r.cacheWrite5mTokens || 0;
            cacheWrite1hSum += r.cacheWrite1hTokens || 0;
        }

        const raw = [
            { model: 'Input', value: inputSum },
            { model: 'Output', value: outputSum },
            { model: 'Reasoning', value: reasoningSum },
            { model: 'Cache read', value: cacheReadSum },
            { model: 'Cache write 5m', value: cacheWrite5mSum },
            { model: 'Cache write 1h', value: cacheWrite1hSum },
        ].map(s => ({ ...s, color: TOKEN_COLORS[s.model] }));

        const showCacheWrite = cacheWrite5mSum > 0 || cacheWrite1hSum > 0;
        const segments = raw
            .filter(s => s.value > 0)
            .filter(s => showCacheWrite || !s.model.startsWith('Cache write'))
            .sort((a, b) => b.value - a.value);

        const total = segments.reduce((s, seg) => s + seg.value, 0);
        if (total === 0) return null;

        const legend = segments.map(s => ({ name: s.model, color: s.color, total: s.value }));
        return {
            kind: 'costdistribution', name: 'OpenCode Go Token Mix',
            group: 'OpenCode Go',
            label: `Token mix (${RANGE}, ${records.length} calls)`,
            segments, legend, totalCost: total, unit: 'tokens',
        };
    },

    /* One bar per calendar day, stacked by model (cost or tokens). */
    _buildStackedCostChart(records, useCost) {
        const modelIndex = new Map();
        const byDate = new Map();
        for (const r of records) {
            if (!r.date) continue;
            const key = this._modelKey(r);
            if (!modelIndex.has(key))
                modelIndex.set(key, { name: key, color: modelColor(key, modelIndex.size) });
            if (!byDate.has(r.date)) byDate.set(r.date, new Map());
            const dm = byDate.get(r.date);
            dm.set(key, (dm.get(key) || 0) + this._metric(r, useCost));
        }
        if (byDate.size === 0) return null;

        const sortedDates = [...byDate.keys()].sort();
        const buckets = sortedDates.map(date => {
            const dm = byDate.get(date);
            const segments = [];
            for (const [name, info] of modelIndex) {
                const v = dm.get(name) || 0;
                if (v > 0) segments.push({ model: name, color: info.color, value: v });
            }
            return { label: xLabelShort(date), segments };
        });

        const totals = new Map();
        for (const r of records) {
            const key = this._modelKey(r);
            totals.set(key, (totals.get(key) || 0) + this._metric(r, useCost));
        }
        const legend = [...modelIndex.entries()]
            .map(([name, info]) => ({ name, color: info.color, total: totals.get(name) || 0 }))
            .filter(l => l.total > 0)
            .sort((a, b) => b.total - a.total);

        return {
            kind: 'stackedbarchart', name: 'OpenCode Go 30d',
            group: 'OpenCode Go',
            label: useCost ? `Cost by model (${RANGE})` : `Tokens by model (${RANGE})`,
            buckets, legend, granularity: 'daily', unit: useCost ? 'cost' : 'tokens',
        };
    },

    /* Most recent calls (export is newest-first): bar height = cost or
     * tokens, color = model. Rendered oldest → newest (left → right). */
    _buildRecentChart(records, useCost) {
        const take = records.slice(0, MAX_RECENT);
        if (take.length === 0) return null;

        const modelIndex = new Map();
        for (const r of take) {
            const key = this._modelKey(r);
            if (!modelIndex.has(key))
                modelIndex.set(key, modelColor(key, modelIndex.size));
        }

        const bars = take.slice().reverse().map(r => ({
            value: this._metric(r, useCost),
            color: modelIndex.get(this._modelKey(r)),
            label: '',
        }));
        if (!bars.some(b => b.value > 0)) return null;

        const legend = [...modelIndex.entries()].map(([name, color]) => ({
            name, color, total: null,
        }));

        return {
            kind: 'barchart', name: 'OpenCode Go Recent',
            group: 'OpenCode Go', label: useCost
                ? `Recent ${take.length} calls (by cost)`
                : `Recent ${take.length} calls (by tokens)`,
            bars, legend, granularity: 'calls', unit: useCost ? 'cost' : 'tokens',
        };
    },
};
