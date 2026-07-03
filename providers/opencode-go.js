/* OpenCode Go provider
 *
 * Loads the SSR-rendered dashboard page:
 *   GET https://opencode.ai/workspace/{id}/go
 *
 * The page inlines the usage data in a SolidJS hydration stream
 * (rollingUsage:$R[..]={usagePercent,resetInSec} etc.), which we parse
 * directly — no separate _server call is needed.
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';

const BASE = 'https://opencode.ai';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

function clampPercent(val) {
    return Math.max(0, Math.min(100, val));
}

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
            // The /go dashboard page is server-side rendered with the usage
            // data inlined (SolidJS hydration stream: rollingUsage:$R[..]=...
            // and weekly/monthly equivalents). No separate _server call needed.
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

            // Also fetch the /usage page which has per-request usage records
            // inlined in the SSR stream — use them to render a bar chart.
            try {
                const usageUrl = `${BASE}/workspace/${encodeURIComponent(workspaceId)}/usage`;
                const usageHtml = await this._get(session, usageUrl, authCookie);
                if (usageHtml) {
                    const usageBars = this._parseUsageRecords(usageHtml);
                    if (usageBars)
                        result.entries.push(usageBars);
                }
            } catch (e) {
                // Bar chart is optional — don't fail the whole fetch.
                log(`[ai-usage] OpenCode Go usage bars failed: ${e}`);
            }

            return result;
        } catch (e) {
            return { attempted: true, entries: [],
                errors: [`OpenCode Go: ${e.message || e}`] };
        }
    },

    async _get(session, url, authCookie) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('GET', url);
            msg.get_request_headers().append('User-Agent', USER_AGENT);
            msg.get_request_headers().append('Accept', '*/*');
            msg.get_request_headers().append('Cookie', `auth=${authCookie}`);
            msg.get_request_headers().append('Referer', `${BASE}/workspace/`);

            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null,
                (s, res) => {
                    try {
                        const bytes = s.send_and_read_finish(res);
                        if (msg.get_status() !== 200) {
                            resolve(null);
                            return;
                        }
                        resolve(new TextDecoder().decode(bytes?.get_data() ?? new Uint8Array(0)));
                    } catch (e) { reject(e); }
                });
        });
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
                percentRemaining: clampPercent(100 - rolling.usagePercent),
                resetTimeIso: new Date(now + rolling.resetInSec * 1000).toISOString(),
            });
        }
        if (weekly) {
            entries.push({
                kind: 'percent', name: 'OpenCode Go Weekly', group: 'OpenCode Go',
                label: 'Weekly:', percentUsed: weekly.usagePercent,
                percentRemaining: clampPercent(100 - weekly.usagePercent),
                resetTimeIso: new Date(now + weekly.resetInSec * 1000).toISOString(),
            });
        }
        if (monthly) {
            entries.push({
                kind: 'percent', name: 'OpenCode Go Monthly', group: 'OpenCode Go',
                label: 'Monthly:', percentUsed: monthly.usagePercent,
                percentRemaining: clampPercent(100 - monthly.usagePercent),
                resetTimeIso: new Date(now + monthly.resetInSec * 1000).toISOString(),
            });
        }

        if (entries.length === 0) {
            return { attempted: true, entries: [],
                errors: ['OpenCode Go: no usage data found in response'] };
        }

        return { attempted: true, entries, errors: [] };
    },

    /* Parse per-request usage records from the /usage page's SSR stream
     * and aggregate them into hourly buckets for the bar chart. */
    _parseUsageRecords(body) {
        // Each record looks like:
        //   inputTokens:67,outputTokens:131,reasoningTokens:80
        // Pairs with timeCreated:$R[..]=new Date("2026-07-03T20:53:08.000Z")
        const tokenRe = /inputTokens:(\d+),outputTokens:(\d+),reasoningTokens:(\d+)/g;
        const timeRe = /timeCreated:\$R\[\d+\]=new Date\("([^"]+)"\)/g;

        const tokens = [];
        let m;
        while ((m = tokenRe.exec(body)) !== null)
            tokens.push(Number(m[1]) + Number(m[2]) + Number(m[3]));

        const times = [];
        while ((m = timeRe.exec(body)) !== null)
            times.push(new Date(m[1]).getTime());

        if (tokens.length === 0 || times.length === 0)
            return null;

        // Pair times with tokens (they appear in the same order in the SSR stream).
        const count = Math.min(tokens.length, times.length);

        // Bucket by hour for the last 24 hours.
        const now = Date.now();
        const bucketMs = 3600000; // 1 hour
        const numBuckets = 24;
        const buckets = new Array(numBuckets).fill(0);

        for (let i = 0; i < count; i++) {
            const ageHrs = Math.floor((now - times[i]) / bucketMs);
            if (ageHrs >= 0 && ageHrs < numBuckets)
                buckets[numBuckets - 1 - ageHrs] += tokens[i];
        }

        // Compress to show only the last 12 hours for a cleaner chart.
        const showBuckets = 12;
        const bars = [];
        for (let i = numBuckets - showBuckets; i < numBuckets; i++) {
            const hour = new Date(now - (numBuckets - 1 - i) * bucketMs);
            const label = `${hour.getHours().toString().padStart(2, '0')}h`;
            bars.push({ label, value: buckets[i] });
        }

        return {
            kind: 'barchart',
            name: 'OpenCode Go Usage',
            label: 'Token Usage (12h)',
            bars,
        };
    },
};