/* DeepSeek provider
 *
 * Endpoint: https://api.deepseek.com/user/balance
 * Auth: API key in Authorization: Bearer header.
 * Returns account balance (not usage percentages).
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import { USER_AGENT } from './constants.js';

/* DeepSeek: peak is 01:00–04:00 and 06:00–10:00 UTC
 * (09:00–12:00 and 14:00–18:00 UTC+8). */
const DEEPSEEK_PEAK_WINDOWS_UTC = [[1, 4], [6, 10]];

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' };

function getAuthHeaders(credentials) {
    const apiKey = credentials.apiKey;
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
    logoFile: 'deepseek-symbolic.svg',

    needsAuth(credentials) {
        return !!(credentials.apiKey);
    },

    async fetch(session, credentials) {
        const headers = getAuthHeaders(credentials);
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

        // Peak-hours traffic-light. The renderer owns the countdown and ticks
        // it every second while the menu is open; peakWindows parameterizes the
        // status function so DeepSeek's two UTC windows are honored.
        entries.push({
            kind: 'peakstatus', name: 'DeepSeek Peak', group: 'DeepSeek',
            label: 'Peak hours',
            peakWindows: DEEPSEEK_PEAK_WINDOWS_UTC,
        });

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
