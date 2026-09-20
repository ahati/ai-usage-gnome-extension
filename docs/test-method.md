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

# 2. Launch nested shell in a terminal window (one private D-Bus session,
#    enables the extension automatically; logs to stdout)
#    Easiest: dbus-run-session bash launch-nested.sh
#    Manual:  dbus-run-session gnome-shell --devkit --wayland
#             (then, in another terminal on the same session:)
#             gnome-extensions enable ai-usage-monitor@ahati

# 3. Test — click the panel indicator, check menu, verify data

# 4. Make code changes to extension.js / providers/*.js

# 5. Re-install and restart nested shell
./dev-reload.sh   # fast reinstall (same files as install.sh)
# Close nested shell window and relaunch, then re-enable the extension

# 6. Repeat from step 3
```

## 3. One-liner reload script

The checked-in `dev-reload.sh` reinstalls the same file set as `install.sh`
(extension + charting + providers + media, schema compiled) without
wiping first — use it for fast iteration. Both leave repo-only helpers
(`gjs-*-test.js`, `launch-nested.sh`) out of the installed tree.

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
UUID="ai-usage-monitor@ahati"

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
API_KEY=$(gsettings get org.gnome.shell.extensions.ai-usage zai-api-key | tr -d "'")
curl -s -H "Authorization: Bearer $API_KEY" \
    "https://api.z.ai/api/monitor/usage/quota/limit" | python3 -m json.tool

# Test OpenCode Console APIs (service key from the JSON config — never echo it)
OC_KEY=$(python3 -c "import json;print([a['credentials']['apiKey'] for a in json.load(open('$HOME/.local/share/.ai-usage-ext/config.json'))['accounts'] if a['provider']=='opencode-go'][0])")
BASE="https://opencode.ai/console"
for ep in "api/go/status" "api/usage/summary?range=30d" "api/usage/models?range=30d" "api/usage/cost-by-day?range=30d" "api/usage/rows?range=24h" "api/v1/usage/export?scope=organization&range=7d"; do
    echo "=== GET $ep ==="
    curl -sk -m 25 "$BASE/$ep" -H "Authorization: Bearer $OC_KEY" -H "Accept: application/json,text/csv" | head -c 400; echo
done
unset OC_KEY
```

### 4e. Check GSettings

```bash
SCHEMA="org.gnome.shell.extensions.ai-usage"

# List all UI keys and values (display mode, thresholds, refresh, log level)
gsettings list-recursively "$SCHEMA"

# Account credentials live in JSON, NOT gsettings:
#   ~/.local/share/.ai-usage-ext/config.json
# Redacted overview (never print secrets):
python3 -c "import json; [print(a.get('label'), '|', a.get('provider'), '|', a.get('enabled'), '|', {k: ('<set>' if v else '<empty>') for k, v in a.get('credentials', {}).items()}) for a in json.load(open('$HOME/.local/share/.ai-usage-ext/config.json'))['accounts']]"

# Set a UI key
```
gsettings set "$SCHEMA" refresh-interval 60
```

### 4f. Inspect raw DBus method calls

```bash
# Open preferences programmatically
gdbus call --session --dest org.gnome.Shell.Extensions \
    --object-path /org/gnome/Shell/Extensions \
    --method org.gnome.Shell.Extensions.OpenExtensionPrefs \
    "ai-usage-monitor@ahati" "" '{}'

# Force refresh (indirectly by triggering preferences)
# The extension has a "Refresh" button in the menu
```

### 4g. Check menu state

```bash
# List all menu items for the extension
busctl --user call org.gnome.Shell /org/gnome/Shell \
    org.gnome.Shell.Extensions ListExtensions \
    | grep -o '"ai-usage[^"]*"]*"[^}]*}' | python3 -c "
import sys, re
text = sys.stdin.read()
for key in ['name', 'state', 'enabled', 'error']:
    m = re.search(rf'\"{key}\" [a-z] \"([^\"]*)\"', text)
    if m: print(f'{key}: {m.group(1)}')"
