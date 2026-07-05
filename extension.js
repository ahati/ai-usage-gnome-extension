/* AI Usage Monitor — GNOME Shell Extension
 *
 * CodexBar-style UI with multi-account support. Accounts are stored in a
 * JSON config file (see config.js). Tabs/results are keyed per-account.
 */

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import * as config from './config.js';
import { zaiProvider } from './providers/zai.js';
import { currentPeakStatus } from './providers/peak.js';
import { opencodeGoProvider } from './providers/opencode-go.js';
import { openaiProvider } from './providers/openai.js';
import { deepseekProvider } from './providers/deepseek.js';
import { addBarChart, addStackedBarChart, addCostDistribution, addProgressBar } from './charting.js';
import { clamp, fmtNum, hexToRgba } from './providers/utils.js';

const PROVIDER_REGISTRY = {
    zai: zaiProvider,
    'opencode-go': opencodeGoProvider,
    openai: openaiProvider,
    deepseek: deepseekProvider,
};

/* Adwaita-derived palette */
const COLOR_GREEN = '#2ec27e';
const COLOR_YELLOW = '#f6d32d';
const COLOR_ORANGE = '#ff7800';
const COLOR_RED = '#e01b24';
const COLOR_MUTED = '#9ca3af';

const BAR_WIDTH = 290;        // popup progress bar track width

