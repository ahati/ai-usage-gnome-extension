/* AI Usage Monitor — GNOME Shell Extension
 *
 * CodexBar-style UI: pill meter in the panel, tabbed provider popup with
 * progress bars and a header row of icon buttons.
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

import { zaiProvider } from './providers/zai.js';
import { opencodeGoProvider } from './providers/opencode-go.js';
import { openaiProvider } from './providers/openai.js';
import { deepseekProvider } from './providers/deepseek.js';

const ALL_PROVIDERS = [zaiProvider, opencodeGoProvider, openaiProvider, deepseekProvider];

/* Adwaita-derived palette */
const COLOR_BLUE = '#3584e4';
const COLOR_GREEN = '#2ec27e';
const COLOR_YELLOW = '#f6d32d';
const COLOR_ORANGE = '#ff7800';
const COLOR_RED = '#e01b24';
const COLOR_MUTED = '#9ca3af';

const BAR_WIDTH = 290;        // popup progress bar track width

function clamp(v) { return Math.max(0, Math.min(100, v)); }

function fmtNum(n) {
    if (n === null || n === undefined) return null;
    if (typeof n === 'number') {
        if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
        if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
        return String(Math.round(n));
    }
    return String(n);
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

/* Pick a color from the warning ramp based on the displayed percentage.
 * `displayed` is the value the user sees (used% in "used" mode, remaining% in
 * "remaining" mode), so thresholds apply intuitively in either mode. */
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
            this._results = {};
            this._activeProviderId = null;

            /* ── Panel: gauge icon, colored by usage severity ── */
            this._panelIcon = new St.Icon({
                icon_name: 'stopwatch-symbolic',
                style_class: 'codexbar-panel-icon',
            });
            this.add_child(this._panelIcon);

            this._buildMenu();
            this._settingsId = this._settings.connect('changed', () => {
                this._scheduleRefresh(0);
            });
            this._scheduleRefresh();
        }

        /* ── Menu skeleton ── */

        _buildMenu() {
            // Style the popup box so our CSS namespace applies.
            this.menu.box.add_style_class_name('codexbar-popup');

            // Header row: title + refresh + settings icon buttons.
            this._headerBox = new St.BoxLayout({
                style_class: 'codexbar-header',
                x_expand: true,
            });
            this._headerTitle = new St.Label({
                text: 'AI Usage',
                style_class: 'codexbar-header-title',
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

            // Provider tabs row.
            this._tabsContainer = new St.BoxLayout({
                style_class: 'codexbar-tabs-container',
            });
            this.menu.box.add_child(this._tabsContainer);

            // Content area, rebuilt on every data update / tab switch.
            this._contentBox = new St.BoxLayout({
                style_class: 'codexbar-usage-section',
                vertical: true,
            });
            this.menu.box.add_child(this._contentBox);
        }

        _iconButton(iconName) {
            const btn = new St.Button({
                style_class: 'codexbar-header-button',
                can_focus: true,
            });
            btn.set_child(new St.Icon({
                icon_name: iconName,
                style_class: 'codexbar-header-button-icon',
            }));
            return btn;
        }

        _getEnabled() {
            const ids = this._settings.get_strv('enabled-providers');
            if (!ids || ids.length === 0) return ALL_PROVIDERS;
            const s = new Set(ids.map(x => x.trim().toLowerCase()));
            return ALL_PROVIDERS.filter(p => s.has(p.id));
        }

        /* ── Tabs ── */

        _renderTabs() {
            this._tabsContainer.destroy_all_children();
            const enabled = this._getEnabled();
            const showLogos = this._settings.get_boolean('show-logos');

            // Keep a valid active provider.
            if (!enabled.some(p => p.id === this._activeProviderId))
                this._activeProviderId = enabled[0]?.id ?? null;

            for (const prov of enabled) {
                const btn = new St.Button({
                    style_class: 'codexbar-tab',
                    can_focus: true,
                });
                const inner = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
                if (showLogos) {
                    const logo = this._providerLogo(prov);
                    if (logo) inner.add_child(logo);
                }
                inner.add_child(new St.Label({
                    text: prov.label,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                btn.set_child(inner);
                if (prov.id === this._activeProviderId)
                    btn.add_style_class_name('codexbar-tab-active');
                btn.connect('clicked', () => {
                    this._activeProviderId = prov.id;
                    this._renderTabs();
                    this._renderContent();
                    return Clutter.EVENT_PROPAGATE;
                });
                this._tabsContainer.add_child(btn);
            }
        }

        _providerLogo(prov) {
            if (!prov.logoFile) return null;
            const path = GLib.build_filenamev([
                this._ext.path, 'media', 'logos', prov.logoFile,
            ]);
            if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return null;
            try {
                // Full-color brand logos (e.g. Z.AI) keep their original colors;
                // plain symbolic logos are forced monochrome to match the theme.
                // NOTE: don't stack both classes — St won't reliably let a later
                // class override -st-icon-style, so symbolic would flatten everything.
                const cls = prov.fullColorLogo
                    ? 'codexbar-tab-icon-color'
                    : 'codexbar-tab-icon';
                const icon = new St.Icon({
                    gicon: Gio.Icon.new_for_string(path),
                    style_class: cls,
                });
                return icon;
            } catch (e) {
                return null;
            }
        }

        /* ── Content ── */

        _renderContent() {
            this._contentBox.destroy_all_children();

            const enabled = this._getEnabled();
            const prov = enabled.find(p => p.id === this._activeProviderId);
            if (!prov) {
                this._addHint(this._contentBox, 'Configure providers in Preferences…');
                return;
            }

            const res = this._results[prov.id];
            if (!res || !res.attempted) {
                this._addHint(this._contentBox, 'No data yet — refresh to fetch.');
                return;
            }

            // Errors take precedence if there is nothing else to show.
            if ((!res.entries || res.entries.length === 0)) {
                if (res.errors && res.errors.length) {
                    for (const err of res.errors)
                        this._addError(this._contentBox, err);
                } else {
                    this._addHint(this._contentBox,
                        'No usage data. Configure this provider in Preferences…');
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

                // Full-width track split into two segments laid out left to right:
                //   free/remaining (green, left)  |  used (gray, right)
                const freeColor = usageColor(this._displayedValue(pctUsed, pctRemaining), this._settings);
                const track = new St.BoxLayout({
                    style_class: 'codexbar-progress-container',
                });
                if (pctRemaining > 0) {
                    track.add_child(new St.Widget({
                        style_class: 'codexbar-progress-free',
                        x_expand: false,
                        width: Math.round((pctRemaining / 100) * BAR_WIDTH),
                        style: `background-color: ${freeColor};`,
                    }));
                }
                if (pctUsed > 0) {
                    track.add_child(new St.Widget({
                        style_class: 'codexbar-progress-used',
                        x_expand: true,
                    }));
                }
                parent.add_child(track);

                // Stats row: percent + reset on the right.
                const stats = new St.BoxLayout({ x_expand: true });
                const leftText = this._settings.get_string('display-mode') === 'remaining'
                    ? `${Math.round(pctRemaining)}% left`
                    : `${Math.round(pctUsed)}% used`;
                stats.add_child(new St.Label({
                    text: leftText,
                    style_class: 'codexbar-usage-subtitle',
                    x_expand: true,
                }));
                const detail = [];
                if (e.remaining) detail.push(`${fmtNum(e.remaining)} rem`);
                if (e.resetTimeIso) detail.push(fmtReset(e.resetTimeIso));
                if (detail.length)
                    stats.add_child(new St.Label({
                        text: detail.join(', '),
                        style_class: 'codexbar-usage-subtitle codexbar-usage-subtitle-right',
                    }));
                parent.add_child(stats);
            } else {
                this._addTitle(parent, e.label || 'Value');
                parent.add_child(new St.Label({
                    text: e.value ?? '?',
                    style_class: 'codexbar-usage-subtitle',
                }));
            }
        }

        _displayedValue(pctUsed, pctRemaining) {
            return this._settings.get_string('display-mode') === 'remaining'
                ? pctRemaining : pctUsed;
        }

        _addTitle(parent, text) {
            parent.add_child(new St.Label({
                text,
                style_class: 'codexbar-usage-title',
            }));
        }

        _addHint(parent, text) {
            parent.add_child(new St.Label({
                text,
                style_class: 'codexbar-usage-subtitle codexbar-hint',
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
            let worstRemaining = null; // lowest remaining% = worst usage
            for (const p of this._getEnabled()) {
                const r = this._results[p.id];
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
            const enabled = this._getEnabled();
            log(`[ai-usage] Fetching ${enabled.map(p => p.id).join(', ')}`);
            const ps = enabled.map(p =>
                p.fetch(s, this._settings).then(r => {
                    this._results[p.id] = r;
                    log(`[ai-usage] ${p.id}: attempted=${r.attempted} entries=${r.entries?.length || 0} errors=${r.errors?.length || 0}`);
                    if (r.errors && r.errors.length) log(`[ai-usage] ${p.id} ERROR: ${r.errors[0]}`);
                }).catch(e => {
                    this._results[p.id] = {
                        attempted: true, entries: [],
                        errors: [`${p.label}: ${e.message || e}`],
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
            if (this._pollId) { GLib.source_remove(this._pollId); this._pollId = 0; }
            if (this._settingsId) { this._settings.disconnect(this._settingsId); this._settingsId = 0; }
            super.destroy();
        }
    }
);

export default class ZaiUsageExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');
    }
    disable() {
        if (this._indicator) { this._indicator.destroy(); this._indicator = null; }
    }
}
