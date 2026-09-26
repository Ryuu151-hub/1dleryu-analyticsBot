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
        "📊 <b>TikTok Analytics Bot</b>\n\n" +
          "Send any TikTok video URL and get analytics + download buttons.\n\n" +
          "Supported:\n" +
          "• tiktok.com/@user/video/...\n" +
          "• vm.tiktok.com / vt.tiktok.com\n\n" +
          "Commands:\n" +
          "/start — Welcome\n" +
          "/help — Help\n" +
          "/id — Your Telegram ID",
        {
          inline_keyboard: [
            [{ text: "📖 Help", callback_data: "help" }],
            [{ text: "🆔 My ID", callback_data: "my_id" }]
          ]
        },
        "HTML"
      );
    } else if (text === "/help") {
      await sendHelp(token, chatId);
    } else if (text === "/id") {
      await sendMessage(
        token,
        chatId,
        `🆔 Your Telegram ID: <code>${chatId}</code>`,
        null,
        "HTML"
      );
    } else {
      const tiktokUrl = extractTikTokUrl(text);

      if (tiktokUrl) {
        await sendChatAction(token, chatId, "typing");
        await analyzeTikTok(token, chatId, tiktokUrl);
      } else {
        await sendMessage(
          token,
          chatId,
          "❓ I didn't find a TikTok URL.\n\nSend a TikTok video link, or use /help."
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
    await sendMessage(
      token,
      chatId,
      `🆔 Your Telegram ID: <code>${chatId}</code>`,
      null,
      "HTML"
    );
  }
}

async function sendHelp(token, chatId) {
  await sendMessage(
    token,
    chatId,
    "🤖 <b>TikTok Analytics Bot — Help</b>\n\n" +
      "Paste any public TikTok video URL.\n\n" +
      "You get:\n" +
      "• Quoted caption\n" +
      "• Clickable sound (opens TikTok music)\n" +
      "• Stats + quality info\n" +
      "• Download Video / Download Audio buttons\n\n" +
      "<b>Commands</b>\n" +
      "/start — Welcome\n" +
      "/help — This message\n" +
      "/id — Your Telegram ID",
    null,
    "HTML"
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
        `❌ Could not fetch TikTok data.\n\nReason: ${escapeHtml(msg)}\n\nMake sure the URL is a public video.`
      );
      return;
    }

    const d = data.data;
    const formatted = formatAnalytics(d);
    const keyboard = buildDownloadKeyboard(d);

    await sendMessage(token, chatId, formatted, keyboard, "HTML");
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

  const videoUrl = d.hdplay || d.play || null;
  if (videoUrl) {
    row.push({ text: "⬇️ Download Video", url: videoUrl });
  }

  const audioUrl = d.music || (d.music_info && d.music_info.play) || null;
  if (audioUrl) {
    row.push({ text: "🎵 Download Audio", url: audioUrl });
  }

  if (row.length === 0) return null;

  return { inline_keyboard: [row] };
}

function formatAnalytics(d) {
  const author = d.author || {};
  const music = d.music_info || {};

  const nickname = escapeHtml(author.nickname || "Unknown");
  const uniqueId = author.unique_id ? escapeHtml(author.unique_id) : "";
  const posted = formatDate(d.create_time);
  const duration = formatDuration(d.duration);
  const region = escapeHtml(d.region || "—");
  const titleRaw = (d.title || "(no caption)").trim();
  const title = escapeHtml(titleRaw);

  // Clickable author (like TikTok user)
  const authorLine = uniqueId
    ? `👤 ${nickname} || <a href="https://www.tiktok.com/@${uniqueId}">@${uniqueId}</a> || ${posted}`
    : `👤 ${nickname} || ${posted}`;

  // Sound: clickable — prefer TikTok music page, else audio file URL
  const musicTitle = escapeHtml(music.title || "Original sound");
  const musicAuthor = music.author ? escapeHtml(music.author) : "";
  const musicId = music.id || null;
  const audioFile = d.music || music.play || null;

  let soundHref = null;
  if (musicId) {
    // TikTok music page (opens like a TikTok sound / user page)
    const slug = encodeURIComponent(
      (music.title || "original-sound").replace(/\s+/g, "-").slice(0, 80)
    );
    soundHref = `https://www.tiktok.com/music/${slug}-${musicId}`;
  } else if (audioFile) {
    soundHref = audioFile;
  }

  const soundText = musicAuthor
    ? `♫ Sound ${duration} · ${musicTitle} — ${musicAuthor}`
    : `♫ Sound ${duration} · ${musicTitle}`;

  const soundLine = soundHref
    ? `<a href="${escapeHtml(soundHref)}">${soundText}</a>`
    : soundText;

  const sizeBytes = d.hd_size || d.size || null;
  const sizeLabel = sizeBytes ? formatBytes(sizeBytes) : "—";

  // Resolution / FPS — TikWM free API rarely includes these; use if present
  const width = d.width || d.video_width || (d.video && d.video.width) || null;
  const height = d.height || d.video_height || (d.video && d.video.height) || null;
  const fps = d.fps || d.frame_rate || (d.video && d.video.fps) || null;

  let resolutionLabel = "—";
  if (width && height) {
    resolutionLabel = `${width} × ${height}`;
  }

  let fpsLabel = "—";
  if (fps != null && !isNaN(fps)) {
    fpsLabel = `${Number(fps)} fps`;
  }

  // Short label like 1080p60 when both known
  let qualityShort = null;
  if (width && height && fps != null && !isNaN(fps)) {
    const shortRes = Math.min(Number(width), Number(height)) >= 1080
      ? "1080p"
      : Math.min(Number(width), Number(height)) >= 720
        ? "720p"
        : `${Math.min(Number(width), Number(height))}p`;
    qualityShort = `${shortRes}${Math.round(Number(fps))}`;
  }

  // Caption in Telegram blockquote (quote design)
  const quotedCaption = `<blockquote>${title}</blockquote>`;

  const qualityLines = [
    "☆ <b>QUALITY</b>",
    `  ⚬ Resolution: ${resolutionLabel}`,
    `  ⚬ FPS: ${fpsLabel}`,
  ];
  if (qualityShort) {
    qualityLines.push(`  ⚬ Profile: ${qualityShort}`);
  }
  qualityLines.push(
    `  ⚬ Duration: ${duration}`,
    `  ⚬ Size: ${sizeLabel}`,
    `  ⚬ Format: MP4`
  );

  const lines = [
    "<b>VIDEO — REVIEW</b>",
    "",
    authorLine,
    "",
    quotedCaption,
    "",
    soundLine,
    "",
    "ⓘ <b>INFORMATION</b>",
    `  ⚬ ID Video: <code>${escapeHtml(String(d.id || "—"))}</code>`,
    `  ⚬ Source: TikTok`,
    `  ⚬ Region Upload: ${region}`,
    "",
    "[ <b>STATISTICS</b> ]",
    `  ⚬ Views: ${formatNumber(d.play_count)}`,
    `  ⚬ Likes: ${formatNumber(d.digg_count)}`,
    `  ⚬ Comments: ${formatNumber(d.comment_count)}`,
    `  ⚬ Favorites: ${formatNumber(d.collect_count)}`,
    `  ⚬ Shares: ${formatNumber(d.share_count)}`,
    `  ⚬ Downloads: ${formatNumber(d.download_count)}`,
    "",
    ...qualityLines
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

function escapeHtml(text) {
  if (text == null) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
