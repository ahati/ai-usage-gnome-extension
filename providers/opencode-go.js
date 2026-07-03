/* OpenCode Go provider
 *
 * Uses the _server SSR API endpoint:
 *   GET https://opencode.ai/workspace/{id}/go  → extract _server hash
 *   GET https://opencode.ai/_server?id={hash}&args={...}
 *
 * Response contains rollingUsage, weeklyUsage, monthlyUsage with
 * usagePercent (0-100) and resetInSec.
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

    needsAuth(settings) {
        const wid = settings.get_string('opencode-go-workspace-id');
        const cookie = settings.get_string('opencode-go-auth-cookie');
        return !!(wid && cookie);
    },

    async fetch(session, settings) {
        const workspaceId = settings.get_string('opencode-go-workspace-id');
        const authCookie = settings.get_string('opencode-go-auth-cookie');

        if (!workspaceId || !authCookie)
            return { attempted: false };

        try {
            // Step 1: load the /go page to extract the _server hash
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

            // Extract _server hash from the page
            const hashMatch = goHtml.match(/_server\?id=([a-f0-9]{64})/);
            if (!hashMatch) {
                return { attempted: true, entries: [],
                    errors: ['OpenCode Go: could not find _server hash in page'] };
            }
            const serverHash = hashMatch[1];

            // Step 2: call _server endpoint with workspace ID
            const args = JSON.stringify({
                t: { t: 9, i: 0, l: 1, a: [{ t: 1, s: workspaceId }], o: 0 },
                f: 31, m: [],
            });
            const serverUrl = `${BASE}/_server?id=${serverHash}&args=${encodeURIComponent(args)}`;

            const ssrBody = await this._get(session, serverUrl, authCookie);
            if (!ssrBody) {
                return { attempted: true, entries: [],
                    errors: ['OpenCode Go: empty response from _server'] };
            }

            return this._parseSSR(ssrBody);
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
};