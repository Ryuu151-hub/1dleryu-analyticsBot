export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({
      ok: true,
      message: "Telegram webhook endpoint is online."
    });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.error("Missing TELEGRAM_BOT_TOKEN.");
    return res.status(500).json({
      ok: false,
      error: "Bot token is not configured."
    });
  }

  try {
    const update = req.body;

    if (update?.callback_query) {
      await handleCallbackQuery(token, update.callback_query);
      return res.status(200).json({ ok: true });
    }

    const message = update?.message;

    if (!message?.chat?.id) {
      return res.status(200).json({ ok: true });
    }

    const chatId = message.chat.id;
    const text = (message.text || "").trim();

    if (text === "/start") {
      await sendMessage(
        token,
        chatId,
        "📊 *TikTok Analytics Bot*\n\n" +
          "Send me any TikTok video URL and I'll analyze it for you.\n\n" +
          "Supported formats:\n" +
          "• `https://www.tiktok.com/@user/video/...`\n" +
          "• `https://vm.tiktok.com/...`\n" +
          "• `https://vt.tiktok.com/...`\n\n" +
          "Commands:\n" +
          "/start — Welcome message\n" +
          "/help — Show help\n" +
          "/id — Your Telegram ID",
        {
          inline_keyboard: [
            [{ text: "📖 Help", callback_data: "help" }],
            [{ text: "🆔 My ID", callback_data: "my_id" }]
          ]
        },
        "Markdown"
      );
    } else if (text === "/help") {
      await sendHelp(token, chatId);
    } else if (text === "/id") {
      await sendMessage(token, chatId, `🆔 Your Telegram ID: \`${chatId}\``, null, "Markdown");
    } else {
      const tiktokUrl = extractTikTokUrl(text);

      if (tiktokUrl) {
        await sendChatAction(token, chatId, "typing");
        await analyzeTikTok(token, chatId, tiktokUrl);
      } else {
        await sendMessage(
          token,
          chatId,
          "❓ I didn't find a TikTok URL.\n\n" +
            "Send a TikTok video link, or use /help for commands."
        );
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(500).json({
      ok: false,
      error: "Internal server error."
    });
  }
}

async function handleCallbackQuery(token, callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const data = callbackQuery.data;
  const callbackId = callbackQuery.id;

  if (!chatId) return;

  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId })
  });

  if (data === "help") {
    await sendHelp(token, chatId);
  } else if (data === "my_id") {
    await sendMessage(token, chatId, `🆔 Your Telegram ID: \`${chatId}\``, null, "Markdown");
  }
}

async function sendHelp(token, chatId) {
  await sendMessage(
    token,
    chatId,
    "🤖 *TikTok Analytics Bot — Help*\n\n" +
      "*How to use*\n" +
      "Paste any public TikTok video URL.\n\n" +
      "You'll get stats plus Download Video / Download Audio buttons.\n\n" +
      "*Commands*\n" +
      "/start — Welcome\n" +
      "/help — This message\n" +
      "/id — Your Telegram ID",
    null,
    "Markdown"
  );
}

function extractTikTokUrl(text) {
  const patterns = [
    /https?:\/\/(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/\d+[^\s]*/i,
    /https?:\/\/(?:vm|vt)\.tiktok\.com\/[\w-]+[^\s]*/i,
    /https?:\/\/(?:www\.)?tiktok\.com\/t\/[\w-]+[^\s]*/i,
    /https?:\/\/m\.tiktok\.com\/v\/\d+[^\s]*/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[0].replace(/[.,;:!?)]+$/, "");
    }
  }

  const idMatch = text.match(/\b(\d{15,25})\b/);
  if (idMatch) return idMatch[1];

  return null;
}

async function analyzeTikTok(token, chatId, url) {
  try {
    const data = await fetchTikWM(url);

    if (!data || data.code !== 0 || !data.data) {
      const msg = data?.msg || "Unknown error";
      await sendMessage(
        token,
        chatId,
        `❌ Could not fetch TikTok data.\n\nReason: ${msg}\n\nMake sure the URL is a public video.`
      );
      return;
    }

    const d = data.data;
    const formatted = formatAnalytics(d);
    const keyboard = buildDownloadKeyboard(d);

    await sendMessage(token, chatId, formatted, keyboard);
  } catch (error) {
    console.error("TikTok analysis error:", error);
    await sendMessage(
      token,
      chatId,
      "❌ Something went wrong while analyzing the video. Please try again later."
    );
  }
}

