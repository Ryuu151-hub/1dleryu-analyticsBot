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
      "• Clickable sound + @author\n" +
      "• Stats + resolution / FPS\n" +
      "• Download Video / Download Audio\n\n" +
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
    const normalized = await fetchVideoData(url);

    if (!normalized) {
      await sendMessage(
        token,
        chatId,
        "❌ Could not fetch TikTok data.\n\nMake sure the URL is a public video."
      );
      return;
    }

    const formatted = formatAnalytics(normalized);
    const keyboard = buildDownloadKeyboard(normalized);

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

/**
 * Prefer TikHub (resolution + FPS). Fall back to TikWM for stats/downloads.
 */
async function fetchVideoData(url) {
  const tikhubKey = process.env.TIKHUB_API_KEY;

  let hub = null;
  let wm = null;

  if (tikhubKey) {
    try {
      hub = await fetchTikHub(url, tikhubKey);
    } catch (e) {
      console.error("TikHub error:", e.message || e);
    }
  }

  try {
    wm = await fetchTikWM(url);
  } catch (e) {
    console.error("TikWM error:", e.message || e);
  }

  if (!hub && !wm) return null;

  return mergeSources(hub, wm, url);
}

async function fetchTikHub(url, apiKey) {
  const isId = /^\d{15,25}$/.test(url);
  let endpoint;

  if (isId) {
    endpoint = `https://api.tikhub.io/api/v1/tiktok/app/v3/fetch_one_video?aweme_id=${encodeURIComponent(url)}`;
  } else {
    endpoint = `https://api.tikhub.io/api/v1/tiktok/app/v3/fetch_one_video_by_share_url?share_url=${encodeURIComponent(url)}`;
  }

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error(`TikHub HTTP ${response.status}`);
  }

  const json = await response.json();
  // TikHub wraps in { code, data } — data may be aweme detail or nested
  if (json.code !== 200 && json.code !== 0) {
    throw new Error(json.message || json.msg || "TikHub error");
  }

  return normalizeTikHub(json.data || json);
}

function normalizeTikHub(data) {
  if (!data) return null;

  // Possible shapes: data.aweme_detail, data itself is aweme, or data[0]
  const aweme =
    data.aweme_detail ||
    data.aweme ||
    (Array.isArray(data) ? data[0] : data) ||
    data;

  if (!aweme || typeof aweme !== "object") return null;

  const video = aweme.video || {};
  const author = aweme.author || {};
  const music = aweme.music || {};
  const stats = aweme.statistics || aweme.stats || {};

  // Best quality from bit_rate array
  const bitRates = video.bit_rate || video.bitrateInfo || aweme.bit_rate || [];
  let best = null;
  if (Array.isArray(bitRates) && bitRates.length) {
    best = bitRates.reduce((a, b) => {
      const aw = (a.play_addr && a.play_addr.width) || a.width || 0;
      const bw = (b.play_addr && b.play_addr.width) || b.width || 0;
      const ah = (a.play_addr && a.play_addr.height) || a.height || 0;
      const bh = (b.play_addr && b.play_addr.height) || b.height || 0;
      return aw * ah >= bw * bh ? a : b;
    });
  }

  const width =
    (best && ((best.play_addr && best.play_addr.width) || best.width)) ||
    video.width ||
    null;
  const height =
    (best && ((best.play_addr && best.play_addr.height) || best.height)) ||
    video.height ||
    null;
  const fps =
    (best && (best.FPS || best.fps || best.frame_rate)) ||
    video.fps ||
    null;

  const playUrl =
    (video.play_addr && pickUrl(video.play_addr)) ||
    (video.download_addr && pickUrl(video.download_addr)) ||
    null;
  const musicUrl =
    (music.play_url && pickUrl(music.play_url)) ||
    music.play_url?.uri ||
    null;

  const durationMs = video.duration || aweme.duration || music.duration || 0;
  const durationSec =
    durationMs > 1000 ? Math.round(durationMs / 1000) : Math.round(durationMs);

  return {
    source: "tikhub",
    id: String(aweme.aweme_id || aweme.id || ""),
    title: aweme.desc || aweme.title || "",
    create_time: aweme.create_time || null,
    region: aweme.region || author.region || "",
    duration: durationSec,
    width: width ? Number(width) : null,
    height: height ? Number(height) : null,
    fps: fps != null ? Number(fps) : null,
    play_count: stats.play_count ?? stats.playCount ?? null,
    digg_count: stats.digg_count ?? stats.diggCount ?? null,
    comment_count: stats.comment_count ?? stats.commentCount ?? null,
    share_count: stats.share_count ?? stats.shareCount ?? null,
    collect_count: stats.collect_count ?? stats.collectCount ?? null,
    download_count: stats.download_count ?? stats.downloadCount ?? null,
    author: {
      unique_id: author.unique_id || author.uniqueId || "",
      nickname: author.nickname || author.nickName || ""
    },
    music_info: {
      id: music.id || music.mid || "",
      title: music.title || music.music_name || "Original sound",
      author: music.author || music.owner_nickname || "",
      play: musicUrl
    },
    play: playUrl,
    hdplay: playUrl,
    music: musicUrl,
    size: video.play_addr?.data_size || best?.play_addr?.data_size || null,
    hd_size: null,
    is_ad: !!aweme.is_ads || !!aweme.is_ad
  };
}

function pickUrl(addr) {
  if (!addr) return null;
  if (typeof addr === "string") return addr;
  if (Array.isArray(addr.url_list) && addr.url_list.length) return addr.url_list[0];
  if (addr.url) return addr.url;
  return null;
}

