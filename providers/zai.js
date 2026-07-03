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
        oauthInit: 'https://api.z.ai/oauth/cli/init',
        oauthPoll: 'https://api.z.ai/oauth/cli/poll',
    },
    cn: {
        quota: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
        oauthInit: 'https://open.bigmodel.cn/oauth/cli/init',
        oauthPoll: 'https://open.bigmodel.cn/oauth/cli/poll',
    },
};

function clampPercent(val) {
    return Math.max(0, Math.min(100, val));
}

function getAuthHeaders(settings) {
    const apiKey = settings.get_string('zai-api-key');
    if (apiKey && apiKey.length > 0) {
        return { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    }
    const oauthToken = settings.get_string('zai-oauth-token');
    if (oauthToken && oauthToken.length > 0) {
        return { 'Authorization': `Bearer ${oauthToken}`, 'Content-Type': 'application/json' };
    }
    return null;
}

export const zaiProvider = {
    id: 'zai',
    label: 'Z.AI',

    needsAuth(settings) {
        const hasApiKey = !!(settings.get_string('zai-api-key'));
        const hasOAuth = !!(settings.get_string('zai-oauth-token'));
        return hasApiKey || hasOAuth;
    },

    getOAuthConfig(settings) {
        const endpoint = settings.get_string('zai-endpoint') || 'intl';
        const config = ZAI_ENDPOINTS[endpoint] || ZAI_ENDPOINTS.intl;
        return {
            initUrl: config.oauthInit,
            pollUrl: config.oauthPoll,
            provider: endpoint === 'cn' ? 'bigmodel' : 'zai',
        };
    },

    async fetch(session, settings) {
        const headers = getAuthHeaders(settings);
        if (!headers) return { attempted: false };

        const endpoint = settings.get_string('zai-endpoint') || 'intl';
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

            return this._parseResponse(JSON.parse(result.body));
        } catch (e) {
            return { attempted: true, entries: [], errors: [`Z.AI error: ${e.message || e}`] };
        }
    },

    _parseResponse(data) {
        const entries = [];
        const errors = [];
        const limits = data?.data?.limits ?? data?.limits;

        if (!limits || !Array.isArray(limits)) {
            // Check for top-level session utilization
            if (data?.sessionUtilization !== undefined || data?.session_utilization !== undefined) {
                const pct = data.sessionUtilization ?? data.session_utilization;
                entries.push({
                    kind: 'percent', name: 'Z.AI Session', group: 'Z.AI',
                    label: 'Session:', percentUsed: pct, percentRemaining: clampPercent(100 - pct),
                });
            }
            if (entries.length === 0)
                return { attempted: true, entries: [], errors: ['Z.AI: unexpected response format'] };
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

        // Time limits
        for (const tl of timeLimits) {
            const pct = tl.percentage ?? tl.usage ?? 0;
            const resetIso = tl.nextResetTime ? new Date(tl.nextResetTime).toISOString() : null;
            entries.push({
                kind: 'percent', name: 'Z.AI Time', group: 'Z.AI', label: 'Time:',
                percentUsed: pct,
                percentRemaining: clampPercent(100 - pct),
                resetTimeIso: resetIso,
                remaining: tl.remaining ?? null,
            });
        }

        return { attempted: true, entries, errors };
    },
};