function fmtReset(iso) {
    if (!iso) return '';
    const d = new Date(iso) - Date.now();
    if (d <= 0) return 'resets soon';
    const m = Math.floor(d / 60000);
    if (m < 60) return `resets ${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `resets ${h}h ${m % 60}m`;
    return `resets ${Math.floor(h / 24)}d ${h % 24}h`;
}

/* Format milliseconds as a compact H:MM:SS or MM:SS countdown, for the
 * live peak-status indicator. */
function fmtHMS(ms) {
    if (ms <= 0) return 'now';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function usageColor(displayed, settings) {
    if (displayed === null || displayed === undefined) return COLOR_MUTED;
    const high = settings.get_int('high-usage-threshold');
    const crit = settings.get_int('critical-usage-threshold');
    if (displayed >= crit) return COLOR_RED;
    if (displayed >= high) return COLOR_ORANGE;
    if (displayed >= 50) return COLOR_YELLOW;
    return COLOR_GREEN;
}

const Indicator = GObject.registerClass(
    { GTypeName: 'AiUsageIndicator' },
    class Indicator extends PanelMenu.Button {
        _init(ext) {
            super._init(0.0, 'AI Usage');
            this._ext = ext;
            this._settings = ext.getSettings();
            this._pollId = 0;
            this._results = {};              // keyed by account id
            this._activeAccountId = null;

            /* ── Panel: gauge icon, colored by usage severity ── */
            this._panelIcon = new St.Icon({
                icon_name: 'stopwatch-symbolic',
                style_class: 'ai-usage-panel-icon',
            });
            this.add_child(this._panelIcon);

            this._buildMenu();
            this._settingsId = this._settings.connect('changed', () => {
                this._scheduleRefresh(0);
            });
            this._setupConfigMonitor();
            this._scheduleRefresh();

            /* Peak-status ticker: ticks every 1s while the menu is open so
             * the traffic-light countdown stays live. Started on open, stopped
             * on close — never runs with the menu hidden. */
            this._peakWidgets = null;     // populated by _addPeakStatus
            this._peakTickerId = 0;
            this.menu.connect('open-state-changed', (menu, open) => {
                if (open) this._startPeakTicker();
                else this._stopPeakTicker();
            });
        }

        _startPeakTicker() {
            if (this._peakTickerId) return;
            this._peakTickerId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, 1, () => {
                    if (this._peakWidgets) {
                        for (const u of this._peakWidgets) {
                            try { u(); } catch (e) { log(`[ai-usage] peak tick: ${e}`); }
                        }
                    }
                    return GLib.SOURCE_CONTINUE;
                });
        }

        _stopPeakTicker() {
            if (this._peakTickerId) {
                GLib.source_remove(this._peakTickerId);
                this._peakTickerId = 0;
            }
        }

        _buildMenu() {
            this.menu.box.add_style_class_name('ai-usage-popup');

            // Header row
            this._headerBox = new St.BoxLayout({
                style_class: 'ai-usage-header',
                x_expand: true,
            });
            this._headerTitle = new St.Label({
                text: 'AI Usage',
                style_class: 'ai-usage-header-title',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._headerBox.add_child(this._headerTitle);

            this._refreshBtn = this._iconButton('view-refresh-symbolic');
            this._refreshBtn.connect('clicked', () => {
                this._refreshNow();
                return Clutter.EVENT_PROPAGATE;
            });
            this._headerBox.add_child(this._refreshBtn);

            this._settingsBtn = this._iconButton('preferences-system-symbolic');
            this._settingsBtn.connect('clicked', () => {
                this._ext.openPreferences();
                this.menu.close();
                return Clutter.EVENT_PROPAGATE;
            });
            this._headerBox.add_child(this._settingsBtn);
            this.menu.box.add_child(this._headerBox);

            // Provider tabs row
            this._tabsContainer = new St.BoxLayout({
                style_class: 'ai-usage-tabs-container',
            });
            this.menu.box.add_child(this._tabsContainer);

            // Content area
            this._contentBox = new St.BoxLayout({
                style_class: 'ai-usage-usage-section',
                vertical: true,
            });
            this.menu.box.add_child(this._contentBox);
        }

        _iconButton(iconName) {
            const btn = new St.Button({
                style_class: 'ai-usage-header-button',
                can_focus: true,
            });
            btn.set_child(new St.Icon({
                icon_name: iconName,
                style_class: 'ai-usage-header-button-icon',
            }));
            return btn;
        }

        /* Watch config.json for external changes (e.g. prefs edits). */
        _setupConfigMonitor() {
            const file = Gio.File.new_for_path(config.configPath());
            try {
                this._configMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
                this._configMonitorId = this._configMonitor.connect('changed', () => {
                    this._scheduleRefresh(0);
                });
            } catch (e) {
                log(`[ai-usage] could not monitor config: ${e}`);
            }
        }

        /* Build [{account, provider}] for enabled, authenticated accounts. */
        _getAccounts() {
            const cfg = config.load();
            const out = [];
            for (const acc of cfg.accounts) {
                if (!acc.enabled) continue;
                const provider = PROVIDER_REGISTRY[acc.provider];
                if (!provider) continue;
                out.push({ account: acc, provider });
            }
            return out;
        }

        /* ── Tabs ── */

        _renderTabs() {
            this._tabsContainer.destroy_all_children();
            const accounts = this._getAccounts();
            const showLogos = this._settings.get_boolean('show-logos');

            if (!accounts.some(a => a.account.id === this._activeAccountId))
                this._activeAccountId = accounts[0]?.account.id ?? null;

            for (const { account, provider } of accounts) {
                const btn = new St.Button({
                    style_class: 'ai-usage-tab',
                    can_focus: true,
                });
                const inner = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
                if (showLogos) {
                    const logo = this._providerLogo(provider);
                    if (logo) inner.add_child(logo);
                }
                inner.add_child(new St.Label({
                    text: account.label || provider.label,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                btn.set_child(inner);
                if (account.id === this._activeAccountId)
                    btn.add_style_class_name('ai-usage-tab-active');
                btn.connect('clicked', () => {
                    this._activeAccountId = account.id;
                    this._renderTabs();
                    this._renderContent();
                    return Clutter.EVENT_PROPAGATE;
                });
                this._tabsContainer.add_child(btn);
            }
        }

        _providerLogo(provider) {
            if (!provider.logoFile) return null;
            const path = GLib.build_filenamev([
                this._ext.path, 'media', 'logos', provider.logoFile,
            ]);
            if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return null;
            try {
                const cls = provider.fullColorLogo
                    ? 'ai-usage-tab-icon-color'
                    : 'ai-usage-tab-icon';
                return new St.Icon({
                    gicon: Gio.Icon.new_for_string(path),
                    style_class: cls,
                });
            } catch (e) {
                return null;
            }
        }

        /* ── Content ── */

        _renderContent() {
            this._contentBox.destroy_all_children();
            // Reset the peak-widget list so stale update closures (pointing at
            // destroyed labels) don't fire from the ticker.
            this._peakWidgets = [];

            const accounts = this._getAccounts();
            const active = accounts.find(a => a.account.id === this._activeAccountId);
            if (!active) {
                this._addHint(this._contentBox, 'Configure accounts in Preferences…');
                return;
            }

            const { account, provider } = active;
            const res = this._results[account.id];
            if (!res || !res.attempted) {
                this._addHint(this._contentBox, 'No data yet — refresh to fetch.');
                return;
            }

            if (!res.entries || res.entries.length === 0) {
                if (res.errors && res.errors.length) {
                    for (const err of res.errors)
                        this._addError(this._contentBox, err);
                } else {
                    this._addHint(this._contentBox,
                        'No usage data. Configure this account in Preferences…');
                }
                return;
            }

            let first = true;
            for (const e of res.entries) {
                if (!first) this._addSeparator(this._contentBox);
                first = false;
                this._addEntry(this._contentBox, e);
            }

            if (res.errors && res.errors.length) {
                this._addSeparator(this._contentBox);
                for (const err of res.errors)
                    this._addError(this._contentBox, err);
            }
        }

        _addEntry(parent, e) {
            if (e.kind === 'percent') {
                const pctUsed = clamp(e.percentUsed ?? (e.percentRemaining != null
                    ? 100 - e.percentRemaining : 0));
                const pctRemaining = clamp(100 - pctUsed);
                this._addTitle(parent, e.label || 'Usage');

                // Progress bar drawn with Cairo via St.DrawingArea.
                const fillColor = usageColor(pctUsed, this._settings);
                addProgressBar(parent, pctUsed, pctRemaining, fillColor);

                const stats = new St.BoxLayout({ x_expand: true });
                const leftText = this._settings.get_string('display-mode') === 'remaining'
                    ? `${Math.round(pctRemaining)}% left`
                    : `${Math.round(pctUsed)}% used`;
                stats.add_child(new St.Label({
                    text: leftText,
                    style_class: 'ai-usage-usage-subtitle',
                    x_expand: true,
                }));
                const detail = [];
                if (e.remaining) detail.push(`${fmtNum(e.remaining)} rem`);
                if (e.resetTimeIso) detail.push(fmtReset(e.resetTimeIso));
                if (detail.length)
                    stats.add_child(new St.Label({
                        text: detail.join(', '),
                        style_class: 'ai-usage-usage-subtitle ai-usage-usage-subtitle-right',
                    }));
                parent.add_child(stats);

                // Optional per-tool breakdown (e.g. Z.AI MCP tools).
                if (e.breakdown) this._addBreakdown(parent, e.breakdown);
            } else if (e.kind === 'barchart' || e.kind === 'peakbarchart') {
                addBarChart(parent, e);
            } else if (e.kind === 'stackedbarchart') {
                addStackedBarChart(parent, e);
            } else if (e.kind === 'costdistribution') {
                addCostDistribution(parent, e);
            } else if (e.kind === 'peakstatus') {
                this._addPeakStatus(parent, e);
            } else {
                this._addValueBox(parent, e);
            }
        }

        _displayedValue(pctUsed, pctRemaining) {
            return this._settings.get_string('display-mode') === 'remaining'
                ? pctRemaining : pctUsed;
        }

        _addTitle(parent, text) {
            parent.add_child(new St.Label({
                text,
                style_class: 'ai-usage-usage-title',
            }));
        }

        _addHint(parent, text) {
            parent.add_child(new St.Label({
                text,
                style_class: 'ai-usage-usage-subtitle ai-usage-hint',
            }));
        }

        _addError(parent, text) {
            parent.add_child(new St.Label({
                text: `Error: ${text}`,
                style: 'color: #ff7800; font-weight: bold; margin-top: 4px;',
            }));
        }

        _addSeparator(parent) {
            parent.add_child(new St.Widget({
                style: 'height: 1px; background-color: rgba(255,255,255,0.05); margin: 8px 0;',
            }));
        }

        /* MCP per-tool breakdown: one thin labelled bar per tool, fill = the
         * tool's share of total MCP calls used this window. Empty window → all
         * bars render as an empty track (no division by zero). */
        _addBreakdown(parent, breakdown) {
            const total = breakdown.total || 0;
            const items = breakdown.items || [];
            if (items.length === 0) return;

            const header = new St.BoxLayout({ x_expand: true, style_class: 'ai-usage-breakdown-header' });
            header.add_child(new St.Label({
                text: 'MCP tools',
                style_class: 'ai-usage-breakdown-title',
                x_expand: true,
            }));
            header.add_child(new St.Label({
                text: total > 0 ? `${fmtNum(total)} used` : 'none used yet',
                style_class: 'ai-usage-usage-subtitle ai-usage-usage-subtitle-right',
            }));
            parent.add_child(header);

            for (const item of items) {
                const row = new St.BoxLayout({
                    style_class: 'ai-usage-breakdown-row',
                    x_expand: true,
                });
                row.add_child(new St.Label({
                    text: item.label,
                    style_class: 'ai-usage-breakdown-label',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                }));

                const barBox = new St.BoxLayout({
                    style_class: 'ai-usage-breakdown-bar-box',
                    x_expand: true,
                });
                const pctShare = total > 0 ? (item.value / total) * 100 : 0;
                addProgressBar(barBox, pctShare, 100 - pctShare, COLOR_MUTED);
                row.add_child(barBox);

                row.add_child(new St.Label({
                    text: total > 0
                        ? `${fmtNum(item.value)} (${Math.round(pctShare)}%)`
                        : `${fmtNum(item.value)}`,
                    style_class: 'ai-usage-breakdown-count',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                parent.add_child(row);
            }
        }

        /* Highlighted value box (e.g. DeepSeek balance): a slightly larger
         * rounded card with the label above and the value emphasized inside.
         * Negative balances render in red, positive in green, neutral values
         * use the default foreground. */
        _addValueBox(parent, e) {
            this._addTitle(parent, e.label || 'Value');
            const raw = e.value ?? '?';
            const numMatch = String(raw).match(/-?\d/);
            const isNeg = numMatch && numMatch[0] === '-';
            const box = new St.Label({
                text: raw,
                style_class: 'ai-usage-value-box' + (isNeg ? ' ai-usage-value-box-negative' : ''),
                x_expand: true,
            });
            parent.add_child(box);
        }

        /* Peak-hours traffic-light: a colored circle (red = currently peak,
         * green = off-peak) + a live countdown to the next state change. The
         * countdown is recomputed every 1s while the menu is open via a
         * dedicated ticker (this._peakTickerId) that touches only these
         * widgets — it does not refetch or re-render the menu. */
        _addPeakStatus(parent, e) {
            const row = new St.BoxLayout({
                style_class: 'ai-usage-peak-status',
                x_expand: true,
            });

            const dot = new St.DrawingArea({
                style_class: 'ai-usage-peak-dot',
            });
            row.add_child(dot);

            const text = new St.Label({
                style_class: 'ai-usage-peak-text',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(text);
            parent.add_child(row);

            const update = () => {
                const s = currentPeakStatus(new Date(), e.peakWindows);
                const color = s.inPeak ? COLOR_RED : COLOR_GREEN;
                const label = s.inPeak ? 'Peak (surcharge)' : 'Off-peak';
                const next = s.inPeak ? 'peak ends in' : 'peak starts in';
                text.set_text(`${label} · ${next} ${fmtHMS(s.msToChange)}`);

                // Repaint the dot with the current color.
                dot.repaint && dot.repaint();
                dot._peakColor = color;
            };

            // The dot paints itself from dot._peakColor (set by update()).
            dot.connect('repaint', area => {
                const cr = area.get_context();
                const w = area.width;
                const h = area.height;
                if (w <= 0 || h <= 0) { cr.$dispose(); return; }
                const rgba = hexToRgba(area._peakColor || COLOR_MUTED);
                cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
                cr.arc(w / 2, h / 2, Math.min(w, h) / 2 - 1, 0, 2 * Math.PI);
                cr.fill();
                cr.$dispose();
            });

            update();

            // Register for live updates while the menu is open.
            this._peakWidgets = this._peakWidgets || [];
            this._peakWidgets.push(update);
        }

        /* ── Panel update ── */

        _updatePanel() {
            let worstRemaining = null;
            for (const { account } of this._getAccounts()) {
                const r = this._results[account.id];
                if (!r || !r.attempted) continue;
                for (const e of r.entries) {
                    if (e.kind === 'percent') {
                        const rem = e.percentRemaining != null
                            ? clamp(e.percentRemaining)
                            : clamp(100 - (e.percentUsed ?? 0));
                        if (worstRemaining === null || rem < worstRemaining)
                            worstRemaining = rem;
                    }
                }
            }

            if (worstRemaining !== null) {
                const pctUsed = clamp(100 - worstRemaining);
                const displayed = this._displayedValue(pctUsed, clamp(worstRemaining));
                const color = usageColor(displayed, this._settings);
                this._panelIcon.set_style(`color: ${color};`);
            } else {
                this._panelIcon.set_style(`color: ${COLOR_MUTED};`);
            }
        }

        /* ── Fetching ── */

        async _fetchAll() {
            const s = new Soup.Session();
            const accounts = this._getAccounts();
            log(`[ai-usage] Fetching ${accounts.length} account(s)`);
            const ps = accounts.map(({ account, provider }) =>
                provider.fetch(s, account.credentials).then(r => {
                    this._results[account.id] = r;
                    log(`[ai-usage] ${account.label}: attempted=${r.attempted} entries=${r.entries?.length || 0} errors=${r.errors?.length || 0}`);
                }).catch(e => {
                    this._results[account.id] = {
                        attempted: true, entries: [],
                        errors: [`${account.label}: ${e.message || e}`],
                    };
                }));
            await Promise.all(ps);
            this._updatePanel();
            this._renderTabs();
            this._renderContent();
        }

        async _refreshNow() {
            this._refreshBtn.reactive = false;
            this._headerTitle.set_text('AI Usage (Refreshing…)');
            try {
                await this._fetchAll();
            } finally {
                this._headerTitle.set_text('AI Usage');
                this._refreshBtn.reactive = true;
            }
        }

        _scheduleRefresh(delayMs) {
            if (this._pollId) { GLib.source_remove(this._pollId); this._pollId = 0; }
            const iv = delayMs ?? (this._settings.get_int('refresh-interval') * 1000);
            this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
                Math.max(1, Math.floor(iv / 1000)), () => {
                    this._pollId = 0;
                    this._fetchAll().catch(e => logError(e));
                    this._scheduleRefresh();
                    return GLib.SOURCE_REMOVE;
                });
            this._fetchAll().catch(e => logError(e));
        }

        destroy() {
            this._stopPeakTicker();
            this._peakWidgets = null;
            if (this._pollId) { GLib.source_remove(this._pollId); this._pollId = 0; }
            if (this._settingsId) { this._settings.disconnect(this._settingsId); this._settingsId = 0; }
            if (this._configMonitorId && this._configMonitor) {
                this._configMonitor.disconnect(this._configMonitorId);
                this._configMonitorId = 0;
            }
            super.destroy();
        }
    }
);

export default class AiUsageExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');
    }
    disable() {
        if (this._indicator) { this._indicator.destroy(); this._indicator = null; }
    }
}
