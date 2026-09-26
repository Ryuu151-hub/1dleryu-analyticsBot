export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: "telegram-vercel-bot",
    timestamp: new Date().toISOString()
  });
}
