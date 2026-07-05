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

const PAGE = 50;          // getUsageInfo returns 50 records per page.
const MAX_RECORDS = 5000; // aggregate cost/token distribution over the last 5000 calls.

export const opencodeGoProvider = {
    id: 'opencode-go',
    label: 'OpenCode Go',
    logoFile: 'opencode-logo.svg',
    fullColorLogo: true,

    needsAuth(credentials) {
        return !!(credentials.workspaceId && credentials.authCookie);
    },

    async fetch(session, credentials, callbacks = {}) {
        const workspaceId = credentials.workspaceId;
        const authCookie = credentials.authCookie;
        const ws = this._wsState(workspaceId);

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
                        if (dist) {
                            result.entries.push(dist);
                            const tokenMix = this._buildTokenBreakdown(
                                ws._costDistCache?.records || []);
                            if (tokenMix) {
                                result.entries.push(tokenMix);
                                ws._tokenMixEntry = tokenMix;   // phase 2 mutates this in place
                            }
                            // Launch background phase 2 (deep pagination +
                            // progressive re-renders). Fire-and-forget: must
                            // NOT be awaited, so the panel renders phase 1 now.
                            this._continueCostFetch(
                                session, workspaceId, authCookie, inferred.getUsageInfo,
                                callbacks, callbacks?.costDistMinInterval ?? 0
                            ).catch(e => log(`[ai-usage] cost-dist phase 2 failed: ${e}`));
                        }
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
            // The bundle defines TWO getUsageInfo-shaped functions:
            //   getUsageInfo_query = "<hash>"  → SSR initial-page loader, ignores
            //                                   the page param (always page 0).
            //   getUsageInfo_1     = "<hash>"  → the real paginating function
            //                                   (bundler numeric suffix).
            // Match only the real one: `getUsageInfo` optionally followed by a
            // numeric disambiguator (`_1`, `_2`…), never a `_query`-style name.
            const serverFnRe = (name) => new RegExp(
                `${name}(?:_\\d+)?\\s*=\\s*createServerReference\\("([0-9a-f]{64})"\\)`);
            const ids = { getCosts: null, getUsageInfo: null };
            for (const chunk of chunkNames) {
                if (ids.getCosts && ids.getUsageInfo) break;
                const body = await this._get(session,
                    `${BASE}/_build/assets/${chunk}`, authCookie);
                if (!body) continue;
                if (!ids.getCosts) {
                    const m = body.match(serverFnRe('getCosts'));
                    if (m) ids.getCosts = m[1];
                }
                if (!ids.getUsageInfo) {
                    const m = body.match(serverFnRe('getUsageInfo'));
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
            const msg = Soup.Message.new('POST', `${BASE}/_server?_t=${Date.now()}`);
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

    /* Per-workspace state bucket.  Because the provider object is a singleton
     * shared by all OpenCode Go accounts, we must key mutable fetch state by
     * workspaceId so that concurrent / overlapping fetches don't trample each
     * other's cache, cancellation tokens, or background promises. */
    _wsState(workspaceId) {
        if (!this.__ws) this.__ws = {};
        if (!this.__ws[workspaceId]) this.__ws[workspaceId] = {};
        return this.__ws[workspaceId];
    },

    /* Copy cost-distribution / token-mix entry fields from src to dst.
     * Explicit property assignment is more reliable than Object.assign in
     * GJS when the destination is referenced by active menu widgets. */
    _copyEntryFields(dst, src) {
        log(`[ai-usage] _copyEntryFields BEFORE: dst.label="${dst.label}" dst.segments.length=${dst.segments?.length||0} models=[${(dst.segments||[]).map(s=>s.model).join(',')}]`);
        dst.label = src.label;
        dst.segments = src.segments;
        dst.legend = src.legend;
        dst.totalCost = src.totalCost;
        dst.unit = src.unit;
        log(`[ai-usage] _copyEntryFields AFTER:  dst.label="${dst.label}" dst.segments.length=${dst.segments?.length||0} models=[${(dst.segments||[]).map(s=>s.model).join(',')}]`);
    },

    /* POST /_server with the getUsageInfo server function to fetch one page
     * of 50 per-request usage records. Returns [{model, cost, …}] or null.
     * `serverId` is the getUsageInfo x-server-id, `page` is the page number
     * (0-based).  Assigns a unique server-fn per call to avoid SSR caching
     * collisions with the dashboard client. */
    async _postGetUsageInfo(session, workspaceId, authCookie, serverId, page) {
        const serverFn = 3 + page;
        const body = JSON.stringify({
            t: {
                t: 9, i: 0, l: 2,
                a: [
                    { t: 1, s: workspaceId },
                    { t: 0, s: page },
                ],
                o: 0,
            },
            f: 31,
            m: [],
        });

        return new Promise((resolve) => {
            const msg = Soup.Message.new('POST', `${BASE}/_server?_t=${serverFn}`);
            msg.get_request_headers().append('User-Agent', USER_AGENT);
            msg.get_request_headers().append('Content-Type', 'application/json');
            msg.get_request_headers().append('Accept', '*/*');
            msg.get_request_headers().append('Cookie', `auth=${authCookie}; oc_locale=en`);
            msg.get_request_headers().append('x-server-id', serverId);
            msg.get_request_headers().append('x-server-instance', `server-fn:${serverFn}`);
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

    /* Parse per-request records from a getUsageInfo SSR response.
     *
     * The response is a SolidJS SSR stream.  Each record is a complete
     * JavaScript object literal bounded by $R[N]={id:"…" … enrichment:$R[M]={…}}.
     * We match each record whole, then extract fields with simple regex —
     * avoiding `new Function` (which may be restricted in GJS).
     *
     * `id` is the unique per-request key used for dedup across pages/refreshes
     * (model+cost collides and drops real records). `timeMs` orders records so
     * we can keep the newest MAX_RECORDS when a refresh interleaves new calls
     * with cached history. */
    _parseUsageRecords(text) {
        const recRe = /\$R\[\d+\]=\{id:"[^"]+",[\s\S]+?enrichment:\$R\[\d+\]=\{plan:"[^"]*"\}\}/g;
        const matches = text.match(recRe);
        if (!matches) return null;

        const records = [];
        for (const match of matches) {
            // timeCreated ISO lives inside new Date("…") — extract before we
            // strip it below.
            const timeIso = (match.match(/timeCreated:\$R\[\d+\]=new Date\("([^"]+)"\)/) || [])[1];

            // Strip SSR artefacts so field regexes don't pick up $R refs.
            const clean = match
                .replace(/\$R\[\d+\]=/g, '')
                .replace(/new Date\("[^"]*"\)/g, 'null');

            const id = (clean.match(/id:"([^"]+)"/) || [])[1];
            const model = (clean.match(/model:"([^"]+)"/) || [])[1];
            if (!model) continue;

            const cost = parseInt((clean.match(/cost:(\d+)/) || [])[1]) || 0;
            const inputTokens = parseInt((clean.match(/inputTokens:(\d+)/) || [])[1]) || 0;
            const outputTokens = parseInt((clean.match(/outputTokens:(\d+)/) || [])[1]) || 0;
            const reasoningTokens = parseInt((clean.match(/reasoningTokens:(\d+)/) || [])[1]) || 0;
            const cacheReadTokens = parseInt((clean.match(/cacheReadTokens:(\d+)/) || [])[1]) || 0;
            const cw5m = (clean.match(/cacheWrite5mTokens:(\d+)/) || [])[1];
            const cw1h = (clean.match(/cacheWrite1hTokens:(\d+)/) || [])[1];
            const cacheWrite5mTokens = cw5m ? parseInt(cw5m) : 0;
            const cacheWrite1hTokens = cw1h ? parseInt(cw1h) : 0;

            records.push({
                id, model, cost, inputTokens, outputTokens, reasoningTokens,
                cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens,
                timeMs: timeIso ? new Date(timeIso).getTime() : 0,
            });
        }
        return records.length > 0 ? records : null;
    },

    /* Return the newest MAX_RECORDS records, sorted newest-first. Dedup is
     * already applied upstream (by id); this only caps + orders for display. */
    _capRecords(records) {
        if (!records || records.length === 0) return [];
        const sorted = records.slice().sort((a, b) => (b.timeMs || 0) - (a.timeMs || 0));
        return sorted.slice(0, MAX_RECORDS);
    },

    /* Build the cost-distribution entry from a record set: aggregate cost by
     * model (sorted desc), with segments + legend. Pure — used by both phases. */
    _buildCostEntry(records) {
        const capped = this._capRecords(records);
        if (capped.length === 0) return null;

        const modelOrder = [];
        const modelCost = new Map();
        for (const r of capped) {
            if (!modelCost.has(r.model)) {
                modelCost.set(r.model, 0);
                modelOrder.push(r.model);
            }
            modelCost.set(r.model, modelCost.get(r.model) + r.cost);
        }
        const totalCost = [...modelCost.values()].reduce((s, v) => s + v, 0);
        if (totalCost === 0) return null;

        const segments = modelOrder
            .map((name, i) => ({ model: name, color: modelColor(name, i), value: modelCost.get(name) }))
            .sort((a, b) => b.value - a.value);

        const legend = segments.map(s => ({ name: s.model, color: s.color, total: s.value }));

        return {
            kind: 'costdistribution', name: 'OpenCode Go Cost Dist',
            group: 'OpenCode Go',
            label: `Cost distribution (last ${capped.length} calls)`,
            segments, legend, totalCost, unit: 'cost',
        };
    },

    /* Phase 1 (synchronous, fast): seed from cache, fetch ONLY page 0 to catch
     * new calls since the last refresh, build the entry, and return it so the
     * panel renders immediately. The deep pagination happens in phase 2
     * (_continueCostFetch), launched fire-and-forget by fetch().
     *
     * Dedup is by record `id` (unique per request) — never model+cost, which
     * collides and silently drops real records. */
    async _buildCostDistribution(session, workspaceId, authCookie, serverId) {
        const ws = this._wsState(workspaceId);

        // Abort any still-running phase-2 continuation from a prior refresh.
        ws._costDistCancelToken = (ws._costDistCancelToken || 0) + 1;

        const all = ws._costDistCache?.records ? ws._costDistCache.records.slice() : [];
        const ids = new Set(all.map(r => r.id));

        // Page 0 = newest 50. Prepend any records we haven't seen (new calls).
        const p0 = await this._postGetUsageInfo(session, workspaceId, authCookie, serverId, 0);
        if (p0) {
            const fresh = [];
            for (const r of p0) {
                if (r && r.id && !ids.has(r.id)) {
                    fresh.push(r);
                    ids.add(r.id);
                }
            }
            if (fresh.length) {
                all.unshift(...fresh);
                log(`[ai-usage] cost-dist phase 1: +${fresh.length} new call(s) on page 0`);
            }
        }

        ws._costDistCache = { records: all };

        const entry = this._buildCostEntry(all);
        if (!entry) return null;
        ws._costDistEntry = entry;
        log(`[ai-usage] cost-dist phase 1 done: ${all.length} records cached, ${entry.segments.length} model(s)`);
        return entry;
    },

    /* Phase 2 (background, progressive): page forward from page 1, id-deduping,
     * until we either (a) hit a page that adds nothing new — meaning we've
     * reached previously-fetched history ("caught up"), (b) hit a short/empty
     * page — the natural end of history, or (c) reach the MAX_RECORDS depth.
     * After every UPDATE_EVERY new records (and once at the end), rebuild the
     * cost-dist + token-mix entries in place and call callbacks.onCostDistUpdate
     * so the panel re-renders with the growing dataset ("continuous updates").
     *
     * Because this starts at page 1, a truncated cache (e.g. only page 0 from
     * a prior failed run) self-heals: page 1's ids aren't cached, so it pages
     * forward and recovers the full history instead of locking at 50.
     *
     * Throttled by costDistMinInterval: skip if phase 2 completed recently. */
    async _continueCostFetch(session, workspaceId, authCookie, serverId,
                              callbacks = {}, costDistMinInterval = 0) {
        const ws = this._wsState(workspaceId);
        const now = Date.now();
        if (ws._costDistLastFullMs &&
            now - ws._costDistLastFullMs < costDistMinInterval * 1000) {
            log(`[ai-usage] cost-dist phase 2: throttled (last full fetch ${Math.round((now - ws._costDistLastFullMs) / 1000)}s ago)`);
            return;
        }

        const cancelToken = ws._costDistCancelToken;
        const all = ws._costDistCache?.records ? ws._costDistCache.records : [];
        const ids = new Set(all.map(r => r.id));
        const UPDATE_EVERY = 500;
        let addedSinceUpdate = 0;

        // Hard stop: never page past MAX_RECORDS / PAGE pages of history.
        const MAX_PAGE = Math.ceil(MAX_RECORDS / PAGE);
        log(`[ai-usage] cost-dist phase 2: resuming at page 1 (cached=${all.length})`);

        const pushNew = (records) => {
            let added = 0;
            for (const r of records) {
                if (r && r.id && !ids.has(r.id)) {
                    all.push(r);
                    ids.add(r.id);
                    added++;
                }
            }
            return added;
        };

        const render = () => {
            ws._costDistCache = { records: all };
            if (ws._costDistEntry) {
                const e = this._buildCostEntry(all);
                if (e) this._copyEntryFields(ws._costDistEntry, e);
            }
            if (ws._tokenMixEntry) {
                const tm = this._buildTokenBreakdown(all);
                if (tm) this._copyEntryFields(ws._tokenMixEntry, tm);
            }
            if (callbacks.onCostDistUpdate) {
                try { callbacks.onCostDistUpdate(); } catch (e) { log(`[ai-usage] onCostDistUpdate threw: ${e}`); }
            }
        };

        for (let pg = 1; pg <= MAX_PAGE; pg++) {
            if (ws._costDistCancelToken !== cancelToken) {
                log('[ai-usage] cost-dist phase 2: cancelled by newer fetch');
                return;
            }
            const p = await this._postGetUsageInfo(
                session, workspaceId, authCookie, serverId, pg);
            if (!p || p.length === 0) {
                log(`[ai-usage] cost-dist phase 2 page ${pg}: ${p ? p.length : 'null'} — natural end`);
                break;
            }
            const added = pushNew(p);
            if (p.length < PAGE) {
                log(`[ai-usage] cost-dist phase 2 page ${pg}: short page (${p.length}) — natural end`);
                break;
            }
            if (added === 0) {
                // Full page of already-known ids → reached cached history.
                log(`[ai-usage] cost-dist phase 2 page ${pg}: caught up (0 new)`);
                break;
            }
            addedSinceUpdate += added;
            if (addedSinceUpdate >= UPDATE_EVERY) {
                addedSinceUpdate = 0;
                log(`[ai-usage] cost-dist phase 2 progress: ${all.length} records`);
                render();
            }
        }

        if (ws._costDistCancelToken !== cancelToken) return;

        // Trim to the newest MAX_RECORDS so the cache can't grow unbounded
        // across refreshes, then render the final state.
        if (all.length > MAX_RECORDS) {
            const trimmed = this._capRecords(all);
            all.length = 0;
            all.push(...trimmed);
        }
        ws._costDistLastFullMs = Date.now();
        render();
        log(`[ai-usage] cost-dist phase 2 done: ${all.length} records`);
    },

    /* Build a horizontal segmented bar showing token-type breakdown across
     * all fetched per-request records. Includes cache-write segments only
     * when they contain data (both 0 → excluded from legend). */
    _buildTokenBreakdown(records) {
        const capped = this._capRecords(records);
        if (capped.length === 0) return null;

        let inputSum = 0, outputSum = 0, reasoningSum = 0,
            cacheReadSum = 0, cacheWrite5mSum = 0, cacheWrite1hSum = 0;
        for (const r of capped) {
            inputSum += r.inputTokens || 0;
            outputSum += r.outputTokens || 0;
            reasoningSum += r.reasoningTokens || 0;
            cacheReadSum += r.cacheReadTokens || 0;
            cacheWrite5mSum += r.cacheWrite5mTokens || 0;
            cacheWrite1hSum += r.cacheWrite1hTokens || 0;
        }

        const TOKEN_COLORS = {
            Input: '#3584e4',
            Output: '#26a269',
            Reasoning: '#9141ac',
            'Cache read': '#ff7800',
            'Cache write 5m': '#f6d32d',
            'Cache write 1h': '#e5a50a',
        };

        const raw = [
            { model: 'Input', color: TOKEN_COLORS['Input'], value: inputSum },
            { model: 'Output', color: TOKEN_COLORS['Output'], value: outputSum },
            { model: 'Reasoning', color: TOKEN_COLORS['Reasoning'], value: reasoningSum },
            { model: 'Cache read', color: TOKEN_COLORS['Cache read'], value: cacheReadSum },
            { model: 'Cache write 5m', color: TOKEN_COLORS['Cache write 5m'], value: cacheWrite5mSum },
            { model: 'Cache write 1h', color: TOKEN_COLORS['Cache write 1h'], value: cacheWrite1hSum },
        ];

        // Drop cache-write entries only when both are zero.
        const showCacheWrite = cacheWrite5mSum > 0 || cacheWrite1hSum > 0;
        const segments = raw
            .filter(s => s.value > 0)
            .filter(s => showCacheWrite || (!s.model.startsWith('Cache write')))
            .sort((a, b) => b.value - a.value);

        const total = segments.reduce((s, seg) => s + seg.value, 0);
        if (total === 0) return null;

        const legend = segments.map(s => ({
            name: s.model, color: s.color, total: s.value,
        }));

        log(`[ai-usage] token-mix built: ${capped.length} records, total=${total} tokens, types=${JSON.stringify(segments.map(s => s.model))}`);
        return {
            kind: 'costdistribution', name: 'OpenCode Go Token Mix',
            group: 'OpenCode Go',
            label: `Token mix (last ${capped.length} calls)`,
            segments, legend, totalCost: total, unit: 'tokens',
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
