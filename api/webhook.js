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

    // Handle callback queries (inline buttons)
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

  // Answer callback to remove loading state
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
      "Just paste any TikTok video URL and receive:\n" +
      "• Views, likes, comments, shares\n" +
      "• Saves & downloads\n" +
      "• Author info\n" +
      "• Music / sound details\n" +
      "• Engagement rate\n" +
      "• Publish date & duration\n\n" +
      "*Commands*\n" +
      "/start — Welcome\n" +
      "/help — This message\n" +
      "/id — Your Telegram ID\n\n" +
      "Powered by TikWM API",
    null,
    "Markdown"
  );
}

function extractTikTokUrl(text) {
  // Match common TikTok URL patterns
  const patterns = [
    /https?:\/\/(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/\d+[^\s]*/i,
    /https?:\/\/(?:vm|vt)\.tiktok\.com\/[\w-]+[^\s]*/i,
    /https?:\/\/(?:www\.)?tiktok\.com\/t\/[\w-]+[^\s]*/i,
    /https?:\/\/m\.tiktok\.com\/v\/\d+[^\s]*/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      // Clean trailing punctuation that might be attached
      return match[0].replace(/[.,;:!?)]+$/, "");
    }
  }

  // Also accept bare video IDs (long numeric)
  const idMatch = text.match(/\b(\d{15,25})\b/);
  if (idMatch) {
    return idMatch[1];
  }

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
        `❌ Could not fetch TikTok data.\n\nReason: ${escapeMarkdown(msg)}\n\nMake sure the URL is a public video.`
      );
      return;
    }

    const info = data.data;
    const formatted = formatAnalytics(info);
    await sendMessage(token, chatId, formatted, null, "Markdown");
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
  const apiKey = process.env.TIKWM_API_KEY; // optional, for paid tier

  const params = new URLSearchParams({
    url: url,
    hd: "1"
  });

  const headers = {
    Accept: "application/json",
    "User-Agent": "TelegramTikTokBot/1.0"
  };

  // Paid TikWM API uses header auth
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

function formatAnalytics(d) {
  const author = d.author || {};
  const music = d.music_info || {};

  const views = formatNumber(d.play_count);
  const likes = formatNumber(d.digg_count);
  const comments = formatNumber(d.comment_count);
  const shares = formatNumber(d.share_count);
  const downloads = formatNumber(d.download_count);
  const saves = formatNumber(d.collect_count);

  const engagement = calcEngagement(
    d.play_count,
    d.digg_count,
    d.comment_count,
    d.share_count
  );

  const created = d.create_time
    ? new Date(d.create_time * 1000).toUTCString().replace("GMT", "UTC")
    : "Unknown";

  const duration = d.duration != null ? `${d.duration}s` : "—";
  const region = d.region || "—";
  const isAd = d.is_ad ? "Yes" : "No";

  const title = escapeMarkdown(truncate(d.title || "(no caption)", 200));
  const nickname = escapeMarkdown(author.nickname || "Unknown");
  const uniqueId = author.unique_id ? `@${escapeMarkdown(author.unique_id)}` : "";
  const musicTitle = escapeMarkdown(music.title || "Original sound");
  const musicAuthor = music.author ? escapeMarkdown(music.author) : "";

  let text =
    `📊 *TikTok Analytics*\n\n` +
    `🎬 *Caption*\n${title}\n\n` +
    `👤 *Author*\n${nickname} ${uniqueId}\n` +
    `🌍 Region: ${region}\n` +
    `📅 Posted: ${created}\n` +
    `⏱ Duration: ${duration}\n` +
    `📢 Ad: ${isAd}\n\n` +
    `📈 *Engagement*\n` +
    `👁 Views: *${views}*\n` +
    `❤️ Likes: *${likes}*\n` +
    `💬 Comments: *${comments}*\n` +
    `↪️ Shares: *${shares}*\n` +
    `⬇️ Downloads: *${downloads}*\n` +
    `⭐ Saves: *${saves}*\n` +
    `📊 Engagement rate: *${engagement}%*\n\n` +
    `🎵 *Music*\n${musicTitle}` +
    (musicAuthor ? ` — ${musicAuthor}` : "") +
    `\n\n` +
    `🔗 [Open on TikTok](https://www.tiktok.com/@${author.unique_id || "user"}/video/${d.id})`;

  return text;
}

function calcEngagement(views, likes, comments, shares) {
  if (!views || views <= 0) return "0.00";
  const total = (likes || 0) + (comments || 0) + (shares || 0);
  return ((total / views) * 100).toFixed(2);
}

function formatNumber(n) {
  if (n == null || isNaN(n)) return "0";
  const num = Number(n);
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(num);
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function escapeMarkdown(text) {
  if (!text) return "";
  // Escape Telegram Markdown V1 special chars
  return String(text)
    .replace(/([_*`\[])/g, "\\$1");
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
    // Fallback without Markdown if parsing fails
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
