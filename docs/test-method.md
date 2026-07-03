# Deploy, Test & Debug with Nested GNOME Shell

A nested GNOME Shell session runs inside a window on your existing desktop. You can restart it instantly without logging out, making it the fastest way to iterate on extension code during development.

## 1. Install dependencies

```bash
sudo apt install -y mutter-dev-bin
```

Verify:

```bash
gnome-shell --help 2>&1 | grep devkit
# Should show: --devkit    Run development kit
```

## 2. Quick test cycle

```bash
# 1. Install the extension
./install.sh

# 2. Launch nested shell in a terminal window
dbus-run-session gnome-shell --devkit --wayland

# 3. In another terminal, enable the extension inside the nested session
gnome-extensions enable zai-usage-monitor@cowork.user

# 4. Test — click the panel indicator, check menu, verify data

# 5. Make code changes to extension.js / providers/*.js

# 6. Re-install and restart nested shell
./install.sh
# Close nested shell window and relaunch dbus-run-session gnome-shell --devkit --wayland
gnome-extensions enable zai-usage-monitor@cowork.user

# 7. Repeat from step 4
```

## 3. One-liner reload script

Save as `dev-reload.sh`:

```bash
#!/bin/bash
# Reload extension in nested shell — run from project root
UUID="zai-usage-monitor@cowork.user"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

set -e
rm -rf "${EXT_DIR}"
mkdir -p "${EXT_DIR}/schemas" "${EXT_DIR}/providers"
cp extension.js prefs.js stylesheet.css metadata.json "${EXT_DIR}/"
cp providers/*.js "${EXT_DIR}/providers/"
cp schemas/*.xml "${EXT_DIR}/schemas/"
cp -r media "${EXT_DIR}/" 2>/dev/null || true
glib-compile-schemas "${EXT_DIR}/schemas/"
chmod 664 "${EXT_DIR}/"*.{js,css,json} "${EXT_DIR}/providers/"*.js "${EXT_DIR}/schemas/"*

echo "Installed. Restart nested shell or run:"
echo "  gnome-extensions enable ${UUID}"
```

Usage:

```bash
# Terminal 1: start nested shell
dbus-run-session gnome-shell --devkit --wayland

# Terminal 2: after each code change
./dev-reload.sh
# Close nested shell, relaunch, enable extension
```

## 4. Debugging techniques

### 4a. Read extension logs

```bash
# Watch logs from inside the nested shell session
journalctl --user -f | grep "\[ai-usage\]"
```

The extension logs provider fetch results with the `[ai-usage]` prefix.

### 4b. Add custom logging

In `extension.js` or provider files, use the global `log()` function:

```javascript
log(`[ai-usage] Debug: ${someVariable}`);
log(`[ai-usage] ${provider.id}: result=${JSON.stringify(result)}`);
```

`log()` output appears in the user journal. `logError()` is also available for error-level messages.

### 4c. Check extension state via DBus

```bash
UUID="zai-usage-monitor@cowork.user"

# Get full extension info (state, enabled, error)
busctl --user call org.gnome.Shell /org/gnome/Shell \
    org.gnome.Shell.Extensions GetExtensionInfo s "$UUID"

# Get only error field
busctl --user call org.gnome.Shell /org/gnome/Shell \
    org.gnome.Shell.Extensions GetExtensionInfo s "$UUID" \
    | grep -oP '"error" s "\K[^"]*'

# List all known extensions
gnome-extensions list

# Enable / disable
gnome-extensions enable "$UUID"
gnome-extensions disable "$UUID"

# List extension errors
busctl --user call org.gnome.Shell /org/gnome/Shell \
    org.gnome.Shell.Extensions GetExtensionErrors s "$UUID"
```

### 4d. Test API calls directly

```bash
# Test Z.AI API
API_KEY=$(gsettings get org.gnome.shell.extensions.zai-usage zai-api-key | tr -d "'")
curl -s -H "Authorization: Bearer $API_KEY" \
    "https://api.z.ai/api/monitor/usage/quota/limit" | python3 -m json.tool

# Test DeepSeek API
DS_KEY=$(gsettings get org.gnome.shell.extensions.zai-usage deepseek-api-key | tr -d "'")
curl -s -H "Authorization: Bearer $DS_KEY" \
    "https://api.deepseek.com/user/balance" | python3 -m json.tool
```

### 4e. Check GSettings

