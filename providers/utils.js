/* Shared utilities for providers and extension.js.
 *
 * DRY consolidation of helpers that were duplicated across multiple files:
 *   clamp         — was in extension.js, zai.js, opencode-go.js, openai.js
 *   fmtCost        — was in extension.js and opencode-go.js
 *   COST_DIVISOR   — was in extension.js and opencode-go.js (same value, different name)
 *   xLabelShort    — was xLabelDaily in zai.js and _shortDate in opencode-go.js
 *   hexToRgba      — was _hexToRgba in extension.js
 *   fmtNum         — was in extension.js
 *   httpGet/httpPost — HTTP boilerplate duplicated ~5 times across providers
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';

/* ── Math / formatting ── */

export function clamp(v) {
    return Math.max(0, Math.min(100, v));
}

export const COST_DIVISOR = 100000000;

/* Format raw OpenCode Go cost units as dollars. Raw values are in
 * hundred-millionths of a dollar (1e-8): cost:374228 → $0.00374228,
 * which the dashboard rounds to $0.0037. */
export function fmtCost(rawCost) {
    const dollars = rawCost / COST_DIVISOR;
    if (dollars >= 100) return `$${dollars.toFixed(0)}`;
    if (dollars >= 1) return `$${dollars.toFixed(2)}`;
    return `$${dollars.toFixed(3)}`;
}

export function fmtNum(n) {
    if (n === null || n === undefined) return null;
    if (typeof n === 'number') {
        if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
        if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
        if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
        return String(Math.round(n));
    }
    return String(n);
}

/* Parse #RRGGBB into [r, g, b, a] (0–1 floats) for Cairo. */
export function hexToRgba(hex) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16) / 255;
    const g = parseInt(h.substring(2, 4), 16) / 255;
    const b = parseInt(h.substring(4, 6), 16) / 255;
    return [r, g, b, 1.0];
}

/* Extract "MM/DD" from a "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" label. */
export function xLabelShort(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
    return m ? `${m[2]}/${m[3]}` : dateStr;
}

/* ── HTTP helpers ── */

/* Simple HTTP GET: returns the response body as a string, or null on failure. */
export async function httpGet(session, url, headers = {}) {
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
        return result.body;
    } catch (e) {
        return null;
    }
}

/* Simple HTTP POST with JSON body. Returns the response body string or null. */
export async function httpPost(session, url, headers = {}, body = '') {
    try {
        const message = Soup.Message.new('POST', url);
        for (const [key, value] of Object.entries(headers))
            message.get_request_headers().append(key, value);

        const bytes = new TextEncoder().encode(body);
        message.set_request_body_from_bytes('application/json',
            GLib.Bytes.new(bytes));

        const result = await new Promise((resolve, reject) => {
            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null,
                (s, res) => {
                    try {
                        const respBytes = s.send_and_read_finish(res);
                        const status = message.get_status();
                        const respBody = new TextDecoder().decode(
                            respBytes?.get_data() ?? new Uint8Array(0));
                        resolve({ status, body: respBody });
                    } catch (e) { reject(e); }
                });
        });

        if (result.status !== 200) return null;
        return result.body;
    } catch (e) {
        return null;
    }
}
