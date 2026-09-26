export default function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Privacy Policy — 1dleryuBot</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #111; }
    h1 { font-size: 1.5rem; }
    h2 { font-size: 1.15rem; margin-top: 1.5rem; }
    p, li { color: #333; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p><strong>1dleryuBot</strong> (TikTok Analytics Telegram Bot)</p>
  <p>Last updated: September 26, 2026</p>

  <h2>What we collect</h2>
  <p>When you use the bot we may process:</p>
  <ul>
    <li>Your Telegram user ID and chat ID (required to reply to you)</li>
    <li>Messages you send to the bot (TikTok URLs and commands)</li>
    <li>Technical logs needed to keep the service running</li>
  </ul>

  <h2>How we use data</h2>
  <p>Data is used only to:</p>
  <ul>
    <li>Fetch public TikTok video statistics via TikWM API</li>
    <li>Send the analytics result back to you in Telegram</li>
    <li>Operate and improve the bot</li>
  </ul>

  <h2>What we do not do</h2>
  <ul>
    <li>We do not sell your data</li>
    <li>We do not use your data for advertising</li>
    <li>We do not store TikTok video content or your message history long-term beyond normal server logs</li>
  </ul>

  <h2>Third parties</h2>
  <p>Requests are sent to:</p>
  <ul>
    <li>Telegram Bot API</li>
    <li>TikWM API (to retrieve public video metadata)</li>
    <li>Vercel (hosting)</li>
  </ul>

  <h2>Contact</h2>
  <p>For questions about this policy, contact the bot operator via Telegram.</p>
</body>
</html>`);
}
