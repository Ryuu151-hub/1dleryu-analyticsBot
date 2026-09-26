# TikTok Analytics Telegram Bot (Vercel)

Telegram bot that analyzes TikTok videos using the TikWM API.

## Flow

```
User sends TikTok URL
        ↓
Telegram Bot (webhook)
        ↓
Vercel serverless function
        ↓
TikWM API
        ↓
Video metadata + stats
        ↓
Formatted analytics reply
```

## Environment variables

In the Vercel project → Settings → Environment Variables, add:

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Token from [@BotFather](https://t.me/BotFather) |
| `APP_URL` | Yes | Your deployment URL, e.g. `https://your-bot.vercel.app` |
| `TIKWM_API_KEY` | No | Optional paid key from [tikwmapi.com](https://tikwmapi.com). Without it the free `tikwm.com` endpoint is used. |
| `TIKWM_API_URL` | No | Override free base URL (default `https://tikwm.com/api/`) |

Use **Production** (and Preview if you want).

Never commit tokens to Git.

## Deploy

1. Push this folder to a GitHub repo (or import the folder in the Vercel dashboard).
2. Create a new Vercel project from that repo.
3. Add the environment variables above.
4. Deploy.

## Set the Telegram webhook

After the first successful deploy, open:

```
https://YOUR-APP.vercel.app/api/setup-webhook
```

A successful response looks like:

```json
{
  "telegram": { "ok": true, ... },
  "webhook_url": "https://YOUR-APP.vercel.app/api/webhook"
}
```

## Test

- Homepage: `https://YOUR-APP.vercel.app/api/index`
- Health: `https://YOUR-APP.vercel.app/api/health`
- In Telegram: `/start`, then paste any public TikTok video URL.

### Supported URL formats

- `https://www.tiktok.com/@user/video/123...`
- `https://vm.tiktok.com/xxxxx`
- `https://vt.tiktok.com/xxxxx`
- Bare numeric video ID (15–25 digits)

## What the bot returns

- Caption
- Author name + @handle
- Region, post date, duration, ad flag
- Views, likes, comments, shares, downloads, saves
- Engagement rate = (likes + comments + shares) / views
- Music / sound title & artist
- Link back to the video

## Notes

- Free TikWM has rate limits. For production volume, set `TIKWM_API_KEY`.
- The bot answers callback buttons from `/start` (Help / My ID).
- Markdown is used for formatting; if Telegram rejects a message the bot retries as plain text.
