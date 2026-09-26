export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: "TikTok Analytics Telegram Bot",
    message: "Bot server is online. Send a TikTok URL to the bot.",
    endpoints: {
      webhook: "/api/webhook",
      setup: "/api/setup-webhook",
      health: "/api/health"
    }
  });
}
