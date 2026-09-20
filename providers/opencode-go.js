/* OpenCode provider — official Usage API.
 *
 * Endpoint: GET {CONSOLE_URL}/api/v1/usage/export (see
 * https://opencode.ai/console/guides/usage)
 *
 * Auth: service account API key (oc_sk_...) in the Authorization header.
 * User session tokens are rejected. The workspace is derived from the key,
 * so no workspace ID is sent.
 *
 * A single `scope=organization&range=30d` CSV export carries every record
 * (newest first). All charts below are aggregated locally from that one
 * response — no dashboard scraping, no x-server-id inference, no /_server
 * RPC.
 *
 * CSV columns (header-driven, order not assumed): id, user_email,
 * service_account_name, app, provider, model, input_tokens, output_tokens,
 * reasoning_tokens, cache_read_tokens, cache_write_5m_tokens,
 * cache_write_1h_tokens, reasoning_mode, reasoning_effort,
 * reasoning_budget_tokens, reasoning_source, billing_source,
 * cost_micro_cents (1 USD = 100,000,000), created_at (ISO 8601 UTC),
 * service (web-search for search rows), quantity.
 *
 * NOTE: records billed to the `go` plan carry cost_micro_cents=0 in the
 * export (only managed-inference usage carries a charge). When no record
 * has a charge, the model-share / daily / recent charts fall back to token
 * volume (unit 'tokens') so the detailed charting keeps working.
 */
import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import { modelColor } from './colors.js';
import { USER_AGENT } from './constants.js';
import { COST_DIVISOR, fmtCost, fmtNum, xLabelShort } from './utils.js';
import * as logger from '../logger.js';

const DEFAULT_CONSOLE_URL = 'https://opencode.ai/console';
const RANGE = '30d';
const MAX_RECENT = 50;

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
            // A valid filter with no matching rows is HTTP 200 with a
            // header-only file — not an error.
            return { attempted: true, entries: [{
                kind: 'value', name: 'OpenCode Total', group: 'OpenCode Go',
                label: `Total cost (${RANGE}):`, value: fmtCost(0),
            }], errors: [] };
        }

        logger.info('OpenCode Usage API:', `${records.length} records from ${base}`);

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

    /* Console base URL: per-account override or the default. The guide's
     * example strips a trailing slash — do the same. */
    _baseUrl(credentials) {
        const raw = (credentials.consoleUrl || '').trim() || DEFAULT_CONSOLE_URL;
        return raw.replace(/\/$/, '');
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

    /* ── Entries (same kinds/shapes charting.js already renders) ── */

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

        const TOKEN_COLORS = {
            'Input': '#3584e4',
            'Output': '#26a269',
            'Reasoning': '#9141ac',
            'Cache read': '#ff7800',
            'Cache write 5m': '#f6d32d',
            'Cache write 1h': '#e5a50a',
        };
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
            group: 'OpenCode Go',
            label: useCost
                ? `Recent ${take.length} calls (by cost)`
                : `Recent ${take.length} calls (by tokens)`,
            bars, legend, granularity: 'calls', unit: useCost ? 'cost' : 'tokens',
        };
    },
};
