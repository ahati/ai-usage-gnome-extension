# Z.AI Usage Monitor — GNOME Shell Extension

Monitor your [Z.AI](https://z.ai) (Zhipu AI) GLM Coding Plan usage limits directly from the GNOME Shell top panel.

## Features

- **Live usage display** — Shows your current session/token usage percentage in the top panel
- **Color-coded alerts** — Green (normal), orange (high), red (critical) based on configurable thresholds
- **Detailed popup menu** — View 5-hour token usage, weekly token usage, time limits, and reset times
- **OAuth login** — Authenticate via the same OAuth flow used by ZCode CLI
- **API key support** — Alternative authentication using a Z.AI API key
- **Configurable refresh interval** — Set how often usage data is fetched (30s to 1hr)

## Requirements

- GNOME Shell 45, 46, 47, or 48
- A Z.AI account with a [GLM Coding Plan](https://z.ai)

## Installation

### Method 1: Manual install

```bash
# Clone or copy the extension
cp -r zai-usage-extension ~/.local/share/gnome-shell/extensions/zai-usage-monitor@cowork.user

# Compile the GSettings schema
glib-compile-schemas ~/.local/share/gnome-shell/extensions/zai-usage-monitor@cowork.user/schemas/

# Restart GNOME Shell (X11) or log out and back in (Wayland)
Alt+F2, type 'r', Enter

# Enable the extension
gnome-extensions enable zai-usage-monitor@cowork.user
```

### Method 2: Quick install script

```bash
cd zai-usage-extension
./install.sh   # (if provided)
```

## Usage

1. After enabling the extension, click the system icon (default: gear icon) in the top panel
2. Open **Preferences** from the menu
3. Choose your authentication method:
   - **API Key**: Enter your key from [z.ai/manage-apikey](https://z.ai/manage-apikey)
   - **OAuth Login**: Click "Log In with Z.AI" and authenticate in your browser
4. The panel will update automatically

## Configuration

All settings are available in the Preferences dialog:

| Setting | Description | Default |
|---------|-------------|---------|
| Endpoint | API region (International / China) | International |
| API Key | Direct API key authentication | — |
| Refresh interval | How often to fetch usage data | 300s |
| Show percentage | Display % in the top panel | Enabled |
| High threshold | % for orange warning | 80% |
| Critical threshold | % for red alert | 95% |

## API Endpoints Used

- `GET /api/monitor/usage/quota/limit` — Fetches token/time usage limits
- `POST /oauth/cli/init` — Initiates OAuth flow
- `GET /oauth/cli/poll/{flow_id}` — Polls OAuth login status

> These endpoints are used internally by the Z.AI subscription management UI.
> They work with both OAuth tokens and API keys.

## License

MIT
