/* DeepSeek provider
 *
 * Endpoint: https://api.deepseek.com/user/balance
 * Auth: API key in Authorization: Bearer header.
 * Returns account balance (not usage percentages).
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
const USER_AGENT = 'OpenCode-Quota-Toast/1.0';

const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' };

function getAuthHeaders(settings) {
    const apiKey = settings.get_string('deepseek-api-key');
    if (apiKey && apiKey.length > 0) {
        return { 'Authorization': `Bearer ${apiKey}`, 'User-Agent': USER_AGENT };
    }
    return null;
}

function normalizeBalance(val) {
    if (typeof val === 'number') return val.toFixed(2);
    if (typeof val === 'string') {
        const n = parseFloat(val);
        if (!isNaN(n)) return n.toFixed(2);
    }
    return '0.00';
}

export const deepseekProvider = {
    id: 'deepseek',
    label: 'DeepSeek',

    needsAuth(settings) {
        return !!(settings.get_string('deepseek-api-key'));
    },

    async fetch(session, settings) {
        const headers = getAuthHeaders(settings);
        if (!headers) return { attempted: false };

        try {
            const message = Soup.Message.new('GET', DEEPSEEK_BALANCE_URL);
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
                return { attempted: true, entries: [], errors: [`DeepSeek HTTP ${result.status}: ${errDetail}`] };
            }

            return this._parseResponse(JSON.parse(result.body));
        } catch (e) {
            return { attempted: true, entries: [], errors: [`DeepSeek error: ${e.message || e}`] };
        }
    },

    _parseResponse(data) {
        const entries = [];
        const isAvailable = data?.is_available === true;
        const balanceInfos = data?.balance_infos;

        if (Array.isArray(balanceInfos) && balanceInfos.length > 0) {
            for (const info of balanceInfos) {
                const currency = (info.currency || 'USD').toUpperCase();
                const symbol = CURRENCY_SYMBOLS[currency] || currency;
                const total = normalizeBalance(info.total_balance);
                entries.push({
                    kind: 'value', name: 'DeepSeek Balance', group: 'DeepSeek',
                    label: 'Balance:', value: `${symbol}${total}`,
                });
            }
        } else {
            // No balance info — show availability status
            entries.push({
                kind: 'value', name: 'DeepSeek', group: 'DeepSeek',
                label: 'Status:', value: isAvailable ? 'Available' : 'Not available',
            });
        }

        return { attempted: true, entries, errors: [] };
    },
};