```bash
SCHEMA="org.gnome.shell.extensions.zai-usage"

# List all keys and values
gsettings list-recursively "$SCHEMA"

# Check specific keys
gsettings get "$SCHEMA" enabled-providers
gsettings get "$SCHEMA" zai-api-key
gsettings get "$SCHEMA" deepseek-api-key
gsettings get "$SCHEMA" opencode-go-workspace-id

# Set a key
gsettings set "$SCHEMA" refresh-interval 60
```

### 4f. Inspect raw DBus method calls

```bash
# Open preferences programmatically
gdbus call --session --dest org.gnome.Shell.Extensions \
    --object-path /org/gnome/Shell/Extensions \
    --method org.gnome.Shell.Extensions.OpenExtensionPrefs \
    "zai-usage-monitor@cowork.user" "" '{}'

# Force refresh (indirectly by triggering preferences)
# The extension has a "Refresh" button in the menu
```

### 4g. Check menu state

```bash
# List all menu items for the extension
busctl --user call org.gnome.Shell /org/gnome/Shell \
    org.gnome.Shell.Extensions ListExtensions \
    | grep -o '"zai-usage[^"]*"[^}]*}' | python3 -c "
import sys, re
text = sys.stdin.read()
for key in ['name', 'state', 'enabled', 'error']:
    m = re.search(rf'\"{key}\" [a-z] \"([^\"]*)\"', text)
    if m: print(f'{key}: {m.group(1)}')"
```

## 5. Provider debugging

### Check which providers are enabled

```bash
gsettings get org.gnome.shell.extensions.zai-usage enabled-providers
```

### Check if a provider has auth configured

```bash
SCHEMA="org.gnome.shell.extensions.zai-usage"
for key in zai-api-key opencode-go-workspace-id openai-oauth-token deepseek-api-key; do
    VAL=$(gsettings get "$SCHEMA" "$key")
    if [ "$VAL" = "''" ] || [ -z "$VAL" ]; then
        echo "$key: NOT CONFIGURED"
    else
        echo "$key: configured (${VAL:0:16}...)"
    fi
done
```

### Test a provider in isolation

```bash
gjs -m -c "
import { zaiProvider } from './providers/zai.js';
const Gio = imports.gi.Gio;
const Soup = imports.gi.Soup;
const schema = Gio.SettingsSchemaSource.get_default()
    .lookup('org.gnome.shell.extensions.zai-usage', true);
const settings = new Gio.Settings({settings_schema: schema});
const session = new Soup.Session();
const result = await zaiProvider.fetch(session, settings);
print(JSON.stringify(result, null, 2));
"
```

## 6. Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Schema could not be found" | `glib-compile-schemas` not run | Run `glib-compile-schemas` on both extension `schemas/` dir and `~/.local/share/glib-2.0/schemas/` |
| Extension not in `gnome-extensions list` | Shell hasn't discovered it | Restart nested shell; on main session log out/in |
| `No property X on StWidget` | Using invalid St constructor options | Check GNOME Shell St API docs; avoid `style`, `spacing`, percentage widths |
| `Tried to construct object without a GType` | Subclassing GObject without registration | Don't subclass GObject classes; use composition instead |
| Provider returns `attempted: false` | Auth not configured | Check `needsAuth()` conditions; verify gsettings keys |
| Extension loads but menu empty | `_rebuildMenu` logic bug or fetch silently failed | Add `log()` calls; check journal for `[ai-usage]` prefix |
| OpenCode Go returns 302/auth page | Cookie expired | Refresh cookie from browser DevTools → Cookies |
| Panel icon not visible | Widget sizing/visibility issue | Use simple `St.Label` instead of `St.Widget` bars |

## 7. File layout for debugging

```
~/.local/share/gnome-shell/extensions/zai-usage-monitor@cowork.user/
├── extension.js          ← Main extension logic
├── prefs.js              ← Preferences dialog
├── stylesheet.css        ← Panel/menu styling
├── metadata.json         ← UUID, version, shell-version
├── providers/
│   ├── zai.js            ← Z.AI API (api.z.ai)
│   ├── opencode-go.js    ← OpenCode Go _server API
│   ├── openai.js         ← ChatGPT usage API
│   └── deepseek.js       ← DeepSeek balance API
└── schemas/
    ├── org.gnome.shell.extensions.zai-usage.gschema.xml
    └── gschemas.compiled
```
