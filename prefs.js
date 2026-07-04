/* AI Usage Monitor - Preferences Dialog
 *
 * Multi-account preferences. Account credentials are stored in a JSON
 * config file (see config.js). General UI settings stay in gsettings.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Soup from 'gi://Soup?version=3.0';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as config from './config.js';

const PROVIDER_INFO = {
    zai: { name: 'Z.AI (Zhipu)' },
    'opencode-go': { name: 'OpenCode Go' },
    openai: { name: 'OpenAI (ChatGPT Plus/Pro)' },
    deepseek: { name: 'DeepSeek' },
};

export default class AiUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        this._buildGeneralPage(window, settings);
        this._buildAccountsPage(window);
        this._buildRefreshPage(window, settings);
    }

    /* ── General page (gsettings) ── */

    _buildGeneralPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('General'), icon_name: 'emblem-system-symbolic',
        });
        window.add(page);

        const displayGroup = new Adw.PreferencesGroup({ title: _('Panel Display') });
        page.add(displayGroup);

        const displayModeRow = new Adw.ComboRow({
            title: _('Display mode'),
            subtitle: _('Whether the meter and bars reflect used or remaining quota.'),
            model: Gtk.StringList.new([_('Used'), _('Remaining')]),
            selected: settings.get_string('display-mode') === 'remaining' ? 1 : 0,
        });
        displayGroup.add(displayModeRow);
        displayModeRow.connect('notify::selected', row => {
            settings.set_string('display-mode', row.selected === 1 ? 'remaining' : 'used');
        });

        const showLogosRow = new Adw.SwitchRow({
            title: _('Show provider logos'),
            subtitle: _('Display provider logos on the tabs in the popup menu.'),
            active: settings.get_boolean('show-logos'),
        });
        displayGroup.add(showLogosRow);
        showLogosRow.connect('notify::active', row => {
            settings.set_boolean('show-logos', row.active);
        });

        const thresholdGroup = new Adw.PreferencesGroup({ title: _('Usage Thresholds') });
        page.add(thresholdGroup);

        const highRow = new Adw.SpinRow({
            title: _('High usage threshold'),
            subtitle: _('Indicator turns orange above this percentage.'),
            adjustment: Gtk.Adjustment.new(
                settings.get_int('high-usage-threshold'), 50, 100, 1, 5, 0),
            climb_rate: 1, digits: 0,
        });
        thresholdGroup.add(highRow);
        highRow.connect('notify::value', row => {
            settings.set_int('high-usage-threshold', Math.round(row.value));
        });

        const critRow = new Adw.SpinRow({
            title: _('Critical usage threshold'),
            subtitle: _('Indicator turns red above this percentage.'),
            adjustment: Gtk.Adjustment.new(
                settings.get_int('critical-usage-threshold'), 60, 100, 1, 5, 0),
            climb_rate: 1, digits: 0,
        });
        thresholdGroup.add(critRow);
        critRow.connect('notify::value', row => {
            settings.set_int('critical-usage-threshold', Math.round(row.value));
        });
    }

    /* ── Accounts page (JSON config) ── */

    _buildAccountsPage(window) {
        this._window = window;
        this._page = new Adw.PreferencesPage({
            title: _('Accounts'), icon_name: 'preferences-system-symbolic',
        });
        window.add(this._page);

        this._accountsGroup = new Adw.PreferencesGroup({
            title: _('Configured Accounts'),
            description: _('Each account fetches usage independently.'),
        });
        this._page.add(this._accountsGroup);

        this._renderAccountRows();

        // Add account row
        const addGroup = new Adw.PreferencesGroup();
        this._page.add(addGroup);

        const addRow = new Adw.ActionRow({
            title: _('Add Account'),
            subtitle: _('Choose a provider and create a new account.'),
        });
        const addBtn = new Gtk.Button({
            label: _('Add'),
            css_classes: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        addRow.add_suffix(addBtn);
        addRow.set_activatable_widget(addBtn);
        addGroup.add(addRow);

        addBtn.connect('clicked', () => {
            this._showAddDialog();
        });
    }

    _renderAccountRows() {
        // Clear existing rows: Adw.PreferencesGroup has no get_rows(), so
        // rebuild the group from scratch.
        this._page.remove(this._accountsGroup);
        this._accountsGroup = new Adw.PreferencesGroup({
            title: _('Configured Accounts'),
            description: _('Each account fetches usage independently.'),
        });
        // Re-insert before the "add account" group (which is the last child).
        this._page.insert(this._accountsGroup, 0);

        const cfg = config.load();
        for (const acc of cfg.accounts)
            this._accountsGroup.add(this._buildAccountRow(acc));
    }

    _buildAccountRow(acc) {
        const provName = PROVIDER_INFO[acc.provider]?.name || acc.provider;
        const row = new Adw.ExpanderRow({
            title: acc.label || provName,
            subtitle: provName,
        });

        // Enabled switch
        const switchBtn = new Gtk.Switch({
            active: acc.enabled !== false,
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(switchBtn);
        switchBtn.connect('notify::active', w => {
            this._updateAccount(acc.id, a => { a.enabled = w.active; });
        });

        // Label field
        const labelBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12,
        });

        const labelEntry = new Adw.EntryRow({ title: _('Account label') });
        labelEntry.set_text(acc.label || '');
        labelEntry.set_show_apply_button(true);
        labelBox.append(labelEntry);
        labelEntry.connect('apply', () => {
            this._updateAccount(acc.id, a => { a.label = labelEntry.get_text().trim(); });
        });

        row.add_row(labelBox);

        // Provider-specific credential fields (added as additional rows)
        this._addCredentialRows(row, acc);

        // Remove button
        const removeBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            halign: Gtk.Align.CENTER,
            margin_top: 12, margin_bottom: 12,
        });
        const removeBtn = new Gtk.Button({
            label: _('Remove Account'),
            css_classes: ['destructive-action'],
        });
        removeBox.append(removeBtn);
        row.add_row(removeBox);

        removeBtn.connect('clicked', () => {
            this._removeAccount(acc.id);
        });

        return row;
    }

    _addCredentialRows(row, acc) {
        const c = acc.credentials || {};

        if (acc.provider === 'zai') {
            // Endpoint
            const endpointRow = new Adw.ComboRow({
                title: _('Region'),
                model: Gtk.StringList.new([_('International (api.z.ai)'), _('China (open.bigmodel.cn)')]),
                selected: c.endpoint === 'cn' ? 1 : 0,
            });
            row.add_row(endpointRow);
            endpointRow.connect('notify::selected', r => {
                this._updateAccount(acc.id, a => {
                    a.credentials.endpoint = r.selected === 1 ? 'cn' : 'intl';
                });
            });

            // API key
            row.add_row(this._entryRow(_('API Key'), c.apiKey || '', true, val =>
                this._updateAccount(acc.id, a => { a.credentials.apiKey = val; })));

            // OAuth
            const oauthRow = new Adw.ActionRow({ title: _('OAuth Login') });
            row.add_row(oauthRow);
            const loginBtn = new Gtk.Button({
                label: _('Log In with Z.AI'),
                css_classes: ['suggested-action'],
                valign: Gtk.Align.CENTER,
            });
            const logoutBtn = new Gtk.Button({
                label: _('Log Out'),
                css_classes: ['destructive-action'],
                valign: Gtk.Align.CENTER,
                visible: !!(c.oauthToken),
            });
            oauthRow.add_suffix(loginBtn);
            oauthRow.add_suffix(logoutBtn);
            loginBtn.connect('clicked', () => {
                this._startZaiOAuth(acc, oauthRow, loginBtn, logoutBtn);
            });
            logoutBtn.connect('clicked', () => {
                this._updateAccount(acc.id, a => {
                    a.credentials.oauthToken = '';
                    a.credentials.oauthRefresh = '';
                    a.credentials.oauthExpiry = 0;
                });
                logoutBtn.visible = false;
            });
        }

        if (acc.provider === 'opencode-go') {
            row.add_row(this._entryRow(_('Workspace ID'), c.workspaceId || '', false, val =>
                this._updateAccount(acc.id, a => { a.credentials.workspaceId = val; })));
            row.add_row(this._entryRow(_('Auth Cookie'), c.authCookie || '', true, val =>
                this._updateAccount(acc.id, a => { a.credentials.authCookie = val; })));
            row.add_row(this._entryRow(_('Server ID (x-server-id)'), c.serverId || '', false, val =>
                this._updateAccount(acc.id, a => { a.credentials.serverId = val; })));
        }

        if (acc.provider === 'openai') {
            row.add_row(this._entryRow(_('OAuth Access Token'), c.oauthToken || '', true, val =>
                this._updateAccount(acc.id, a => { a.credentials.oauthToken = val; })));
            row.add_row(this._entryRow(_('Refresh Token (optional)'), c.oauthRefresh || '', true, val =>
                this._updateAccount(acc.id, a => { a.credentials.oauthRefresh = val; })));
        }

        if (acc.provider === 'deepseek') {
            row.add_row(this._entryRow(_('API Key'), c.apiKey || '', true, val =>
                this._updateAccount(acc.id, a => { a.credentials.apiKey = val; })));
        }
    }

    _entryRow(title, text, hidden, onApply) {
        const entry = new Adw.EntryRow({ title });
        entry.set_text(text);
        entry.set_show_apply_button(true);
        if (hidden) entry.visibility = false;
        entry.connect('apply', () => {
            onApply(entry.get_text().trim());
        });
        return entry;
    }

    /* ── Config mutations ── */

    _updateAccount(accountId, mutator) {
        const cfg = config.load();
        const acc = cfg.accounts.find(a => a.id === accountId);
        if (!acc) return;
        if (!acc.credentials) acc.credentials = {};
        mutator(acc);
        config.save(cfg);
        // Don't re-render rows here — rebuilding destroys the entry widgets
        // while the user is typing in another field. The file monitor in
        // extension.js will pick up the change and refresh the panel.
    }

    _removeAccount(accountId) {
        const cfg = config.load();
        cfg.accounts = cfg.accounts.filter(a => a.id !== accountId);
        config.save(cfg);
        this._renderAccountRows();
    }

    _addAccount(provider, label) {
        const cfg = config.load();
        const acc = {
            id: config.genId(),
            label: label || PROVIDER_INFO[provider]?.name || provider,
            provider,
            enabled: true,
            credentials: this._defaultCredentials(provider),
        };
        cfg.accounts.push(acc);
        config.save(cfg);
        this._renderAccountRows();
    }

    _defaultCredentials(provider) {
        if (provider === 'zai') return { apiKey: '', oauthToken: '', oauthRefresh: '', oauthExpiry: 0, endpoint: 'intl' };
        if (provider === 'openai') return { oauthToken: '', oauthRefresh: '', oauthExpiry: 0 };
        if (provider === 'deepseek') return { apiKey: '' };
        if (provider === 'opencode-go') return { workspaceId: '', authCookie: '', serverId: '' };
        return {};
    }

    _showAddDialog() {
        const dialog = new Adw.MessageDialog({
            heading: _('Add Account'),
            body: _('Choose a provider and optional label.'),
            transient_for: this._window,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            margin_top: 12, margin_bottom: 12,
        });

        const providerModel = Gtk.StringList.new(
            Object.values(PROVIDER_INFO).map(p => p.name));
        const providerCombo = new Gtk.DropDown({ model: providerModel });
        box.append(new Gtk.Label({ label: _('Provider'), halign: Gtk.Align.START }));
        box.append(providerCombo);

        const labelEntry = new Gtk.Entry({ placeholder_text: _('Account label (optional)') });
        box.append(new Gtk.Label({ label: _('Label'), halign: Gtk.Align.START }));
        box.append(labelEntry);

        dialog.set_extra_child(box);

        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('add', _('Add'));
        dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);

        dialog.connect('response', (d, response) => {
            if (response === 'add') {
                const idx = providerCombo.get_selected();
                const providerId = Object.keys(PROVIDER_INFO)[idx];
                this._addAccount(providerId, labelEntry.get_text().trim());
            }
            d.close();
        });

        dialog.present();
    }

    /* ── Refresh page (gsettings) ── */

    _buildRefreshPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Refresh'), icon_name: 'view-refresh-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: _('Update Interval'),
            description: _('How often to fetch usage data from all enabled accounts.'),
        });
        page.add(group);

        const intervalRow = new Adw.SpinRow({
            title: _('Refresh interval (seconds)'),
            adjustment: Gtk.Adjustment.new(
                settings.get_int('refresh-interval'), 30, 3600, 10, 30, 0),
            climb_rate: 10, digits: 0,
        });
        group.add(intervalRow);
        intervalRow.connect('notify::value', row => {
            settings.set_int('refresh-interval', Math.round(row.value));
        });
    }

    /* ── Z.AI OAuth flow ── */

    async _startZaiOAuth(acc, statusRow, loginBtn, logoutBtn) {
        const c = acc.credentials || {};
        const endpoint = c.endpoint === 'cn' ? 'cn' : 'intl';
        const provider = endpoint === 'cn' ? 'bigmodel' : 'zai';

        const oauthUrls = {
            intl: {
                init: 'https://api.z.ai/oauth/cli/init',
                poll: 'https://api.z.ai/oauth/cli/poll',
                auth: 'https://chat.z.ai',
            },
            cn: {
                init: 'https://open.bigmodel.cn/oauth/cli/init',
                poll: 'https://open.bigmodel.cn/oauth/cli/poll',
                auth: 'https://bigmodel.cn',
            },
        };
        const oauthConfig = oauthUrls[endpoint] || oauthUrls.intl;

        loginBtn.sensitive = false;
        loginBtn.label = _('Starting login...');
        statusRow.set_subtitle(_('Initializing OAuth flow...'));

        try {
            const session = new Soup.Session();
            const initBody = JSON.stringify({ provider });

            const initMsg = Soup.Message.new('POST', oauthConfig.init);
            initMsg.set_request_body_from_bytes(
                'application/json',
                new GLib.Bytes(new TextEncoder().encode(initBody)));

            const initResult = await new Promise((resolve, reject) => {
                session.send_and_read_async(initMsg, GLib.PRIORITY_DEFAULT, null,
                    (s, res) => {
                        try {
                            const bytes = s.send_and_read_finish(res);
                            const body = new TextDecoder().decode(
                                bytes?.get_data() ?? new Uint8Array(0));
                            resolve({ status: initMsg.get_status(), body });
                        } catch (e) { reject(e); }
                    });
            });

            if (initResult.status !== 200) {
                throw new Error(`OAuth init failed: HTTP ${initResult.status}`);
            }

            const initData = JSON.parse(initResult.body);
            const authUrl = initData.authorize_url ?? initData.data?.authorize_url;
            const flowId = initData.flow_id ?? initData.data?.flow_id;
            const pollToken = initData.poll_token ?? initData.data?.poll_token;

            if (!authUrl || !flowId)
                throw new Error('Unexpected OAuth init response');

            statusRow.set_subtitle(_('Open browser to complete login...'));
            loginBtn.label = _('Waiting for authentication...');

            try { Gio.AppInfo.launch_default_for_uri(authUrl, null); } catch (e) {
                statusRow.set_subtitle(_(`Open: ${authUrl}`));
            }

            const pollUrl = `${oauthConfig.poll}/${flowId}`;
            const maxAttempts = 120;

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                await this._sleep(1000);
                loginBtn.label = _(`Waiting... (${attempt}s)`);

                const pollMsg = Soup.Message.new('GET', pollUrl);
                if (pollToken)
                    pollMsg.get_request_headers().append('Authorization', `Bearer ${pollToken}`);

                const pollResult = await new Promise((resolve, reject) => {
                    session.send_and_read_async(pollMsg, GLib.PRIORITY_DEFAULT, null,
                        (s, res) => {
                            try {
                                const bytes = s.send_and_read_finish(res);
                                const body = new TextDecoder().decode(
                                    bytes?.get_data() ?? new Uint8Array(0));
                                resolve({ status: pollMsg.get_status(), body });
                            } catch (e) { reject(e); }
                        });
                });

                if (pollResult.status !== 200) continue;

                const pollData = JSON.parse(pollResult.body);
                const status = pollData.status ?? pollData.data?.status ?? 'pending';

                if (status === 'ready') {
                    const token = pollData.token ?? pollData.access_token
                        ?? pollData.data?.token ?? pollData.data?.access_token;
                    const refreshToken = pollData.refresh_token ?? pollData.data?.refresh_token ?? '';
                    const expiresIn = pollData.expires_in ?? pollData.data?.expires_in ?? 0;

                    if (!token) throw new Error('OAuth succeeded but no token returned');

                    this._updateAccount(acc.id, a => {
                        a.credentials.oauthToken = token;
                        if (refreshToken) a.credentials.oauthRefresh = refreshToken;
                        if (expiresIn > 0)
                            a.credentials.oauthExpiry = Math.floor(Date.now() / 1000) + expiresIn;
                    });

                    statusRow.set_subtitle(_('Logged in via OAuth'));
                    loginBtn.label = _('Log In with Z.AI');
                    loginBtn.sensitive = true;
                    logoutBtn.visible = true;
                    return;
                } else if (status === 'failed') {
                    const errMsg = pollData.message ?? pollData.error ?? 'Authentication failed';
                    throw new Error(errMsg);
                }
            }

            throw new Error('Authentication timed out. Please try again.');
        } catch (e) {
            logError(e, 'Z.AI OAuth flow failed');
            statusRow.set_subtitle(`Login failed: ${e.message}`);
            loginBtn.label = _('Log In with Z.AI');
            loginBtn.sensitive = true;
        }
    }

    _sleep(ms) {
        return new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }
}
