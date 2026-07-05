/* OpenCode Go provider
 *
 * Two data sources:
 *
 *  1. SSR pages (/go, /usage) — SolidJS hydration stream carries:
 *     - /go:        rollingUsage / weeklyUsage / monthlyUsage percent bars
 *     - /usage:     the 50 most recent per-request records, each with
 *                   {model, inputTokens, outputTokens, reasoningTokens, cost,
 *                    timeCreated}. We use these for the rolling-50 chart
 *                   (height = cost, color = model).
 *
 *  2. POST /_server (x-server-instance: server-fn:7) — returns structured
 *     per-day-per-model cost records for one calendar month:
 *       {date, model, totalCost, keyId, plan}
 *     Used for the 7d and 30d stacked-by-model cost charts.
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import { MODEL_COLORS, modelColor } from './colors.js';
import { USER_AGENT } from './constants.js';
import { clamp, COST_DIVISOR, fmtCost, xLabelShort, httpGet, httpPost } from './utils.js';

const BASE = 'https://opencode.ai';

export const opencodeGoProvider = {
    id: 'opencode-go',
    label: 'OpenCode Go',
    logoFile: 'opencode-logo.svg',
    fullColorLogo: true,

    needsAuth(credentials) {
        return !!(credentials.workspaceId && credentials.authCookie);
    },

    async fetch(session, credentials) {
        const workspaceId = credentials.workspaceId;
        const authCookie = credentials.authCookie;

        if (!workspaceId || !authCookie)
            return { attempted: false };

        try {
            // 1. /go dashboard — 5h / weekly / monthly percent bars.
            const goUrl = `${BASE}/workspace/${encodeURIComponent(workspaceId)}/go`;
            const goHtml = await this._get(session, goUrl, authCookie);

            if (!goHtml) {
                return { attempted: true, entries: [],
                    errors: ['OpenCode Go: could not load dashboard page'] };
            }

            if (goHtml.includes('<title>OpenAuth</title>') || goHtml.includes('Sign in')) {
                return { attempted: true, entries: [],
                    errors: ['OpenCode Go: auth cookie expired. Re-authenticate and update in Preferences.'] };
            }

            const result = this._parseSSR(goHtml);

            // 2. /usage page — rolling-50 model-colored cost chart.
            try {
                const usageUrl = `${BASE}/workspace/${encodeURIComponent(workspaceId)}/usage`;
                const usageHtml = await this._get(session, usageUrl, authCookie);
                if (usageHtml) {
                    const rolling = this._buildRollingModelChart(usageHtml);
                    if (rolling) result.entries.push(rolling);
                }
            } catch (e) {
                log(`[ai-usage] OpenCode Go rolling chart failed: ${e}`);
            }

            // 3. Cost charts: a horizontal cost-distribution bar from recent
            // per-request records (getUsageInfo) + a 30d daily stacked chart
            // (getCosts). Both need x-server-id hashes, resolved explicitly
            // per-account or inferred from the client JS bundle.
            try {
                const inferred = credentials.serverId
                    ? { getCosts: credentials.serverId, getUsageInfo: credentials.serverId }
                    : await this._inferServerIds(session, workspaceId, authCookie);
                if (inferred) {
                    // Cost distribution from recent requests (replaces the old 7d chart).
                    if (inferred.getUsageInfo) {
                        const dist = await this._buildCostDistribution(
                            session, workspaceId, authCookie, inferred.getUsageInfo);
                        if (dist) result.entries.push(dist);
                    }
                    // 30d daily stacked-by-model cost chart.
                    if (inferred.getCosts) {
                        await this._fetchAndPushCostCharts(
                            session, workspaceId, authCookie, inferred.getCosts, result.entries);
                    }
                } else {
                    log('[ai-usage] OpenCode Go: could not resolve x-server-id; skipping cost charts');
                }
            } catch (e) {
                log(`[ai-usage] OpenCode Go cost charts failed: ${e}`);
            }

            return result;
        } catch (e) {
            return { attempted: true, entries: [],
                errors: [`OpenCode Go: ${e.message || e}`] };
        }
    },

    async _get(session, url, authCookie) {
        return await httpGet(session, url, {
            'User-Agent': USER_AGENT,
            'Accept': '*/*',
            'Cookie': `auth=${authCookie}`,
            'Referer': `${BASE}/workspace/`,
        });
    },

    /* Infer the x-server-id hashes for the server functions by inspecting the
     * client JS bundles. SolidStart bakes a stable per-deployment hash into
     * the bundle as `getCosts_1 = createServerReference("<hash>")`.
     *
     * Returns { getCosts, getUsageInfo } (either may be null if not found).
     * Cached on this._inferredIds for the session. */
    async _inferServerIds(session, workspaceId, authCookie) {
        if (this._inferredIds) return this._inferredIds;

        try {
            // 1. Find the entry-client bundle URL from the usage page HTML.
            const usageHtml = await this._get(session,
                `${BASE}/workspace/${encodeURIComponent(workspaceId)}/usage`, authCookie);
            if (!usageHtml) return null;
            const entryMatch = usageHtml.match(/src="(\/_build\/assets\/entry-client-[^"]+\.js)"/);
            if (!entryMatch) {
                log('[ai-usage] could not find entry-client bundle');
                return null;
            }

            // 2. Fetch entry-client, extract index-*.js chunk references.
            const entryBody = await this._get(session, `${BASE}${entryMatch[1]}`, authCookie);
            if (!entryBody) return null;
            const chunkNames = [...new Set(
                entryBody.match(/_build\/assets\/(index-[A-Za-z0-9_-]+\.js)/g)
                    ?.map(s => s.replace(/^.*\//, '')) || [])];

            // 3. Fetch each chunk until we find the server-reference definitions.
            const ids = { getCosts: null, getUsageInfo: null };
            for (const chunk of chunkNames) {
                if (ids.getCosts && ids.getUsageInfo) break;
                const body = await this._get(session,
                    `${BASE}/_build/assets/${chunk}`, authCookie);
                if (!body) continue;
                if (!ids.getCosts) {
                    const m = body.match(/getCosts\w*\s*=\s*createServerReference\("([0-9a-f]{64})"\)/);
                    if (m) ids.getCosts = m[1];
                }
                if (!ids.getUsageInfo) {
                    const m = body.match(/getUsageInfo\w*\s*=\s*createServerReference\("([0-9a-f]{64})"\)/);
                    if (m) ids.getUsageInfo = m[1];
                }
            }
            this._inferredIds = ids;
            log(`[ai-usage] inferred server ids: getCosts=${ids.getCosts?.slice(0, 8)}… getUsageInfo=${ids.getUsageInfo?.slice(0, 8)}…`);
            return ids;
        } catch (e) {
            log(`[ai-usage] server-id inference failed: ${e}`);
            return null;
        }
    },

    /* POST /_server with the server-fn:7 RPC body to fetch one calendar
     * month of per-day-per-model cost records. Returns [{date, model,
     * totalCost}] or null on failure. `serverId` is the x-server-id header
     * (required, per-account configurable). */
    async _postServer(session, workspaceId, authCookie, serverId, year, monthIndex0) {
        const body = JSON.stringify({
            t: {
                t: 9, i: 0, l: 4,
                a: [
                    { t: 1, s: workspaceId },
                    { t: 0, s: year },
                    { t: 0, s: monthIndex0 },
                    { t: 1, s: this._tzOffset() },
                ],
                o: 0,
            },
            f: 31,
            m: [],
        });

        return new Promise((resolve) => {
            const msg = Soup.Message.new('POST', `${BASE}/_server`);
            msg.get_request_headers().append('User-Agent', USER_AGENT);
            msg.get_request_headers().append('Content-Type', 'application/json');
            msg.get_request_headers().append('Accept', '*/*');
            msg.get_request_headers().append('Cookie', `auth=${authCookie}; oc_locale=en`);
            msg.get_request_headers().append('x-server-id', serverId);
            msg.get_request_headers().append('x-server-instance', 'server-fn:7');
            msg.get_request_headers().append('Origin', BASE);
            msg.get_request_headers().append('Referer', `${BASE}/workspace/${workspaceId}/usage`);

            const bytes = new TextEncoder().encode(body);
            msg.set_request_body_from_bytes('application/json',
                GLib.Bytes.new(bytes));

            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null,
                (s, res) => {
                    try {
                        const respBytes = s.send_and_read_finish(res);
                        if (msg.get_status() !== 200) { resolve(null); return; }
                        const text = new TextDecoder().decode(
                            respBytes?.get_data() ?? new Uint8Array(0));
                        resolve(this._parseServerRecords(text));
                    } catch (e) {
                        log(`[ai-usage] /_server error: ${e}`);
                        resolve(null);
                    }
                });
        });
    },

    /* Local timezone offset as "+HH:MM" for the /_server request. */
    _tzOffset() {
        const off = -new Date().getTimezoneOffset();   // minutes east of UTC
        const sign = off >= 0 ? '+' : '-';
        const abs = Math.abs(off);
        return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
    },

    /* Parse the /_server response: extract all {date, model, totalCost}
     * records from the SSR stream. */
    _parseServerRecords(text) {
        const re = /date:"(\d{4}-\d{2}-\d{2})",model:"([^"]+)",totalCost:(\d+)/g;
        const out = [];
        let m;
        while ((m = re.exec(text)) !== null) {
            out.push({ date: m[1], model: m[2], totalCost: Number(m[3]) });
        }
        return out.length > 0 ? out : null;
    },

    /* Fetch this + previous calendar month from /_server, then build the
     * 30d stacked-by-model cost chart. */
    async _fetchAndPushCostCharts(session, workspaceId, authCookie, serverId, entries) {
        const now = new Date();
        const thisYear = now.getFullYear();
        const thisMonth = now.getMonth();   // 0-indexed

        // Previous month (may roll back a year).
        const prevDate = new Date(thisYear, thisMonth - 1, 1);
        const prevYear = prevDate.getFullYear();
        const prevMonth = prevDate.getMonth();

        const [cur, prev] = await Promise.all([
            this._postServer(session, workspaceId, authCookie, serverId, thisYear, thisMonth),
            this._postServer(session, workspaceId, authCookie, serverId, prevYear, prevMonth),
        ]);

        const allRecords = [...(prev || []), ...(cur || [])];
        if (allRecords.length === 0) return;

        const modelIndex = new Map();
        for (const r of allRecords) {
            if (!modelIndex.has(r.model)) {
                const idx = modelIndex.size;
                modelIndex.set(r.model, { name: r.model, color: modelColor(r.model, idx) });
            }
        }

        const chart30 = this._buildStackedCostChart(allRecords, modelIndex, 30, 'Cost by model (30d)');
        if (chart30) entries.push(chart30);
    },

    /* Build a stacked-by-model cost chart for the last `days` days. Each
     * calendar day = one bar; segments per model; value = totalCost. */
    _buildStackedCostChart(records, modelIndex, days, label) {
        const cutoff = Date.now() - days * 86400000;

        // Group records by date → model → cost.
        const byDate = new Map();
        for (const r of records) {
            const t = new Date(r.date + 'T00:00:00Z').getTime();
            if (t < cutoff) continue;
            if (!byDate.has(r.date)) byDate.set(r.date, new Map());
            const dm = byDate.get(r.date);
            dm.set(r.model, (dm.get(r.model) || 0) + r.totalCost);
        }
        if (byDate.size === 0) return null;

        // Sort dates ascending, build one bucket per day.
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

        // Per-model totals for the legend (sum over the window).
        const legendTotals = new Map();
        for (const r of records) {
            const t = new Date(r.date + 'T00:00:00Z').getTime();
            if (t < cutoff) continue;
            legendTotals.set(r.model, (legendTotals.get(r.model) || 0) + r.totalCost);
        }
        const legend = [];
        for (const [name, info] of modelIndex) {
            const total = legendTotals.get(name) || 0;
            if (total > 0) legend.push({ name, color: info.color, total });
        }
        legend.sort((a, b) => b.total - a.total);

        return {
            kind: 'stackedbarchart', name: `OpenCode Go ${days}d`,
            group: 'OpenCode Go', label, buckets, legend,
            granularity: 'daily', unit: 'cost',
        };
    },

    /* POST /_server with the getUsageInfo server function to fetch one page
     * of 50 per-request usage records. Returns [{time, model, cost}] or null.
     * `serverId` is the getUsageInfo x-server-id. */
    async _postGetUsageInfo(session, workspaceId, authCookie, serverId, cursor) {
        const body = JSON.stringify({
            t: {
                t: 9, i: 0, l: 2,
                a: [
                    { t: 1, s: workspaceId },
                    { t: 0, s: cursor },
                ],
                o: 0,
            },
            f: 31,
            m: [],
        });

        return new Promise((resolve) => {
            const msg = Soup.Message.new('POST', `${BASE}/_server`);
            msg.get_request_headers().append('User-Agent', USER_AGENT);
            msg.get_request_headers().append('Content-Type', 'application/json');
            msg.get_request_headers().append('Accept', '*/*');
            msg.get_request_headers().append('Cookie', `auth=${authCookie}; oc_locale=en`);
            msg.get_request_headers().append('x-server-id', serverId);
            msg.get_request_headers().append('x-server-instance', 'server-fn:4');
            msg.get_request_headers().append('Origin', BASE);
            msg.get_request_headers().append('Referer', `${BASE}/workspace/${workspaceId}/usage`);

            const bytes = new TextEncoder().encode(body);
            msg.set_request_body_from_bytes('application/json',
                GLib.Bytes.new(bytes));

            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null,
                (s, res) => {
                    try {
                        const respBytes = s.send_and_read_finish(res);
                        if (msg.get_status() !== 200) { resolve(null); return; }
                        const text = new TextDecoder().decode(
                            respBytes?.get_data() ?? new Uint8Array(0));
                        resolve(this._parseUsageRecords(text));
                    } catch (e) {
                        log(`[ai-usage] getUsageInfo error: ${e}`);
                        resolve(null);
                    }
                });
        });
    },

    /* Parse per-request records from a getUsageInfo SSR response. Returns
     * [{time, model, cost}] aligned by index, newest first. */
    _parseUsageRecords(text) {
        const times = [];
        const models = [];
        const costs = [];
        let m;
        const timeRe = /timeCreated:\$R\[\d+\]=new Date\("([^"]+)"\)/g;
        while ((m = timeRe.exec(text)) !== null) times.push(m[1]);
        const modelRe = /model:"([^"]+)"/g;
        while ((m = modelRe.exec(text)) !== null) models.push(m[1]);
        const costRe = /cost:(\d+)/g;
        while ((m = costRe.exec(text)) !== null) costs.push(Number(m[1]));

        const count = Math.min(times.length, models.length, costs.length);
        if (count === 0) return null;
        const out = [];
        for (let i = 0; i < count; i++)
            out.push({ time: times[i], model: models[i], cost: costs[i] });
        return out;
    },

    /* Page through getUsageInfo to collect recent per-request records, then
     * build a horizontal cost-distribution-by-model bar (last 300 requests).
     * Each model's share of the total cost = its segment width. */
    async _buildCostDistribution(session, workspaceId, authCookie, serverId) {
        // Page until empty (50/page), a short page (last page), or a hard cap
        // of 500 records (10 pages) to bound latency.
        const all = [];
        const MAX_RECORDS = 500;
        for (let cursor = 0; cursor < MAX_RECORDS; cursor += 50) {
            const page = await this._postGetUsageInfo(
                session, workspaceId, authCookie, serverId, cursor);
            if (!page || page.length === 0) break;
            all.push(...page);
            if (page.length < 50) break;   // last page
            if (all.length >= MAX_RECORDS) break;
        }
        if (all.length === 0) return null;

        // Aggregate cost by model, preserving discovery order for colors.
        const modelOrder = [];
        const modelCost = new Map();
        for (const r of all) {
            if (!modelCost.has(r.model)) {
                modelCost.set(r.model, 0);
                modelOrder.push(r.model);
            }
            modelCost.set(r.model, modelCost.get(r.model) + r.cost);
        }
        const totalCost = [...modelCost.values()].reduce((s, v) => s + v, 0);
        if (totalCost === 0) return null;

        // Build segments sorted by cost descending (biggest model leftmost).
        const segments = modelOrder
            .map((name, i) => ({
                model: name,
                color: modelColor(name, i),
                value: modelCost.get(name),
            }))
            .sort((a, b) => b.value - a.value);

        const legend = segments.map(s => ({
            name: s.model, color: s.color, total: s.value,
        }));

        return {
            kind: 'costdistribution', name: 'OpenCode Go Cost Dist',
            group: 'OpenCode Go',
            label: `Cost distribution (last ${all.length} calls)`,
            segments, legend, totalCost, unit: 'cost',
        };
    },

    /* Rolling-50 chart: each bar = one recent call, height = its cost,
     * color = its model. Records arrive in SSR with the newest first. */
    _buildRollingModelChart(html) {
        // Each per-request record inlines: model:"X", ..., cost:N, ...
        // paired with timeCreated:$R[..]=new Date("ISO"). Extract all three
        // in stream order (newest first).
        const records = [];
        const recRe = /model:"([^"]+)"[\s\S]{0,400}?cost:(\d+)/g;
        const timeRe = /timeCreated:\$R\[\d+\]=new Date\("([^"]+)"\)/g;

        const models = [];
        const costs = [];
        let m;
        while ((m = recRe.exec(html)) !== null) {
            models.push(m[1]);
            costs.push(Number(m[2]));
        }
        const times = [];
        while ((m = timeRe.exec(html)) !== null)
            times.push(new Date(m[1]).getTime());

        if (models.length === 0 || costs.length === 0) return null;

        // The /usage page already returns the 50 most recent records. Pair
        // by index (they appear in the same order in the SSR stream).
        const count = Math.min(models.length, costs.length);
        if (count === 0) return null;

        // Register models for consistent colors (discovery order).
        const modelIndex = new Map();
        for (const name of models) {
            if (!modelIndex.has(name)) {
                const idx = modelIndex.size;
                modelIndex.set(name, modelColor(name, idx));
            }
        }

        // Take the 50 most recent. Records on the /usage page are newest-first;
        // we render left=oldest, right=newest.
        const take = Math.min(50, count);
        const startIdx = count - take;
        const bars = [];
        for (let i = startIdx; i < count; i++) {
            bars.push({
                value: costs[i],
                color: modelIndex.get(models[i]),
                label: '',
            });
        }
        if (bars.length === 0) return null;

        // Legend: every model seen, no totals (each bar is a single call).
        const legend = [...modelIndex.entries()].map(([name, color]) => ({
            name, color, total: null,
        }));

        return {
            kind: 'barchart', name: 'OpenCode Go Recent',
            group: 'OpenCode Go', label: `Recent ${bars.length} calls (by cost)`,
            bars, legend, granularity: 'calls', unit: 'cost',
        };
    },

    _parseSSR(body) {
        const entries = [];
        const now = Date.now();

        const extract = (name) => {
            const re = new RegExp(`${name}:\\$R\\[\\d+\\]=\\{[^}]*\\}`);
            const match = body.match(re);
            if (!match) return null;

            const usageMatch = match[0].match(/usagePercent:(\d+(?:\.\d+)?)/);
            const resetMatch = match[0].match(/resetInSec:(\d+)/);
            if (!usageMatch || !resetMatch) return null;

            return {
                usagePercent: Number(usageMatch[1]),
                resetInSec: Number(resetMatch[1]),
            };
        };

        const rolling = extract('rollingUsage');
        const weekly = extract('weeklyUsage');
        const monthly = extract('monthlyUsage');

        if (rolling) {
            entries.push({
                kind: 'percent', name: 'OpenCode Go 5h', group: 'OpenCode Go',
                label: '5h:', percentUsed: rolling.usagePercent,
                percentRemaining: clamp(100 - rolling.usagePercent),
                resetTimeIso: new Date(now + rolling.resetInSec * 1000).toISOString(),
            });
        }
        if (weekly) {
            entries.push({
                kind: 'percent', name: 'OpenCode Go Weekly', group: 'OpenCode Go',
                label: 'Weekly:', percentUsed: weekly.usagePercent,
                percentRemaining: clamp(100 - weekly.usagePercent),
                resetTimeIso: new Date(now + weekly.resetInSec * 1000).toISOString(),
            });
        }
        if (monthly) {
            entries.push({
                kind: 'percent', name: 'OpenCode Go Monthly', group: 'OpenCode Go',
                label: 'Monthly:', percentUsed: monthly.usagePercent,
                percentRemaining: clamp(100 - monthly.usagePercent),
                resetTimeIso: new Date(now + monthly.resetInSec * 1000).toISOString(),
            });
        }

        if (entries.length === 0) {
            return { attempted: true, entries: [],
                errors: ['OpenCode Go: no usage data found in response'] };
        }

        return { attempted: true, entries, errors: [] };
    },
};