async function fetchTikWM(url) {
  const base = process.env.TIKWM_API_URL || "https://tikwm.com/api/";
  const apiKey = process.env.TIKWM_API_KEY;

  const params = new URLSearchParams({
    url: url,
    hd: "1"
  });

  const headers = {
    Accept: "application/json",
    "User-Agent": "TelegramTikTokBot/1.0"
  };

  if (apiKey) {
    headers["x-tikwmapi-key"] = apiKey;
  }

  const endpoint = apiKey
    ? `https://api.tikwmapi.com/?${params.toString()}`
    : `${base}?${params.toString()}`;

  const response = await fetch(endpoint, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`TikWM HTTP ${response.status}`);
  }

  return response.json();
}

function buildDownloadKeyboard(d) {
  const row = [];

  // Prefer HD video, fall back to normal play URL
  const videoUrl = d.hdplay || d.play || null;
  if (videoUrl) {
    row.push({
      text: "⬇️ Download Video",
      url: videoUrl
    });
  }

  // Audio: music field or music_info.play
  const audioUrl = d.music || (d.music_info && d.music_info.play) || null;
  if (audioUrl) {
    row.push({
      text: "🎵 Download Audio",
      url: audioUrl
    });
  }

  if (row.length === 0) return null;

  return {
    inline_keyboard: [row]
  };
}

function formatAnalytics(d) {
  const author = d.author || {};
  const music = d.music_info || {};

  const nickname = author.nickname || "Unknown";
  const uniqueId = author.unique_id ? `@${author.unique_id}` : "";
  const posted = formatDate(d.create_time);
  const duration = formatDuration(d.duration);
  const region = d.region || "—";
  const title = (d.title || "(no caption)").trim();
  const musicLabel = music.title || "Original sound";
  const musicAuthor = music.author ? ` — ${music.author}` : "";

  const sizeBytes = d.hd_size || d.size || null;
  const sizeLabel = sizeBytes ? formatBytes(sizeBytes) : "—";

  const lines = [
    "VIDEO — REVIEW",
    "",
    `👤 ${nickname}${uniqueId ? ` || ${uniqueId}` : ""} || ${posted}`,
    "",
    title,
    "",
    `♫ Sound ${duration}${musicAuthor ? ` · ${musicLabel}` : ""}`,
    "",
    "ⓘ INFORMATION",
    `  ⚬ ID Video: ${d.id || "—"}`,
    `  ⚬ Source: TikTok`,
    `  ⚬ Region Upload: ${region}`,
    "",
    "[ STATISTICS ]",
    `  ⚬ Views: ${formatNumber(d.play_count)}`,
    `  ⚬ Likes: ${formatNumber(d.digg_count)}`,
    `  ⚬ Comments: ${formatNumber(d.comment_count)}`,
    `  ⚬ Favorites: ${formatNumber(d.collect_count)}`,
    `  ⚬ Shares: ${formatNumber(d.share_count)}`,
    `  ⚬ Downloads: ${formatNumber(d.download_count)}`,
    "",
    "☆ QUALITY",
    `  ⚬ Duration: ${duration}`,
    `  ⚬ Size: ${sizeLabel}`,
    `  ⚬ Format: MP4`,
    `  ⚬ HD available: ${d.hdplay ? "Yes" : "No"}`
  ];

  return lines.join("\n");
}

function formatDate(unix) {
  if (!unix) return "Unknown";
  const d = new Date(unix * 1000);
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const day = d.getUTCDate();
  const month = months[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${day} ${month} ${year}, ${h}:${m}:${s}`;
}

function formatDuration(sec) {
  if (sec == null || isNaN(sec)) return "—";
  const s = Math.floor(Number(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function formatNumber(n) {
  if (n == null || isNaN(n)) return "0";
  return Number(n).toLocaleString("en-US");
}

function formatBytes(bytes) {
  const b = Number(bytes);
  if (!b || isNaN(b)) return "—";
  if (b >= 1_000_000_000) return `~${(b / 1_000_000_000).toFixed(2)} GB`;
  if (b >= 1_000_000) return `~${(b / 1_000_000).toFixed(2)} MB`;
  if (b >= 1_000) return `~${(b / 1_000).toFixed(1)} KB`;
  return `${b} B`;
}

async function sendMessage(token, chatId, text, replyMarkup = null, parseMode = null) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  };

  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }
  if (parseMode) {
    payload.parse_mode = parseMode;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  if (!response.ok) {
    const body = await response.text();
    if (parseMode && response.status === 400) {
      delete payload.parse_mode;
      const retry = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }
      );
      if (!retry.ok) {
        const retryBody = await retry.text();
        throw new Error(`Telegram API error: ${retry.status} ${retryBody}`);
      }
      return retry.json();
    }
    throw new Error(`Telegram API error: ${response.status} ${body}`);
  }

  return response.json();
}

async function sendChatAction(token, chatId, action = "typing") {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action })
    });
  } catch {
    // non-critical
  }
}
