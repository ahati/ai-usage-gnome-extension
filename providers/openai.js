/* OpenAI (ChatGPT) provider
 *
 * Endpoint: https://chatgpt.com/backend-api/wham/usage
 * Auth: OAuth Bearer token extracted from settings or auth.json.
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const OPENAI_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const USER_AGENT = 'OpenCode-Quota-Toast/1.0';

function clampPercent(val) {
    return Math.max(0, Math.min(100, val));
}

function getAuthHeaders(credentials) {
    const oauthToken = credentials.oauthToken;
    if (oauthToken && oauthToken.length > 0) {
        // Check expiry
        const expiry = credentials.oauthExpiry || 0;
        if (expiry > 0 && expiry < Math.floor(Date.now() / 1000)) {
            return null; // expired
        }
        return { 'Authorization': `Bearer ${oauthToken}`, 'User-Agent': USER_AGENT };
    }
    return null;
}

export const openaiProvider = {
    id: 'openai',
    label: 'OpenAI',
    logoFile: 'codex-symbolic.svg',

    needsAuth(credentials) {
        return !!(credentials.oauthToken);
    },

    async fetch(session, credentials) {
        const headers = getAuthHeaders(credentials);
        if (!headers) return { attempted: false };

        try {
            const message = Soup.Message.new('GET', OPENAI_USAGE_URL);
            for (const [key, value] of Object.entries(headers))
                message.get_request_headers().append(key, value);

            const result = await new Promise((resolve, reject) => {
                session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null,
                    (s, res) => {
                        try {
                            const bytes = s.send_and_read_finish(res);
                            const body = new TextDecoder().decode(
                                bytes?.get_data() ?? new Uint8Array(0));
                            resolve({ status: message.get_status(), body });
                        } catch (e) { reject(e); }
                    });
            });

            if (result.status !== 200) {
                let errDetail = result.body?.substring(0, 200) || '';
                return { attempted: true, entries: [], errors: [`OpenAI HTTP ${result.status}: ${errDetail}`] };
            }

            return this._parseResponse(JSON.parse(result.body));
        } catch (e) {
            return { attempted: true, entries: [], errors: [`OpenAI error: ${e.message || e}`] };
        }
    },

    _parseResponse(data) {
        const entries = [];
        const primary = data?.rate_limit?.primary_window;
        const secondary = data?.rate_limit?.secondary_window ?? null;
        const codeReview = data?.code_review_rate_limit?.primary_window ?? null;

        if (!primary) {
            return { attempted: true, entries: [], errors: ['OpenAI: no quota data in response'] };
        }

        // Derive plan label
        const planType = (data.plan_type || 'openai').toLowerCase();
        let group = 'OpenAI';
        if (planType.includes('pro')) group = 'OpenAI (Pro)';
        else if (planType.includes('plus')) group = 'OpenAI (Plus)';

        // Primary window (hourly / ~5h)
        const remainingPct = clampPercent(100 - primary.used_percent);
        const resetIso = primary.reset_at
            ? new Date(primary.reset_at * 1000).toISOString()
            : (primary.reset_after_seconds
                ? new Date(Date.now() + primary.reset_after_seconds * 1000).toISOString()
                : null);

        entries.push({
            kind: 'percent', name: `${group} 5h`, group, label: '5h:',
            percentUsed: primary.used_percent,
            percentRemaining: remainingPct,
            resetTimeIso: resetIso,
        });

        // Secondary window (weekly)
        if (secondary) {
            const weeklyRemaining = clampPercent(100 - secondary.used_percent);
            const weeklyResetIso = secondary.reset_at
                ? new Date(secondary.reset_at * 1000).toISOString()
                : (secondary.reset_after_seconds
                    ? new Date(Date.now() + secondary.reset_after_seconds * 1000).toISOString()
                    : null);
            entries.push({
                kind: 'percent', name: `${group} Weekly`, group, label: 'Weekly:',
                percentUsed: secondary.used_percent,
                percentRemaining: weeklyRemaining,
                resetTimeIso: weeklyResetIso,
            });
        }

        // Code review window
        if (codeReview) {
            const crRemaining = clampPercent(100 - codeReview.used_percent);
            const crResetIso = codeReview.reset_at
                ? new Date(codeReview.reset_at * 1000).toISOString()
                : null;
            entries.push({
                kind: 'percent', name: `${group} Code Review`, group, label: 'Code Review:',
                percentUsed: codeReview.used_percent,
                percentRemaining: crRemaining,
                resetTimeIso: crResetIso,
            });
        }

        // Credits info
        if (data.credits) {
            const cr = data.credits;
            if (cr.balance !== null && cr.balance !== undefined) {
                entries.push({
                    kind: 'value', name: `${group} Credits`, group, label: 'Credits:',
                    value: cr.unlimited ? 'Unlimited' : `$${cr.balance}`,
                });
            } else if (cr.unlimited) {
                entries.push({
                    kind: 'value', name: `${group} Credits`, group, label: 'Credits:',
                    value: 'Unlimited',
                });
            }
        }

        return { attempted: true, entries, errors: [] };
    },
};