/* Category-filtered logging wrapper for GNOME Shell extensions.
 *
 * Replaces raw log() calls with level-gated functions so that verbose
 * diagnostics (pagination loops, render details, chart JSON) don't
 * pollute the system journal at the default INFO level.
 *
 * Usage:
 *   import * as logger from './logger.js';
 *   logger.setLevel(logger.LEVELS.DEBUG);   // or 'debug' / 0
 *   logger.info('Fetching', n, 'accounts');
 *   logger.warn('Missing server-id — skipping');
 *   logger.error('Fetch failed:', e);
 *
 * The wrapper auto-detects the GJS runtime:
 *   • GNOME Shell (extension.js, providers) → global log()
 *   • GTK / Preferences (prefs.js)           → print() / logError()
 */

import GLib from 'gi://GLib';

/* ── Level constants ── */

export const LEVELS = Object.freeze({
    DEBUG: 0,
    INFO:  1,
    WARN:  2,
    ERROR: 3,
    OFF:   4,
});

/* Map string names → numeric values (case-insensitive). */
const NAME_MAP = {
    debug: LEVELS.DEBUG,
    info:  LEVELS.INFO,
    warn:  LEVELS.WARN,
    error: LEVELS.ERROR,
    off:   LEVELS.OFF,
};

/* ── Internal state ── */

let _currentLevel = LEVELS.INFO;

/* Detect which runtime we're running in.  `log` is a GNOME Shell global; it
 * does not exist in the GTK/preferences process. */
let _haveShellLog = false;
try {
    _haveShellLog = typeof log === 'function';
} catch (_) { /* global 'log' not defined */ }

/* ── Public API ── */

/** Set the minimum log level.  Accepts a LEVELS constant or a string. */
export function setLevel(level) {
    if (typeof level === 'string') {
        const key = level.toLowerCase();
        if (key in NAME_MAP) {
            _currentLevel = NAME_MAP[key];
            return;
        }
        // Unknown string — fall back to INFO.
        _currentLevel = LEVELS.INFO;
        return;
    }
    if (typeof level === 'number' && level >= LEVELS.DEBUG && level <= LEVELS.OFF) {
        _currentLevel = level;
        return;
    }
    // Invalid input — keep current level.
}

/** Return the current level as a string (for GSettings binding). */
export function currentLevelName() {
    for (const [name, val] of Object.entries(NAME_MAP)) {
        if (val === _currentLevel) return name;
    }
    return 'info';
}

/** Emit if the current level is DEBUG or finer. */
export function debug(...args) {
    if (_currentLevel <= LEVELS.DEBUG) _emit('DEBUG', args);
}

/** Emit if the current level is INFO or finer. */
export function info(...args) {
    if (_currentLevel <= LEVELS.INFO) _emit('INFO', args);
}

/** Emit if the current level is WARN or finer. */
export function warn(...args) {
    if (_currentLevel <= LEVELS.WARN) _emit('WARN', args);
}

/** Emit if the current level is ERROR or finer. */
export function error(...args) {
    if (_currentLevel <= LEVELS.ERROR) _emit('ERROR', args);
}

/* ── Internal helpers ── */

function _emit(tag, args) {
    const ts = GLib.DateTime.new_now_local().format('%H:%M:%S');
    const parts = [`[ai-usage]`, `[${tag}]`];

    // Format: join all arguments with a space (like console.log).
    const msg = args.map(a => {
        if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
        if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch (_) { return String(a); }
        }
        return String(a);
    }).join(' ');

    if (_haveShellLog) {
        log(`[ai-usage] ${parts.join(' ')} ${msg}`);
    } else {
        // Preferences / GTK process — log() is not available.
        if (tag === 'ERROR' && typeof logError === 'function') {
            logError(new Error(msg), 'ai-usage');
        } else {
            print(`[ai-usage] [${tag}] ${msg}`);
        }
    }
}