```

## 5. Provider debugging

### Check accounts and redacted credential status

```bash
python3 -c "import json; [print(a.get('label'), '|', a.get('provider'), '|', {k: ('<set>' if v else '<empty>') for k, v in a.get('credentials', {}).items()}) for a in json.load(open('$HOME/.local/share/.ai-usage-ext/config.json'))['accounts']]"
```

### Run the GJS unit tests (no credentials needed — HTTP layer is mocked)

```bash
gjs -m gjs-parse-test.js   # CSV parser: quoting, web-search rows, header-only
gjs -m gjs-flow-test.js    # provider pipeline: JSON costs, fallbacks, migration error
```

### Test the live OpenCode provider (real credentials, aggregates only)

```bash
cat > /tmp/oc-live.js << 'EOF'
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import * as config from './config.js';
import { opencodeGoProvider as P } from './providers/opencode-go.js';
async function main() {
    const s = new Soup.Session();
    const acc = config.load().accounts.find(a => a.provider === 'opencode-go' && a.enabled);
    const r = await P.fetch(s, acc.credentials);
    print(JSON.stringify({ attempted: r.attempted,
        entries: r.entries.map(e => ({ kind: e.kind, label: e.label })),
        errors: r.errors }, null, 1));
}
const loop = new GLib.MainLoop(null, false);
main().finally(() => loop.quit());
loop.run();
EOF
cp /tmp/oc-live.js ./oc-live-tmp.js && gjs -m oc-live-tmp.js; rm -f ./oc-live-tmp.js
```
# NOTE: plain gjs needs an explicit GLib.MainLoop for real network I/O;
# inside gnome-shell a main loop always runs.

## 6. Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Schema could not be found" | `glib-compile-schemas` not run | Run `glib-compile-schemas` on both extension `schemas/` dir and `~/.local/share/glib-2.0/schemas/` |
| Extension not in `gnome-extensions list` | Shell hasn't discovered it | Restart nested shell; on main session log out/in |
| `No property X on StWidget` | Using invalid St constructor options | Check GNOME Shell St API docs; avoid `style`, `spacing`, percentage widths |
| `Tried to construct object without a GType` | Subclassing GObject without registration | Don't subclass GObject classes; use composition instead |
| Provider returns `attempted: false` | No credentials set | Add the key in Preferences → Accounts, or check the JSON config |
| Extension loads but menu empty | Fetch failed or no enabled accounts | Add `log()` calls; check journal for `[ai-usage]` prefix |
| OpenCode: 401 errors | Service key missing/invalid/expired/revoked | Create a new service key in Console → Preferences → Accounts |
| OpenCode: 403 errors | Service account may not read usage | Check the key's permissions in Console |
| OpenCode shows migration error | Pre-Usage-API account (workspace ID + cookie) | Paste the service API key (`oc_sk_...`) into the account |
| OpenCode quota bars missing | Non-Go workspace (no `access.meters`) | Expected — cost/token charts still work |
| Panel icon not visible | Widget sizing/visibility issue | Use simple `St.Label` instead of `St.Widget` bars |

## 7. File layout for debugging

```
~/.local/share/gnome-shell/extensions/ai-usage-monitor@ahati/
├── extension.js          ← Main extension logic (panel, menu, fetching)
├── prefs.js              ← Preferences dialog (accounts page = JSON config)
├── charting.js           ← Cairo bar / stacked / distribution charts
├── logger.js             ← Level-gated journal logging
├── config.js             ← JSON account store (~/.local/share/.ai-usage-ext/)
├── stylesheet.css        ← Panel/menu styling
├── metadata.json         ← UUID, version, shell-version
├── providers/
│   ├── zai.js            ← Z.AI API (api.z.ai)
│   ├── opencode-go.js    ← OpenCode Console usage + logs + go-status APIs
│   ├── openai.js         ← ChatGPT usage API
│   ├── deepseek.js       ← DeepSeek balance API
│   └── peak.js / utils.js / colors.js / constants.js  ← shared helpers
└── schemas/
    ├── org.gnome.shell.extensions.ai-usage.gschema.xml
    └── gschemas.compiled
```

Repo-only helpers (not installed): `gjs-parse-test.js`, `gjs-flow-test.js`
(GJS unit tests), `install.sh`, `dev-reload.sh`, `launch-nested.sh`.
