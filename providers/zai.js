/* Z.AI (Zhipu AI / OpenCode Go) provider
 *
 * Endpoints:
 *   International: https://api.z.ai/api/monitor/usage/quota/limit
 *   China:         https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *
 * Auth: API key or OAuth token in Authorization header.
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import { MODEL_COLORS, modelColor } from './colors.js';
import { USER_AGENT } from './constants.js';
import { clamp, xLabelShort, httpGet } from './utils.js';

/* Z.AI: peak is 14:00–18:00 UTC+8, i.e. 06:00–10:00 UTC. */
const ZAI_PEAK_WINDOWS_UTC = [[6, 10]];

const ZAI_ENDPOINTS = {
    intl: {
        quota: 'https://api.z.ai/api/monitor/usage/quota/limit',
        modelUsage: 'https://api.z.ai/api/monitor/usage/model-usage',
        oauthInit: 'https://api.z.ai/oauth/cli/init',
        oauthPoll: 'https://api.z.ai/oauth/cli/poll',
    },
    cn: {
        quota: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
        modelUsage: 'https://open.bigmodel.cn/api/monitor/usage/model-usage',
        oauthInit: 'https://open.bigmodel.cn/oauth/cli/init',
        oauthPoll: 'https://open.bigmodel.cn/oauth/cli/poll',
    },
};

/* Format a Date as "YYYY-MM-DD HH:MM:SS" in the local timezone — the format
 * the model-usage endpoint expects for startTime/endTime. */
function fmtLocal(date) {
    const p = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
           `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/* Compact calls formatter for legend totals: 1234 → "1.2K calls". */
function fmtCalls(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K calls`;
    return `${n} calls`;
}

