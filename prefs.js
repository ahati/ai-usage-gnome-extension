/* Z.AI Usage Monitor - Preferences Dialog
 *
 * Multi-provider preferences with per-provider auth configuration.
 *
 * SPDX-License-Identifier: MIT
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Soup from 'gi://Soup?version=3.0';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ZaiUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        this._buildGeneralPage(window, settings);
        this._buildProvidersPage(window, settings);
        this._buildZaiPage(window, settings);
        this._buildOpenCodeGoPage(window, settings);
        this._buildOpenAIPage(window, settings);
        this._buildDeepSeekPage(window, settings);
        this._buildRefreshPage(window, settings);
    }

    /* ── General page ── */

    _buildGeneralPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('General'), icon_name: 'emblem-system-symbolic',
        });
        window.add(page);

        const displayGroup = new Adw.PreferencesGroup({
            title: _('Panel Display'),
        });
        page.add(displayGroup);

        const showPctRow = new Adw.SwitchRow({
            title: _('Show percentage in panel'),
            subtitle: _('Display the worst-case usage percentage next to the icon.'),
            active: settings.get_boolean('show-percentage-in-panel'),
        });
        displayGroup.add(showPctRow);
        showPctRow.connect('notify::active', row => {
            settings.set_boolean('show-percentage-in-panel', row.active);
        });

        const thresholdGroup = new Adw.PreferencesGroup({
            title: _('Usage Thresholds'),
        });
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

    /* ── Providers enable/disable page ── */

    _buildProvidersPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Providers'), icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: _('Enabled Providers'),
            description: _('Select which providers to fetch quota data from.'),
        });
        page.add(group);

        const providers = [
            { id: 'zai', name: 'Z.AI (Zhipu)' },
            { id: 'opencode-go', name: 'OpenCode Go' },
            { id: 'openai', name: 'OpenAI (ChatGPT Plus/Pro)' },
            { id: 'deepseek', name: 'DeepSeek' },
        ];

        const enabledIds = settings.get_strv('enabled-providers') || ['zai', 'openai', 'deepseek'];
        const enabledSet = new Set(enabledIds.map(s => s.trim().toLowerCase()));

        const rows = {};
        for (const p of providers) {
            const row = new Adw.SwitchRow({
                title: p.name,
                active: enabledSet.has(p.id),
            });
            group.add(row);
            rows[p.id] = row;

            row.connect('notify::active', () => {
                this._saveEnabledProviders(settings, providers, rows);
            });
        }
    }

    _saveEnabledProviders(settings, providers, rows) {
        const enabled = [];
        for (const p of providers) {
            if (rows[p.id] && rows[p.id].active)
                enabled.push(p.id);
        }
        if (enabled.length === 0) enabled.push('zai'); // keep at least one
        settings.set_strv('enabled-providers', enabled);
    }

    /* ── Z.AI page ── */

    _buildZaiPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Z.AI'), icon_name: 'network-server-symbolic',
        });
        window.add(page);

        // Endpoint
        const epGroup = new Adw.PreferencesGroup({
            title: _('Region'),
        });
        page.add(epGroup);

        const epRow = new Adw.ComboRow({
            title: _('API Endpoint'),
            subtitle: _('Select your Z.AI region.'),
            model: Gtk.StringList.new([
                'International (api.z.ai)',
                'China (open.bigmodel.cn)',
            ]),
            selected: settings.get_string('zai-endpoint') === 'cn' ? 1 : 0,
        });
        epGroup.add(epRow);
        epRow.connect('notify::selected', row => {
            settings.set_string('zai-endpoint', row.selected === 1 ? 'cn' : 'intl');
        });

        // API Key
        const keyGroup = new Adw.PreferencesGroup({
            title: _('API Key Authentication'),
            description: _('Enter your Z.AI API key from https://z.ai/manage-apikey'),
        });
        page.add(keyGroup);

        const apiKeyRow = new Adw.EntryRow({ title: _('API Key') });
        apiKeyRow.set_text(settings.get_string('zai-api-key'));
        apiKeyRow.set_show_apply_button(true);
        apiKeyRow.visibility = false;
        keyGroup.add(apiKeyRow);
        apiKeyRow.connect('apply', () => {
            settings.set_string('zai-api-key', apiKeyRow.get_text().trim());
        });

        // OAuth
        const oauthGroup = new Adw.PreferencesGroup({
            title: _('OAuth Login'),
            description: _('Log in with your Z.AI account using OAuth.'),
        });
        page.add(oauthGroup);

        const hasOauth = !!(settings.get_string('zai-oauth-token'));
        const oauthStatusRow = new Adw.ActionRow({
            title: _('Status'),
            subtitle: hasOauth ? _('Logged in via OAuth') : _('Not logged in'),
        });
        oauthGroup.add(oauthStatusRow);

        const loginBtn = new Gtk.Button({
            label: _('Log In with Z.AI'),
            css_classes: ['suggested-action'],
        });
        oauthStatusRow.add_suffix(loginBtn);
        oauthStatusRow.set_activatable_widget(loginBtn);

        const logoutBtn = new Gtk.Button({
            label: _('Log Out'),
            css_classes: ['destructive-action'],
            visible: hasOauth,
        });
        oauthStatusRow.add_suffix(logoutBtn);

        loginBtn.connect('clicked', () => {
            this._startZaiOAuth(settings, oauthStatusRow, loginBtn, logoutBtn);
        });

        logoutBtn.connect('clicked', () => {
            settings.set_string('zai-oauth-token', '');
            settings.set_string('zai-oauth-refresh', '');
            settings.set_int('zai-oauth-expiry', 0);
            oauthStatusRow.set_subtitle(_('Not logged in'));
            logoutBtn.visible = false;
            loginBtn.sensitive = true;
        });
    }

    /* ── OpenCode Go page ── */

    _buildOpenCodeGoPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('OpenCode Go'), icon_name: 'network-server-symbolic',
        });
        window.add(page);

        const infoGroup = new Adw.PreferencesGroup({
            title: _('Dashboard Credentials'),
            description: _('These are extracted from your OpenCode browser session. Open the OpenCode Go dashboard in your browser, then use DevTools to copy the workspace ID (from the URL) and auth cookie value.'),
        });
        page.add(infoGroup);

        const widRow = new Adw.EntryRow({
            title: _('Workspace ID'),
        });
        widRow.set_text(settings.get_string('opencode-go-workspace-id'));
        widRow.set_show_apply_button(true);
        infoGroup.add(widRow);
        widRow.connect('apply', () => {
            settings.set_string('opencode-go-workspace-id', widRow.get_text().trim());
        });

        const cookieRow = new Adw.EntryRow({
            title: _('Auth Cookie'),
        });
        cookieRow.set_text(settings.get_string('opencode-go-auth-cookie'));
        cookieRow.set_show_apply_button(true);
        cookieRow.visibility = false;
        infoGroup.add(cookieRow);
        cookieRow.connect('apply', () => {
            settings.set_string('opencode-go-auth-cookie', cookieRow.get_text().trim());
        });

        const statusGroup = new Adw.PreferencesGroup({ title: _('Status') });
        page.add(statusGroup);

        const hasWid = !!(settings.get_string('opencode-go-workspace-id'));
        const hasCookie = !!(settings.get_string('opencode-go-auth-cookie'));
        const status = (hasWid && hasCookie) ? _('Configured') : _('Not configured');
        const statusRow = new Adw.ActionRow({
            title: _('Status'), subtitle: status,
        });
        statusGroup.add(statusRow);
    }

    /* ── OpenAI page ── */

    _buildOpenAIPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('OpenAI'), icon_name: 'network-server-symbolic',
        });
        window.add(page);

        const oauthGroup = new Adw.PreferencesGroup({
            title: _('OAuth Token'),
            description: _('Enter your ChatGPT OAuth access token. You can extract this from your browser session or OpenCode auth.json.'),
        });
        page.add(oauthGroup);

        const tokenRow = new Adw.EntryRow({
            title: _('OAuth Access Token'),
        });
        tokenRow.set_text(settings.get_string('openai-oauth-token'));
        tokenRow.set_show_apply_button(true);
        tokenRow.visibility = false;
        oauthGroup.add(tokenRow);
        tokenRow.connect('apply', () => {
            settings.set_string('openai-oauth-token', tokenRow.get_text().trim());
        });

        const refreshRow = new Adw.EntryRow({
            title: _('Refresh Token (optional)'),
        });
        refreshRow.set_text(settings.get_string('openai-oauth-refresh'));
        refreshRow.set_show_apply_button(true);
        refreshRow.visibility = false;
        oauthGroup.add(refreshRow);
        refreshRow.connect('apply', () => {
            settings.set_string('openai-oauth-refresh', refreshRow.get_text().trim());
        });

        const statusGroup = new Adw.PreferencesGroup({
            title: _('Status'),
        });
        page.add(statusGroup);

        const hasToken = !!(settings.get_string('openai-oauth-token'));
        const statusRow = new Adw.ActionRow({
            title: _('Token'),
            subtitle: hasToken ? _('Configured') : _('Not configured'),
        });
        statusGroup.add(statusRow);
    }

    /* ── DeepSeek page ── */

    _buildDeepSeekPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('DeepSeek'), icon_name: 'network-server-symbolic',
        });
        window.add(page);

        const keyGroup = new Adw.PreferencesGroup({
            title: _('API Key'),
            description: _('Enter your DeepSeek API key from https://platform.deepseek.com/api_keys'),
        });
        page.add(keyGroup);

        const apiKeyRow = new Adw.EntryRow({ title: _('API Key') });
        apiKeyRow.set_text(settings.get_string('deepseek-api-key'));
        apiKeyRow.set_show_apply_button(true);
        apiKeyRow.visibility = false;
        keyGroup.add(apiKeyRow);
        apiKeyRow.connect('apply', () => {
            settings.set_string('deepseek-api-key', apiKeyRow.get_text().trim());
        });

        const statusGroup = new Adw.PreferencesGroup({ title: _('Status') });
        page.add(statusGroup);

        const hasKey = !!(settings.get_string('deepseek-api-key'));
        const statusRow = new Adw.ActionRow({
            title: _('API Key'),
            subtitle: hasKey ? _('Configured') : _('Not configured'),
        });
        statusGroup.add(statusRow);
    }

    /* ── Refresh page ── */

    _buildRefreshPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Refresh'), icon_name: 'view-refresh-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: _('Update Interval'),
            description: _('How often to fetch usage data from all enabled providers.'),
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

    async _startZaiOAuth(settings, statusRow, loginBtn, logoutBtn) {
        const endpoint = settings.get_string('zai-endpoint') === 'cn' ? 'cn' : 'intl';
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
        const config = oauthUrls[endpoint] || oauthUrls.intl;

        loginBtn.sensitive = false;
        loginBtn.label = _('Starting login...');
        statusRow.set_subtitle(_('Initializing OAuth flow...'));

        try {
            const session = new Soup.Session();
            const initBody = JSON.stringify({ provider });

            const initMsg = Soup.Message.new('POST', config.init);
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

            const pollUrl = `${config.poll}/${flowId}`;
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

                    settings.set_string('zai-oauth-token', token);
                    if (refreshToken) settings.set_string('zai-oauth-refresh', refreshToken);
                    if (expiresIn > 0)
                        settings.set_int('zai-oauth-expiry', Math.floor(Date.now() / 1000) + expiresIn);

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