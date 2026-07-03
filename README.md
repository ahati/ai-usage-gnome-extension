# AI Usage Monitor — GNOME Shell Extension

Monitor usage limits and balances for multiple AI providers directly from the GNOME Shell top panel. Supports **Z.AI**, **OpenCode Go**, **OpenAI (ChatGPT)**, and **DeepSeek** — with multiple accounts per provider.

## Features

- **Multi-provider, multi-account** — Add unlimited accounts per provider, each fetched independently
- **Live usage display** — Color-coded indicator (green/orange/red) in the top panel shows worst-case usage
- **Progress bars** — Visual free/used quota bars with reset times for each usage window
- **Provider tabs** — Switch between accounts with logos in the popup menu
- **OAuth login** — Browser-based OAuth for Z.AI accounts
- **API key support** — Direct API key authentication for Z.AI and DeepSeek
- **Balance display** — DeepSeek account balance monitoring
- **Configurable refresh interval** — 30s to 1hr

## Requirements

- GNOME Shell 45–50
- One or more accounts with a supported provider

## Installation

```bash
cd ai-usage-extension
./install.sh

# Restart GNOME Shell (X11: Alt+F2 → r → Enter; Wayland: log out and back in)
gnome-extensions enable ai-usage-monitor@ahati
```

## Usage

1. Click the indicator icon in the top panel
2. Open **Preferences** → **Accounts** tab
3. Click **Add Account**, choose a provider, and enter credentials:
   - **Z.AI**: API key (from [z.ai/manage-apikey](https://z.ai/manage-apikey)) or OAuth login
   - **OpenCode Go**: Workspace ID + auth cookie (from browser DevTools)
   - **OpenAI**: OAuth access token
   - **DeepSeek**: API key (from [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys))
4. The panel updates automatically

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| Display mode | Show "used" or "remaining" quota | Used |
| Show logos | Provider logos on tabs | Enabled |
| High threshold | % for orange warning | 80% |
| Critical threshold | % for red alert | 95% |
| Refresh interval | How often to fetch data | 300s |

Account credentials are stored in `~/.local/share/.ai-usage-ext/config.json`.

## Supported Providers

| Provider | Auth | Data |
|----------|------|------|
| Z.AI | API key / OAuth | Token & time usage limits |
| OpenCode Go | Workspace ID + cookie | Rolling/weekly/monthly usage |
| OpenAI | OAuth token | Usage windows + credits |
| DeepSeek | API key | Account balance |

## License

MIT
