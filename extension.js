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
import { zaiProvider, currentPeakStatus } from './providers/zai.js';
import { opencodeGoProvider } from './providers/opencode-go.js';
import { openaiProvider } from './providers/openai.js';
import { deepseekProvider } from './providers/deepseek.js';

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

function clamp(v) { return Math.max(0, Math.min(100, v)); }

/* Parse #RRGGBB into [r, g, b, a] (0–1 floats) for Cairo. */
function _hexToRgba(hex) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16) / 255;
    const g = parseInt(h.substring(2, 4), 16) / 255;
    const b = parseInt(h.substring(4, 6), 16) / 255;
    return [r, g, b, 1.0];
}

function fmtNum(n) {
    if (n === null || n === undefined) return null;
    if (typeof n === 'number') {
        if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
        if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
        return String(Math.round(n));
    }
    return String(n);
}

/* Format raw OpenCode Go cost units as dollars. Calibrated against the
 * dashboard: cost:374228 → $0.0037, divisor ≈ 101,142,703. */
const OCG_COST_DIVISOR = 101142703;
function fmtCost(rawCost) {
    const dollars = rawCost / OCG_COST_DIVISOR;
    if (dollars >= 100) return `$${dollars.toFixed(0)}`;
    if (dollars >= 1) return `$${dollars.toFixed(2)}`;
    return `$${dollars.toFixed(3)}`;
}

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
                // This is the same technique GNOME Shell's own Slider uses —
                // we paint directly at render time using the widget's actual
                // allocated width, so proportions are always pixel-perfect
                // regardless of CSS layout quirks.
                this._addProgressBar(parent, pctUsed, pctRemaining);

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
                this._addBarChart(parent, e);
            } else if (e.kind === 'stackedbarchart') {
                this._addStackedBarChart(parent, e);
            } else if (e.kind === 'costdistribution') {
                this._addCostDistribution(parent, e);
            } else if (e.kind === 'peakstatus') {
                this._addPeakStatus(parent, e);
            } else {
                this._addTitle(parent, e.label || 'Value');
                parent.add_child(new St.Label({
                    text: e.value ?? '?',
                    style_class: 'ai-usage-usage-subtitle',
                }));
            }
        }

        /* One horizontal progress bar. pctUsed/pctRemaining are 0–100.
         * Used both for top-level entries and (via a fixed grey fill) inside
         * the MCP breakdown. Returns the DrawingArea (already parented). */
        _addProgressBar(parent, pctUsed, pctRemaining, fillColor = null) {
            const fill = fillColor || usageColor(pctUsed, this._settings);
            const fraction = clamp(pctRemaining) / 100; // 1.0 = full, 0 = empty

            const bar = new St.DrawingArea({
                style_class: 'ai-usage-progress-bar',
                x_expand: true,
            });
            bar.connect('repaint', area => {
                const cr = area.get_context();
                const w = area.width;
                const h = area.height;
                if (w <= 0 || h <= 0) { cr.$dispose(); return; }
                const radius = Math.min(h / 2, 6);

                // Translucent track background (rounded)
                cr.setSourceRGBA(1, 1, 1, 0.1);
                this._roundedPath(cr, w, h, radius);
                cr.fill();

                // Colored fill (left-aligned, width = fraction of track, rounded)
                if (fraction > 0) {
                    const fillW = Math.round(w * fraction);
                    const rgba = _hexToRgba(fill);
                    cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
                    cr.save();
                    this._roundedPath(cr, w, h, radius);
                    cr.clip();
                    cr.rectangle(0, 0, fillW, h);
                    cr.fill();
                    cr.restore();
                }
                cr.$dispose();
            });
            parent.add_child(bar);
            return bar;
        }

        /* Paint a rounded-rectangle subpath covering the full widget area. */
        _roundedPath(cr, w, h, radius) {
            cr.newSubPath();
            cr.arc(w - radius, radius, radius, -Math.PI / 2, 0);
            cr.arc(w - radius, h - radius, radius, 0, Math.PI / 2);
            cr.arc(radius, h - radius, radius, Math.PI / 2, Math.PI);
            cr.arc(radius, radius, radius, Math.PI, 3 * Math.PI / 2);
            cr.closePath();
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
                // Fill = share of used MCP calls; show as "remaining" so a tool
                // used heavily appears emptier (more consumed).
                const pctShare = total > 0 ? (item.value / total) * 100 : 0;
                this._addProgressBar(barBox, pctShare, 100 - pctShare, COLOR_MUTED);
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

        _addBarChart(parent, e) {
            const bars = e.bars || [];
            if (bars.length === 0) return;
            const maxVal = Math.max(...bars.map(b => b.value), 1);

            this._addTitle(parent, e.label || 'Usage');

            // Chart area: Cairo-drawn vertical bars. Each bar uses its own
            // color when provided (e.g. peak vs off-peak), else falls back to
            // the default blue.
            const chart = new St.DrawingArea({
                style_class: 'ai-usage-barchart',
                x_expand: true,
            });
            const defaultColor = _hexToRgba('#3584e4');
            chart.connect('repaint', area => {
                const cr = area.get_context();
                const w = area.width;
                const h = area.height;
                if (w <= 0 || h <= 0 || bars.length === 0) { cr.$dispose(); return; }

                const gap = 3;
                const barW = Math.max(2, (w - gap * (bars.length - 1)) / bars.length);

                for (let i = 0; i < bars.length; i++) {
                    const fraction = bars[i].value / maxVal;
                    const barH = bars[i].value > 0
                        ? Math.max(1, Math.round((h - 14) * fraction))
                        : 0;
                    const x = i * (barW + gap);
                    const y = h - 14 - barH;
                    const rgba = bars[i].color ? _hexToRgba(bars[i].color) : defaultColor;
                    cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
                    if (barH > 0) {
                        cr.rectangle(x, y, barW, barH);
                        cr.fill();
                    }
                }
                cr.$dispose();
            });
            parent.add_child(chart);

            // X-axis labels row. Thin labels for dense charts (24h/peak/30d)
            // so they don't overlap — show every Nth bucket.
            const step = bars.length > 12 ? Math.ceil(bars.length / 6) : 1;
            const labelRow = new St.BoxLayout({ x_expand: true, style_class: 'ai-usage-barchart-labels' });
            for (let i = 0; i < bars.length; i++) {
                labelRow.add_child(new St.Label({
                    text: (i % step === 0 || i === bars.length - 1) ? bars[i].label : '',
                    style_class: 'ai-usage-barchart-label',
                    x_expand: true,
                    x_align: Clutter.ActorAlign.CENTER,
                }));
            }
            parent.add_child(labelRow);

            // Optional legend (e.g. peak vs off-peak split, or model colors
            // for the rolling-50 chart). Items may use either {color,label}
            // (peak) or {name,color,total} (models) — wrapped into a flow
            // layout so many models don't force the popup wider.
            if (e.legend)
                this._addLegendFlow(parent, e.legend, e.unit);
        }

        /* Peak-hours traffic-light: a colored circle (red = currently peak,
         * green = off-peak) + a live countdown to the next state change. The
         * countdown is recomputed every 60s while the menu is open via a
         * dedicated ticker (this._peakTickerId) that touches only these
         * widgets — it does not refetch or re-render the menu. */
        /* Horizontal cost-distribution bar: a single track split into colored
         * segments, one per model. Segment width = that model's share of total
         * cost over the last N requests. Shows the cost mix at a glance. */
        _addCostDistribution(parent, e) {
            const segments = e.segments || [];
            if (segments.length === 0) return;
            const total = segments.reduce((s, seg) => s + seg.value, 0) || 1;

            this._addTitle(parent, e.label || 'Cost distribution');

            const bar = new St.DrawingArea({
                style_class: 'ai-usage-progress-bar ai-usage-cost-dist-bar',
                x_expand: true,
            });
            bar.connect('repaint', area => {
                const cr = area.get_context();
                const w = area.width;
                const h = area.height;
                if (w <= 0 || h <= 0) { cr.$dispose(); return; }

                let x = 0;
                for (const seg of segments) {
                    const segW = Math.round(w * seg.value / total);
                    if (segW <= 0) continue;
                    const rgba = _hexToRgba(seg.color);
                    cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
                    cr.rectangle(x, 0, segW, h);
                    cr.fill();
                    x += segW;
                }
                cr.$dispose();
            });
            parent.add_child(bar);

            // Total cost subtitle on the right.
            const stats = new St.BoxLayout({ x_expand: true });
            stats.add_child(new St.Label({
                text: `${segments.length} models`,
                style_class: 'ai-usage-usage-subtitle',
                x_expand: true,
            }));
            stats.add_child(new St.Label({
                text: `total ${fmtCost(e.totalCost)}`,
                style_class: 'ai-usage-usage-subtitle ai-usage-usage-subtitle-right',
            }));
            parent.add_child(stats);

            // Flow legend (model swatch + cost).
            this._addLegendFlow(parent, e.legend, e.unit);
        }

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
                const s = currentPeakStatus(new Date());
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
                const rgba = _hexToRgba(area._peakColor || COLOR_MUTED);
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

        /* Stacked bar chart: each bucket is a vertical bar split into colored
         * segments — one per model. A legend row shows each model's color swatch
         * and its total tokens for the window. Used for Z.AI model usage. */
        _addStackedBarChart(parent, e) {
            const buckets = e.buckets || [];
            if (buckets.length === 0) return;
            const legend = e.legend || [];

            // Bar heights are relative to the tallest single bucket (sum of its
            // segments), so the busiest period fills the chart vertically.
            const bucketTotals = buckets.map(b =>
                b.segments.reduce((s, seg) => s + seg.value, 0));
            const maxTotal = Math.max(...bucketTotals, 1);

            this._addTitle(parent, e.label || 'Model usage');

            const chart = new St.DrawingArea({
                style_class: 'ai-usage-barchart ai-usage-stacked-barchart',
                x_expand: true,
            });
            chart.connect('repaint', area => {
                const cr = area.get_context();
                const w = area.width;
                const h = area.height;
                if (w <= 0 || h <= 0 || buckets.length === 0) { cr.$dispose(); return; }

                const gap = 2;
                const barW = Math.max(2, (w - gap * (buckets.length - 1)) / buckets.length);
                const chartH = h - 16;   // reserve space for x-axis labels

                for (let i = 0; i < buckets.length; i++) {
                    const total = bucketTotals[i];
                    if (total <= 0) continue;   // leave empty buckets blank
                    const scale = chartH / maxTotal;
                    const x = i * (barW + gap);
                    let y = chartH;   // bottom-up stacking
                    for (const seg of buckets[i].segments) {
                        if (seg.value <= 0) continue;
                        const segH = Math.max(1, Math.round(seg.value * scale));
                        y -= segH;
                        const rgba = _hexToRgba(seg.color);
                        cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
                        cr.rectangle(x, y, barW, segH);
                        cr.fill();
                    }
                }
                cr.$dispose();
            });
            parent.add_child(chart);

            // X-axis labels: thin them out for dense charts (24h/30d) so they
            // don't overlap — show every Nth bucket.
            const step = buckets.length > 12 ? Math.ceil(buckets.length / 6) : 1;
            const labelRow = new St.BoxLayout({ x_expand: true, style_class: 'ai-usage-barchart-labels' });
            for (let i = 0; i < buckets.length; i++) {
                labelRow.add_child(new St.Label({
                    text: (i % step === 0 || i === buckets.length - 1) ? buckets[i].label : '',
                    style_class: 'ai-usage-barchart-label',
                    x_expand: true,
                    x_align: Clutter.ActorAlign.CENTER,
                }));
            }
            parent.add_child(labelRow);

            // Legend: color swatch + "MODEL total" per model, wrapped into a
            // multi-row flow so the popup stays narrow with many models.
            if (legend.length > 0)
                this._addLegendFlow(parent, legend, e.unit);
        }

        /* Build the text for a legend entry, accounting for unit. */
        _legendLabel(m, unit) {
            if (m.total === null || m.total === undefined) return m.name;
            if (unit === 'cost') return `${m.name} ${fmtCost(m.total)}`;
            return `${m.name} ${fmtNum(m.total)}`;
        }

        /* Render a legend as a wrapping flow layout: items are packed into
         * horizontal rows of at most `perRow` swatch+label pairs, then rows
         * stack vertically. This keeps the popup width bounded when there are
         * many models (OpenCode Go workspaces can expose 15+). */
        _addLegendFlow(parent, items, unit, perRow = 4) {
            if (!items || items.length === 0) return;
            const container = new St.BoxLayout({
                style_class: 'ai-usage-legend-flow',
                vertical: true,
                x_expand: true,
            });
            for (let i = 0; i < items.length; i += perRow) {
                const row = new St.BoxLayout({
                    style_class: 'ai-usage-legend-row',
                    x_expand: true,
                });
                for (let j = i; j < Math.min(i + perRow, items.length); j++) {
                    const item = items[j];
                    row.add_child(this._legendSwatch(item.color));
                    const text = item.label ?? this._legendLabel(item, unit);
                    row.add_child(new St.Label({
                        text,
                        style_class: 'ai-usage-legend-label',
                        y_align: Clutter.ActorAlign.CENTER,
                    }));
                }
                container.add_child(row);
            }
            parent.add_child(container);
        }

        _legendSwatch(color) {
            // A 10x10 Cairo-filled square colored to match the model segment.
            const swatch = new St.DrawingArea({
                style_class: 'ai-usage-legend-swatch',
            });
            swatch.connect('repaint', area => {
                const cr = area.get_context();
                const w = area.width;
                const h = area.height;
                if (w <= 0 || h <= 0) { cr.$dispose(); return; }
                const rgba = _hexToRgba(color);
                cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
                cr.rectangle(0, 0, w, h);
                cr.fill();
                cr.$dispose();
            });
            return swatch;
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
