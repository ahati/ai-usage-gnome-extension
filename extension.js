/* AI Usage Monitor — GNOME Shell Extension */

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { zaiProvider } from './providers/zai.js';
import { opencodeGoProvider } from './providers/opencode-go.js';
import { openaiProvider } from './providers/openai.js';
import { deepseekProvider } from './providers/deepseek.js';

const ALL_PROVIDERS = [zaiProvider, opencodeGoProvider, openaiProvider, deepseekProvider];

function clamp(v) { return Math.max(0, Math.min(100, v)); }
function fmtNum(n) {
    if (n === null || n === undefined) return null;
    if (typeof n === 'number') {
        if (n >= 1e6) return `${(n/1e6).toFixed(1)}M`;
        if (n >= 1000) return `${(n/1000).toFixed(1)}K`;
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
    if (h < 24) return `resets ${h}h ${m%60}m`;
    return `resets ${Math.floor(h/24)}d ${h%24}h`;
}
function dotColor(rem) {
    if (rem === null || rem === undefined) return '#9ca3af';
    const u = clamp(100 - rem);
    if (u >= 95) return '#f87171';
    if (u >= 80) return '#fb923c';
    return '#4ade80';
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
            this._rows = {};
            this._built = false;

            // Simple panel label — just the worst percentage
            this._panelLabel = new St.Label({
                text: '',
                style: 'font-size: 10px; font-weight: bold; color: #e2e8f0; padding: 0 2px;',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._panelLabel);

            this._buildMenu();
            this._settingsId = this._settings.connect('changed', () => {
                this._scheduleRefresh(0);
            });
            this._scheduleRefresh();
        }

        _buildMenu() {
            const hdr = new PopupMenu.PopupSeparatorMenuItem('AI Code Limits');
            hdr.label_actor.add_style_class_name('codexbar-header');
            this.menu.addMenuItem(hdr);

            this._anchor = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._anchor);

            this._empty = new PopupMenu.PopupMenuItem('Configure providers in Preferences…');
            this._empty.setSensitive(false);
            this.menu.addMenuItem(this._empty);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._refreshBtn = new PopupMenu.PopupMenuItem('Refresh');
            this._refreshBtn.connect('activate', () => this._refreshNow());
            this.menu.addMenuItem(this._refreshBtn);

            const prefs = new PopupMenu.PopupMenuItem('Preferences…');
            prefs.connect('activate', () => this._ext.openPreferences());
            this.menu.addMenuItem(prefs);

            this._built = true;
        }

        _rebuildMenu() {
            if (!this._built) return;
            for (const pid of Object.keys(this._rows))
                for (const r of this._rows[pid]) r.destroy();
            this._rows = {};

            const enabled = this._getEnabled();
            let any = false;

            for (const prov of enabled) {
                const res = this._results[prov.id];
                if (!res || !res.attempted) continue;
                if (!res.entries || res.entries.length === 0) {
                    if (!res.errors || res.errors.length === 0) continue;
                }

                const items = [];
                const hdr = new PopupMenu.PopupSeparatorMenuItem(prov.label);
                this.menu.addMenuItem(hdr, this._anchor);
                items.push(hdr);
                any = true;

                for (const e of res.entries) {
                    const color = e.kind === 'percent' ? dotColor(e.percentRemaining) : '#60a5fa';
                    const used = e.kind === 'percent' ? clamp(100 - e.percentRemaining) : null;
                    const pctStr = e.kind === 'percent' ? `${Math.round(used)}%` : (e.value || '?');

                    let txt;
                    if (e.kind === 'percent') {
                        const parts = [`${e.label} ${pctStr}`];
                        const detail = [];
                        detail.push(`${Math.round(e.percentRemaining)}% left`);
                        if (e.remaining) detail.push(`${fmtNum(e.remaining)} rem`);
                        if (e.resetTimeIso) detail.push(fmtReset(e.resetTimeIso));
                        txt = parts.join(' ') + '  (' + detail.join(', ') + ')';
                    } else {
                        txt = `${e.label} ${e.value}`;
                    }

                    const row = new PopupMenu.PopupMenuItem(txt);
                    row.setSensitive(false);
                    this.menu.addMenuItem(row, hdr);
                    items.push(row);
                }

                for (const err of res.errors) {
                    const er = new PopupMenu.PopupMenuItem(`  ${err}`);
                    er.setSensitive(false);
                    this.menu.addMenuItem(er, hdr);
                    items.push(er);
                }

                this._rows[prov.id] = items;
            }

            this._empty.visible = !any;
        }

        _updatePanel() {
            let worst = null;
            for (const p of this._getEnabled()) {
                const r = this._results[p.id];
                if (!r || !r.attempted) continue;
                for (const e of r.entries) {
                    if (e.kind === 'percent' && e.percentRemaining !== null && e.percentRemaining !== undefined) {
                        if (worst === null || e.percentRemaining < worst) worst = e.percentRemaining;
                    }
                }
            }

            if (worst !== null) {
                const used = clamp(100 - worst);
                const color = dotColor(worst);
                this._panelLabel.text = `${Math.round(used)}%`;
                this._panelLabel.style = `font-size: 10px; font-weight: bold; color: ${color}; padding: 0 2px;`;
            } else {
                const any = this._getEnabled().some(p => this._results[p.id]?.attempted);
                this._panelLabel.text = any ? '!' : '';
                this._panelLabel.style = 'font-size: 10px; font-weight: bold; color: #9ca3af; padding: 0 2px;';
            }
        }

        _getEnabled() {
            const ids = this._settings.get_strv('enabled-providers');
            if (!ids || ids.length === 0) return ALL_PROVIDERS;
            const s = new Set(ids.map(x => x.trim().toLowerCase()));
            return ALL_PROVIDERS.filter(p => s.has(p.id));
        }

        async _fetchAll() {
            const s = new Soup.Session();
            const enabled = this._getEnabled();
            log(`[ai-usage] Fetching ${enabled.map(p => p.id).join(', ')}`);
            const ps = enabled.map(p =>
                p.fetch(s, this._settings).then(r => {
                    this._results[p.id] = r;
                    log(`[ai-usage] ${p.id}: attempted=${r.attempted} entries=${r.entries?.length || 0} errors=${r.errors?.length || 0}`);
                    if (r.errors && r.errors.length) log(`[ai-usage] ${p.id} ERROR: ${r.errors[0]}`);
                })
                    .catch(e => { this._results[p.id] = { attempted: true, entries: [],
                        errors: [`${p.label}: ${e.message || e}`] }; })
            );
            await Promise.all(ps);
            this._updatePanel();
            this._rebuildMenu();
        }

        async _refreshNow() {
            this._refreshBtn.setSensitive(false);
            await this._fetchAll();
            this._refreshBtn.setSensitive(true);
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