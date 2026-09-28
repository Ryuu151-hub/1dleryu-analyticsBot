# TikTok Analytics Telegram Bot (Vercel)

Paste a TikTok URL → preview card → **Check** for full analytics.

## Data sources
- **TikTok web page scrape** — resolution, FPS, bitrate streams (no API key)
- **TikWM** — stats, download video/audio URLs

## Env vars
| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | BotFather token |
| `APP_URL` | Yes | e.g. `https://your-app.vercel.app` |
| `TIKWM_API_KEY` | No | Optional paid TikWM |
| `TIKWM_API_URL` | No | Default `https://tikwm.com/api/` |

**TikHub is not used.**

## Deploy
1. Upload to Vercel
2. Set env vars → Deploy
3. Open `/api/setup-webhook` once
