export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const appUrl = process.env.APP_URL;

  if (!token) {
    return res.status(500).json({
      ok: false,
      error: "Missing TELEGRAM_BOT_TOKEN environment variable."
    });
  }

  if (!appUrl) {
    return res.status(500).json({
      ok: false,
      error: "Missing APP_URL environment variable."
    });
  }

  const webhookUrl = `${appUrl.replace(/\/$/, "")}/api/webhook`;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`
    );

    const data = await response.json();

    return res.status(response.ok && data.ok ? 200 : 502).json({
      telegram: data,
      webhook_url: webhookUrl
    });
  } catch (error) {
    console.error("Webhook setup error:", error);
    return res.status(500).json({
      ok: false,
      error: "Could not contact Telegram.",
      details: error instanceof Error ? error.message : String(error)
    });
  }
}