function getAuthHeaders(credentials) {
    const apiKey = credentials.apiKey;
    if (apiKey && apiKey.length > 0) {
        return { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT };
    }
    const oauthToken = credentials.oauthToken;
    if (oauthToken && oauthToken.length > 0) {
        return { 'Authorization': `Bearer ${oauthToken}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT };
    }
    return null;
}

export const zaiProvider = {
    id: 'zai',
    label: 'Z.AI',
    logoFile: 'zai-logo.svg',
    fullColorLogo: true,

    needsAuth(credentials) {
        return !!(credentials.apiKey || credentials.oauthToken);
    },

    getOAuthConfig(credentials) {
        const endpoint = credentials.endpoint || 'intl';
        const config = ZAI_ENDPOINTS[endpoint] || ZAI_ENDPOINTS.intl;
        return {
            initUrl: config.oauthInit,
            pollUrl: config.oauthPoll,
            provider: endpoint === 'cn' ? 'bigmodel' : 'zai',
        };
    },

    async fetch(session, credentials) {
        const headers = getAuthHeaders(credentials);
        if (!headers) return { attempted: false };

        const endpoint = credentials.endpoint || 'intl';
        const quotaUrl = ZAI_ENDPOINTS[endpoint]?.quota || ZAI_ENDPOINTS.intl.quota;

        try {
            const message = Soup.Message.new('GET', quotaUrl);
            for (const [key, value] of Object.entries(headers))
                message.get_request_headers().append(key, value);

            const result = await new Promise((resolve, reject) => {
                session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null,
                    (s, res) => {
                        try {
                            const bytes = s.send_and_read_finish(res);
                            const status = message.get_status();
                            const body = new TextDecoder().decode(
                                bytes?.get_data() ?? new Uint8Array(0));
                            resolve({ status, body });
                        } catch (e) { reject(e); }
                    });
            });

            if (result.status !== 200) {
                let errDetail = result.body?.substring(0, 200) || '';
                try { const j = JSON.parse(result.body); errDetail = j.message || j.error || errDetail; } catch (_) {}
                return { attempted: true, entries: [], errors: [`Z.AI HTTP ${result.status}: ${errDetail}`] };
            }

            return await this._parseResponse(JSON.parse(result.body), session, headers, endpoint);
        } catch (e) {
            return { attempted: true, entries: [], errors: [`Z.AI error: ${e.message || e}`] };
        }
    },

    /* GET a JSON endpoint using the same session/headers as the quota call.
     * Returns the parsed envelope {code,msg,data,success} or null on failure. */
    async _getJson(session, headers, url) {
        const body = await httpGet(session, url, headers);
        if (!body) return null;
        try { return JSON.parse(body); } catch (e) { return null; }
    },

    /* Fetch the model-usage time series and append three stacked-barchart
     * entries (last 24h / this week / this month) to `entries`. Failures are
     * non-fatal — the quota bars already pushed above still render. */
    async _fetchModelUsageCharts(session, headers, endpoint, entries, errors) {
        const modelUsageUrl = ZAI_ENDPOINTS[endpoint]?.modelUsage;
        if (!modelUsageUrl) return;

        // 24h: hourly (raw). 7d: hourly, then aggregated into 4-hour buckets
        // aligned to the peak-hours grid and colored red (peak 14–18 UTC+8) vs
        // green (off-peak). 30d: daily granularity.
        const now = new Date();
        const windows = [
            { key: '24h', days: 1,  forceDays: 1,  aggregateHours: 0, daily: false, label: 'Model usage (24h)' },
            { key: '7d',  days: 7,  forceDays: 7,  aggregateHours: 4, daily: false, label: 'Usage by hour (7d)', mode: 'peak' },
            { key: '30d', days: 30, forceDays: 30, aggregateHours: 0, daily: true,  label: 'Model usage (30d)' },
        ];

        const seen = new Set();
        const models = [];   // [{name, color}] in sortOrder

        for (const w of windows) {
            const start = new Date(now.getTime() - w.forceDays * 86400000);
            const granularity = w.daily ? '&granularity=daily' : '';
            const url = `${modelUsageUrl}?startTime=${encodeURIComponent(fmtLocal(start))}` +
                        `&endTime=${encodeURIComponent(fmtLocal(now))}${granularity}`;
            const env = await this._getJson(session, headers, url);
            if (!env || env.code !== 200 || !env.data) continue;

            const chart = w.mode === 'peak'
                ? this._buildPeakHoursChart(env.data, w)
                : this._buildStackedChart(env.data, w, models, seen);
            if (chart) entries.push(chart);
        }
    },

    /* Turn one model-usage response into a stacked-barchart entry. */
    _buildStackedChart(data, w, models, seen) {
        const xTime = data.x_time || [];
        const mdl = data.modelDataList || [];
        if (xTime.length === 0 || mdl.length === 0) return null;

        // Register any new models in stable sortOrder for consistent colors.
        mdl.sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99));
        for (const m of mdl) {
            if (!seen.has(m.modelName)) {
                seen.add(m.modelName);
                models.push({ name: m.modelName, color: modelColor(m.modelName, models.length) });
            }
        }

        // Build one bar per API time bucket. Each bar carries a per-model
        // value list aligned to `models[]`. Renderer stacks them.
        let buckets = [];
        for (let i = 0; i < xTime.length; i++) {
            const xLabel = (data.granularity === 'daily')
                ? xLabelShort(xTime[i])
                : xLabelHourly(xTime[i], i === 0);
            const segs = models.map(m => {
                const series = mdl.find(d => d.modelName === m.name);
                const v = series ? Number(series.tokensUsage[i]) || 0 : 0;
                return { model: m.name, color: m.color, value: v };
            });
            buckets.push({ label: xLabel, segments: segs });
        }

        // Aggregate hourly buckets into wider chunks (e.g. 4h for the 7d chart)
        // so 168 hourly points become 42 readable bars. Each chunk sums per-model
        // tokens and takes its label from the first hour in the group.
        if (w.aggregateHours > 0 && data.granularity === 'hourly' && buckets.length > 0) {
            const grouped = [];
            for (let i = 0; i < buckets.length; i += w.aggregateHours) {
                const group = buckets.slice(i, i + w.aggregateHours);
                if (group.length === 0) continue;
                const segs = group[0].segments.map((s, mi) => ({
                    model: s.model,
                    color: s.color,
                    value: group.reduce((sum, b) => sum + (b.segments[mi]?.value || 0), 0),
                }));
                grouped.push({ label: group[0].label, segments: segs });
            }
            buckets = grouped;
        }

        // Compact legend: "GLM-5.2 227.5M · GLM-4.6V 169" using per-model totals.
        const totals = data.totalUsage?.modelSummaryList || [];
        const totalTokens = (data.totalUsage?.totalTokensUsage) || 0;
        if (totalTokens === 0) return null;   // nothing used in this window
        const legend = models.map(m => {
            const t = totals.find(x => x.modelName === m.name);
            return { name: m.name, color: m.color, total: t ? t.totalTokens : 0 };
        });

        return {
            kind: 'stackedbarchart', name: `Z.AI ${w.key}`, group: 'Z.AI',
            label: w.label, buckets, legend, granularity: data.granularity || 'hourly',
            totalTokens,
        };
    },

    /* Build the 7d peak-hours chart: a single colored bar per 4-hour bucket
     * (all models summed), red for peak window 14–18 UTC+8, green otherwise.
     * No model breakdown. Buckets are aligned to the peak grid so the surcharge
     * window is exactly one bucket per day. */
    _buildPeakHoursChart(data, w) {
        const xTime = data.x_time || [];
        const callCount = data.modelCallCount || [];
        if (xTime.length === 0 || callCount.length === 0) return null;

        // Group consecutive hourly buckets into 4h chunks aligned to the peak
        // grid. The API's hourly series always starts on an hour, but not
        // necessarily on a peak-grid boundary (e.g. starts at 13:00 from a
        // 7-day-ago-same-instant fetch). We start a fresh bucket whenever the
        // current hour is a grid boundary (02/06/10/14/18/22), so peak windows
        // are always clean.
        const gridHours = new Set([2, 6, 10, 14, 18, 22]);
        const grouped = [];
        let current = null;
        for (let i = 0; i < xTime.length; i++) {
            const hr = hourOf(xTime[i]);
            // Start a new bucket at a grid hour, or when no bucket is open.
            if (!current || gridHours.has(hr)) {
                if (current) grouped.push(current);
                current = {
                    label: xLabelPeakBucket(xTime[i]),
                    startDate: xTime[i],
                    hour: hr,
                    totalCalls: 0,
                };
            }
            current.totalCalls += Number(callCount[i]) || 0;
        }
        if (current) grouped.push(current);

        // Build flat bars, each colored by whether its start hour is the peak.
        const bars = grouped.map(g => ({
            label: g.label,
            value: g.totalCalls,
            color: isPeakBucket(g.hour) ? PEAK_COLOR : OFFPEAK_COLOR,
        }));

        const totalCalls = grouped.reduce((s, g) => s + g.totalCalls, 0);
        if (totalCalls === 0) return null;

        // Peak vs off-peak split for the legend.
        let peakCalls = 0, offPeakCalls = 0;
        for (const g of grouped) {
            if (isPeakBucket(g.hour)) peakCalls += g.totalCalls;
            else offPeakCalls += g.totalCalls;
        }

        return {
            kind: 'peakbarchart', name: `Z.AI ${w.key}`, group: 'Z.AI',
            label: w.label, bars, granularity: 'peak',
            legend: [
                { color: PEAK_COLOR, label: `Peak 14–18 (UTC+8) ${fmtCalls(peakCalls)}` },
                { color: OFFPEAK_COLOR, label: `Off-peak ${fmtCalls(offPeakCalls)}` },
            ],
            totalCalls,
            peakCalls,
            offPeakCalls,
        };
    },

    async _parseResponse(data, session, headers, endpoint) {
        const entries = [];
        const errors = [];
        const limits = data?.data?.limits ?? data?.limits;

        // Peak-hours traffic-light. This is a "live" entry: the renderer
        // owns the countdown and ticks it every minute while the menu is
        // open, so no snapshot is stored here.
        entries.push({
            kind: 'peakstatus', name: 'Z.AI Peak', group: 'Z.AI',
            label: 'Peak hours',
            peakWindows: ZAI_PEAK_WINDOWS_UTC,
        });

        if (!limits || !Array.isArray(limits)) {
            // Check for top-level session utilization
            if (data?.sessionUtilization !== undefined || data?.session_utilization !== undefined) {
                const pct = data.sessionUtilization ?? data.session_utilization;
                entries.push({
                    kind: 'percent', name: 'Z.AI Session', group: 'Z.AI',
                    label: 'Session:', percentUsed: pct, percentRemaining: clamp(100 - pct),
                });
            }
            if (entries.length === 0) {
                // Still try model-usage charts before giving up entirely.
                if (session && headers && endpoint)
                    await this._fetchModelUsageCharts(session, headers, endpoint, entries, errors);
                if (entries.length === 0)
                    errors.push('Z.AI: unexpected response format');
                return { attempted: true, entries, errors };
            }
            if (session && headers && endpoint)
                await this._fetchModelUsageCharts(session, headers, endpoint, entries, errors);
            return { attempted: true, entries, errors };
        }

        const tokenLimits = limits
            .filter(l => l.type === 'TOKENS_LIMIT')
            .sort((a, b) => (a.unit ?? 99) - (b.unit ?? 99));

        const timeLimits = limits.filter(l => l.type === 'TIME_LIMIT');

        // Session utilization at top level
        const sessionPct = data?.sessionUtilization ?? data?.session_utilization;
        if (sessionPct !== undefined && sessionPct !== null) {
            entries.push({
                kind: 'percent', name: 'Z.AI Session', group: 'Z.AI',
                label: 'Session:', percentUsed: sessionPct,
                percentRemaining: clamp(100 - sessionPct),
            });
        }

        // Token limits: unit 3 = 5-hour, unit 6 = weekly
        for (const tl of tokenLimits) {
            const pct = tl.percentage ?? tl.usage ?? 0;
            const resetIso = tl.nextResetTime ? new Date(tl.nextResetTime).toISOString() : null;
            let name, label;
            if (tl.unit === 3) { name = 'Z.AI 5h'; label = '5h:'; }
            else if (tl.unit === 6) { name = 'Z.AI Weekly'; label = 'Weekly:'; }
            else { name = `Z.AI Tokens (u${tl.unit})`; label = `Tokens (u${tl.unit}):`; }

            entries.push({
                kind: 'percent', name, group: 'Z.AI', label,
                percentUsed: pct,
                percentRemaining: clamp(100 - pct),
                resetTimeIso: resetIso,
                remaining: tl.remaining ?? null,
            });
        }

        // Time limits — for Z.AI this is the MCP-tool usage window. The API
        // returns per-tool counts in `usageDetails` (search-prime, web-reader,
        // zread, …) which we surface as a parallel bar breakdown.
        for (const tl of timeLimits) {
            const pct = tl.percentage ?? tl.usage ?? 0;
            const resetIso = tl.nextResetTime ? new Date(tl.nextResetTime).toISOString() : null;

            const items = Array.isArray(tl.usageDetails)
                ? tl.usageDetails
                    .filter(d => d && d.modelCode)
                    .map(d => ({ label: d.modelCode, value: Number(d.usage) || 0 }))
                : [];
            const totalUsed = typeof tl.currentValue === 'number'
                ? tl.currentValue
                : items.reduce((s, d) => s + d.value, 0);

            entries.push({
                kind: 'percent', name: 'Z.AI MCP', group: 'Z.AI', label: 'MCP:',
                percentUsed: pct,
                percentRemaining: clamp(100 - pct),
                resetTimeIso: resetIso,
                remaining: tl.remaining ?? null,
                breakdown: items.length ? { total: totalUsed, items } : null,
            });
        }

        // Model-usage time-series charts (24h / 7d / 30d), color-coded per model.
        if (session && headers && endpoint)
            await this._fetchModelUsageCharts(session, headers, endpoint, entries, errors);

        return { attempted: true, entries, errors };
    },
};

/* Compact x-axis label helpers. The API returns strings like
 * "2026-07-04 14:00" (hourly) or "2026-07-04" (daily). The hourly labels are
 * in UTC+8 (Beijing) wall-clock time, which is what the peak-hours window is
 * expressed in. */
function xLabelHourly(s, firstInSeries) {
    const m = /(\d{2}):(\d{2})$/.exec(s);
    if (m) return `${m[1]}h`;
    return s;
}

/* Label for a 4h peak bucket in the 7d chart. Each day has 6 buckets, so we
 * show the day + the bucket's start hour (e.g. "28 14h"). For empty/sparse
 * days this keeps the buckets distinguishable across the 7-day span, unlike
 * plain xLabelHourly which would repeat "14h" every day. */
function xLabelPeakBucket(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):/.exec(s);
    if (!m) return xLabelHourly(s, true);
    return `${m[3]} ${m[4]}h`;   // DD HHh — e.g. "28 14h"
}

/* Extract the UTC+8 hour-of-day from an "YYYY-MM-DD HH:MM" label. */
function hourOf(s) {
    const m = /(\d{2}):\d{2}$/.exec(s);
    return m ? Number(m[1]) : -1;
}

/* Extract the date portion "YYYY-MM-DD" from an API time label. */
function dateOf(s) {
    return s.substring(0, 10);
}

/* Z.AI charges extra during peak hours 14:00–18:00 UTC+8. Off-peak is cheaper.
 * These colors highlight which 4-hour buckets fall in the peak window. */
const PEAK_COLOR = '#e01b24';     // red — peak surcharge window
const OFFPEAK_COLOR = '#26a269';  // green — off-peak

/* Z.AI's peak window is 14:00–18:00 UTC+8. The 4h-bucket chart for the 7d view
 * colors each bucket by whether its start hour (UTC+8) is the peak start. */
const PEAK_START_HOUR_UTC8 = 14;

/* Compute the aligned 4h bucket-start hour (UTC+8) for a given hour, so the
 * peak window 14–18 is exactly one clean bucket per day. Boundaries fall at
 * 02 / 06 / 10 / 14 / 18 / 22. A bucket is "peak" iff it starts at 14. */
function bucketStartHour(hour) {
    const offset = (((hour - PEAK_START_HOUR_UTC8) % 4) + 4) % 4;
    return hour - offset;
}
function isPeakBucket(bucketStart) {
    return bucketStart === PEAK_START_HOUR_UTC8;
}