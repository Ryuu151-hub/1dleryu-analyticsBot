# TikTok Analytics Telegram Bot — Vercel + TikHub

Telegram bot that analyzes public TikTok videos. It prefers **TikHub TikTok App V3** for video-detail/playback data and falls back to TikWM for basic analytics if TikHub is unavailable.

## Flow

```text
User sends TikTok URL
        ↓
Telegram Bot webhook
        ↓
Vercel serverless function
        ↓
TikHub TikTok App V3
        ↓
Video detail + playback representations
        ↓
Statistics / caption / region / post time
Resolution / FPS / bitrate / codec / size
        ↓
Formatted Telegram reply
```

## TikHub endpoint used

The bot uses:

```text
GET https://api.tikhub.io/api/v1/tiktok/app/v3/fetch_one_video_by_share_url
```

with:

```text
Authorization: Bearer <TIKHUB_API_KEY>
share_url=<TikTok URL>
```

TikHub documents this endpoint as the TikTok App V3 endpoint for getting one video's data by share URL. citeturn0search7

## Environment variables

In Vercel → **Settings → Environment Variables**:

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Token from @BotFather |
| `APP_URL` | Yes | Your deployed Vercel URL |
| `TIKHUB_API_KEY` | Recommended | TikHub API key |
| `TIKWM_API_KEY` | Optional | TikWM paid API key used as fallback |
| `TIKWM_API_URL` | Optional | Override TikWM base URL |

### Important

Do **not** put `TIKHUB_API_KEY` in GitHub source code.

Use a Vercel environment variable:

```text
TIKHUB_API_KEY=your_secret_key
```

The key should also have permission for the TikHub TikTok App V3 scope used by the endpoint.

## Output

When TikHub returns playback representations, the bot attempts to show:

```text
📦 AVAILABLE QUALITIES

• normal_720_0
  576×1024 60fps • 3.50 Mbps • H264 • ~10.30 MB

• adapt_lower_720_1
  576×1024 30fps • 967 Kbps • HEVC • ~2.80 MB
```

The parser looks for TikTok fields such as `bitrateInfo`, `PlayAddr`, `Width`, `Height`, `DataSize`, `Bitrate`, `CodecType`, and quality/GearName fields. Response structures can change, so the parser accepts several common field-name variants.

## Shadowban

TikHub's video-detail response does **not itself establish a reliable TikTok shadowban yes/no status**. The bot therefore displays:

```text
🛡️ SHADOWBAN
Status: Not directly provided by TikHub
```

Do not label a video "shadowbanned" solely because views are low or because a single API response is missing a field.

## Deploy

1. Push this folder to GitHub.
2. Import the repository into Vercel.
3. Add the environment variables.
4. Deploy.
5. Open:

```text
https://YOUR-APP.vercel.app/api/setup-webhook
```

6. Send a TikTok URL to your Telegram bot.

## Health checks

```text
/api/index
/api/health
/api/setup-webhook
```

## Notes

- TikHub App V3 requests can be billable according to the selected TikHub plan/endpoint.
- The bot does not implement TikTok's private mobile request-signing system itself; it calls TikHub's documented API.
- TikTok/TikHub response fields and availability can change.
