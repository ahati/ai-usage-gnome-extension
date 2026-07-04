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

/* 32-color preset for model series. Assigned by index in sortOrder, so the
 * same model gets the same color across the 24h / 30d charts within a session.
 * Tuned for distinguishability on a dark popup background. */
const MODEL_COLORS = [
    '#3584e4', // 1  blue
    '#9141ac', // 2  purple
    '#26a269', // 3  teal
    '#e01b24', // 4  red
    '#986a44', // 5  brown
    '#f6d32d', // 6  yellow
    '#ff7800', // 7  orange
    '#33d17a', // 8  light green
    '#1c71d8', // 9  darker blue
    '#813d9c', // 10 dark purple
    '#1a5fb4', // 11 navy
    '#c01c28', // 12 dark red
    '#7a8c2e', // 13 olive
    '#e5a50a', // 14 amber
    '#ed333b', // 15 bright red
    '#62a0ea', // 16 light blue
    '#c8557e', // 17 pink
    '#5e8a4e', // 18 forest green
    '#d48b3a', // 19 tan
    '#4a86b8', // 20 steel blue
    '#b161c4', // 21 light purple
    '#2e859a', // 22 cyan
    '#c04a6c', // 23 rose
    '#8a6d3b', // 24 dark tan
    '#5f3c8e', // 25 indigo
    '#3a8f5f', // 26 emerald
    '#b8542a', // 27 rust
    '#6987c4', // 28 periwinkle
    '#a04668', // 29 maroon
    '#4d6b8a', // 30 slate
    '#9c6b3f', // 31 copper
    '#5a7d3a', // 32 moss
];

function modelColor(modelName, index) {
    return MODEL_COLORS[index % MODEL_COLORS.length];
}

/* Format a Date as "YYYY-MM-DD HH:MM:SS" in the local timezone — the format
 * the model-usage endpoint expects for startTime/endTime. */
function fmtLocal(date) {
    const p = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
           `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function clampPercent(val) {
    return Math.max(0, Math.min(100, val));
}

/* Compact calls formatter for legend totals: 1234 → "1.2K calls". */
function fmtCalls(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K calls`;
    return `${n} calls`;
}

function getAuthHeaders(credentials) {
    const apiKey = credentials.apiKey;
    if (apiKey && apiKey.length > 0) {
        return { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    }
    const oauthToken = credentials.oauthToken;
    if (oauthToken && oauthToken.length > 0) {
        return { 'Authorization': `Bearer ${oauthToken}`, 'Content-Type': 'application/json' };
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
        try {
            const message = Soup.Message.new('GET', url);
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
            if (result.status !== 200) return null;
            return JSON.parse(result.body);
        } catch (e) {
            return null;
        }
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
                ? xLabelDaily(xTime[i])
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
                    label: xLabelHourly(xTime[i], true),
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
        });

        if (!limits || !Array.isArray(limits)) {
            // Check for top-level session utilization
            if (data?.sessionUtilization !== undefined || data?.session_utilization !== undefined) {
                const pct = data.sessionUtilization ?? data.session_utilization;
                entries.push({
                    kind: 'percent', name: 'Z.AI Session', group: 'Z.AI',
                    label: 'Session:', percentUsed: pct, percentRemaining: clampPercent(100 - pct),
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
            .sort((a, b) => (a.nextResetTime ?? Infinity) - (b.nextResetTime ?? Infinity));

        const timeLimits = limits.filter(l => l.type === 'TIME_LIMIT');

        // Session utilization at top level
        const sessionPct = data?.sessionUtilization ?? data?.session_utilization;
        if (sessionPct !== undefined && sessionPct !== null) {
            entries.push({
                kind: 'percent', name: 'Z.AI Session', group: 'Z.AI',
                label: 'Session:', percentUsed: sessionPct,
                percentRemaining: clampPercent(100 - sessionPct),
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
                percentRemaining: clampPercent(100 - pct),
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
                percentRemaining: clampPercent(100 - pct),
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

function xLabelDaily(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return s;
    return `${m[2]}/${m[3]}`;   // MM/DD — short for the dense 30-bar chart
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

const PEAK_START_HOUR = 14;       // UTC+8 hour
const PEAK_END_HOUR   = 18;       // UTC+8 hour (exclusive)

/* Compute the aligned 4h bucket-start hour (UTC+8) for a given hour, so the
 * peak window 14–18 is exactly one clean bucket per day. Boundaries fall at
 * 02 / 06 / 10 / 14 / 18 / 22. A bucket is "peak" iff it starts at 14. */
function bucketStartHour(hour) {
    const offset = (((hour - 14) % 4) + 4) % 4;
    return hour - offset;
}
function isPeakBucket(bucketStart) {
    return bucketStart === 14;
}

/* Current peak status at "now": whether we're in the peak window and ms
 * remaining until the next state change (peak→off or off→peak). The menu
 * uses this for the traffic-light indicator + live countdown.
 *
 * The countdown is computed against UTC+8 wall-clock time so it matches the
 * Z.AI billing schedule regardless of the user's local timezone. */
export function currentPeakStatus(now = new Date()) {
    // Wall-clock UTC+8 time.
    const utc8Ms = now.getTime() + 8 * 3600000;
    const d = new Date(utc8Ms);
    const hour = d.getUTCHours();
    const min = d.getUTCMinutes();
    const sec = d.getUTCSeconds();
    // Fractional hour within the UTC+8 day.
    const fracHour = hour + min / 60 + sec / 3600;

    const inPeak = fracHour >= PEAK_START_HOUR && fracHour < PEAK_END_HOUR;
    let msToChange;
    if (inPeak) {
        // Peak ends at 18:00.
        msToChange = (PEAK_END_HOUR - fracHour) * 3600000;
    } else if (fracHour < PEAK_START_HOUR) {
        // Before peak today: time until 14:00.
        msToChange = (PEAK_START_HOUR - fracHour) * 3600000;
    } else {
        // After peak today: time until 14:00 tomorrow.
        msToChange = (24 + PEAK_START_HOUR - fracHour) * 3600000;
    }
    return { inPeak, msToChange: Math.max(0, Math.round(msToChange)) };
}