async function fetchTikWM(url) {
  const base = process.env.TIKWM_API_URL || "https://tikwm.com/api/";
  const apiKey = process.env.TIKWM_API_KEY;

  const params = new URLSearchParams({ url: url, hd: "1" });
  const headers = {
    Accept: "application/json",
    "User-Agent": "TelegramTikTokBot/1.0"
  };

  if (apiKey) headers["x-tikwmapi-key"] = apiKey;

  const endpoint = apiKey
    ? `https://api.tikwmapi.com/?${params.toString()}`
    : `${base}?${params.toString()}`;

  const response = await fetch(endpoint, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) throw new Error(`TikWM HTTP ${response.status}`);

  const json = await response.json();
  if (!json || json.code !== 0 || !json.data) {
    throw new Error(json?.msg || "TikWM failed");
  }

  const d = json.data;
  return {
    source: "tikwm",
    id: String(d.id || ""),
    title: d.title || "",
    create_time: d.create_time || null,
    region: d.region || "",
    duration: d.duration != null ? Number(d.duration) : null,
    width: d.width || null,
    height: d.height || null,
    fps: d.fps || null,
    play_count: d.play_count,
    digg_count: d.digg_count,
    comment_count: d.comment_count,
    share_count: d.share_count,
    collect_count: d.collect_count,
    download_count: d.download_count,
    author: d.author || {},
    music_info: d.music_info || {},
    play: d.play || null,
    hdplay: d.hdplay || null,
    music: d.music || (d.music_info && d.music_info.play) || null,
    size: d.size || null,
    hd_size: d.hd_size || null,
    is_ad: !!d.is_ad
  };
}

function mergeSources(hub, wm, originalUrl) {
  // Prefer hub for technical quality; wm for download links & stats if missing
  const base = hub || wm;
  if (!base) return null;

  const other = hub ? wm : null;

  return {
    source: hub ? "tikhub" : "tikwm",
    id: base.id || (other && other.id) || "",
    title: base.title || (other && other.title) || "",
    create_time: base.create_time || (other && other.create_time) || null,
    region: base.region || (other && other.region) || "",
    duration: base.duration ?? (other && other.duration) ?? null,
    width: base.width ?? (other && other.width) ?? null,
    height: base.height ?? (other && other.height) ?? null,
    fps: base.fps ?? (other && other.fps) ?? null,
    play_count: pickNum(base.play_count, other && other.play_count),
    digg_count: pickNum(base.digg_count, other && other.digg_count),
    comment_count: pickNum(base.comment_count, other && other.comment_count),
    share_count: pickNum(base.share_count, other && other.share_count),
    collect_count: pickNum(base.collect_count, other && other.collect_count),
    download_count: pickNum(base.download_count, other && other.download_count),
    author: {
      unique_id:
        (base.author && base.author.unique_id) ||
        (other && other.author && other.author.unique_id) ||
        "",
      nickname:
        (base.author && base.author.nickname) ||
        (other && other.author && other.author.nickname) ||
        "Unknown"
    },
    music_info: {
      id:
        (base.music_info && base.music_info.id) ||
        (other && other.music_info && other.music_info.id) ||
        "",
      title:
        (base.music_info && base.music_info.title) ||
        (other && other.music_info && other.music_info.title) ||
        "Original sound",
      author:
        (base.music_info && base.music_info.author) ||
        (other && other.music_info && other.music_info.author) ||
        "",
      play:
        (base.music_info && base.music_info.play) ||
        (other && other.music_info && other.music_info.play) ||
        null
    },
    // Prefer TikWM download URLs (often more reliable for direct open)
    play: (other && other.play) || base.play || null,
    hdplay: (other && other.hdplay) || base.hdplay || null,
    music: (other && other.music) || base.music || null,
    size: (other && other.size) || base.size || null,
    hd_size: (other && other.hd_size) || base.hd_size || null,
    is_ad: base.is_ad || (other && other.is_ad) || false,
    originalUrl
  };
}

function pickNum(a, b) {
  if (a != null && !isNaN(a)) return Number(a);
  if (b != null && !isNaN(b)) return Number(b);
  return null;
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
  const title = escapeHtml((d.title || "(no caption)").trim());

  const authorLine = uniqueId
    ? `👤 ${nickname} || <a href="https://www.tiktok.com/@${uniqueId}">@${uniqueId}</a> || ${posted}`
    : `👤 ${nickname} || ${posted}`;

  const musicTitle = escapeHtml(music.title || "Original sound");
  const musicAuthor = music.author ? escapeHtml(music.author) : "";
  const musicId = music.id || null;
  const audioFile = d.music || music.play || null;

  let soundHref = null;
  if (musicId) {
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

  let resolutionLabel = "—";
  if (d.width && d.height) {
    resolutionLabel = `${d.width} × ${d.height}`;
  }

  let fpsLabel = "—";
  if (d.fps != null && !isNaN(d.fps)) {
    fpsLabel = `${Number(d.fps)} fps`;
  }

  let qualityShort = null;
  if (d.width && d.height && d.fps != null && !isNaN(d.fps)) {
    const shortSide = Math.min(Number(d.width), Number(d.height));
    const shortRes =
      shortSide >= 1080 ? "1080p" : shortSide >= 720 ? "720p" : `${shortSide}p`;
    qualityShort = `${shortRes}${Math.round(Number(d.fps))}`;
  }

  const quotedCaption = `<blockquote>${title}</blockquote>`;

  const qualityLines = [
    "☆ <b>QUALITY</b>",
    `  ⚬ Resolution: ${resolutionLabel}`,
    `  ⚬ FPS: ${fpsLabel}`
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
  const d = new Date(Number(unix) * 1000);
  if (isNaN(d.getTime())) return "Unknown";
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

  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (parseMode) payload.parse_mode = parseMode;

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
        throw new Error(`Telegram API error: ${retry.status} ${await retry.text()}`);
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
