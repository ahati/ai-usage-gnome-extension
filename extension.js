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

                const freeColor = usageColor(this._displayedValue(pctUsed, pctRemaining), this._settings);
                const track = new St.BoxLayout({
                    style_class: 'ai-usage-progress-container',
                });
                if (pctRemaining > 0) {
                    track.add_child(new St.Widget({
                        style_class: 'ai-usage-progress-free',
                        // When there's no used segment, expand to fill the track;
                        // otherwise use a fixed width so the used segment gets the rest.
                        x_expand: pctUsed === 0,
                        width: pctUsed === 0 ? -1 : Math.round((pctRemaining / 100) * BAR_WIDTH),
                        style: `background-color: ${freeColor};`,
                    }));
                }
                if (pctUsed > 0) {
                    track.add_child(new St.Widget({
                        style_class: 'ai-usage-progress-used',
                        x_expand: true,
                    }));
                }
                parent.add_child(track);

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
            } else {
                this._addTitle(parent, e.label || 'Value');
                parent.add_child(new St.Label({
                    text: e.value ?? '?',
                    style_class: 'ai-usage-usage-subtitle',
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
