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
        "📊 *TikTok Analytics Bot*\\n\\n" +
          "Send me any TikTok video URL and I'll analyze it for you.\\n\\n" +
          "The checker can use TikHub's TikTok App V3 data for playback qualities such as resolution, FPS, bitrate, codec and file size, when available.\\n\\n" +
          "Supported formats:\\n" +
          "• `https://www.tiktok.com/@user/video/...`\\n" +
          "• `https://vm.tiktok.com/...`\\n" +
          "• `https://vt.tiktok.com/...`\\n\\n" +
          "Commands:\\n" +
          "/start — Welcome message\\n" +
          "/help — Show help\\n" +
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
          "❓ I didn't find a TikTok URL.\\n\\n" +
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
    "🤖 *TikTok Analytics Bot — Help*\\n\\n" +
      "*How to use*\\n" +
      "Paste any public TikTok video URL.\\n\\n" +
      "*Analytics*\\n" +
      "• Views, likes, comments, shares, favorites\\n" +
      "• Caption, author, region and post time\\n" +
      "• Video resolution/FPS/bitrate/codec when TikHub playback data exposes them\\n" +
      "• Available playback qualities and file sizes\\n\\n" +
      "*Commands*\\n" +
      "/start — Welcome\\n" +
      "/help — This message\\n" +
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
    let result = null;
    let provider = null;

    // TikHub is the preferred provider because its TikTok App V3
    // endpoint can expose playback representations/bitrate information.
    if (process.env.TIKHUB_API_KEY) {
      try {
        result = await fetchTikHub(url);
        provider = "TikHub";
      } catch (error) {
        console.error("TikHub request failed:", error);
      }
    }

    // Keep TikWM as a fallback so the bot can still return basic analytics
    // if TikHub is temporarily unavailable or not configured.
    if (!result) {
      result = await fetchTikWM(url);
      provider = "TikWM";
    }

    const normalized = normalizeTikTok(result, provider);

    if (!normalized || !normalized.id) {
      await sendMessage(
        token,
        chatId,
        "❌ Could not fetch TikTok data.\\n\\n" +
          "The provider returned no usable public video data. " +
          "Try another public TikTok video."
      );
      return;
    }

    const formatted = formatAnalytics(normalized);
    const keyboard = buildDownloadKeyboard(normalized);

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

/**
 * TikHub TikTok App V3:
 * GET /api/v1/tiktok/app/v3/fetch_one_video_by_share_url?share_url=...
 * Authorization: Bearer <TIKHUB_API_KEY>
 *
 * TikHub's response shape can evolve. normalizeTikTok() intentionally
 * searches the returned object for common TikTok video/detail structures.
 */
async function fetchTikHub(url) {
  const apiKey = process.env.TIKHUB_API_KEY;
  if (!apiKey) throw new Error("Missing TIKHUB_API_KEY");

  const endpoint =
    "https://api.tikhub.io/api/v1/tiktok/app/v3/fetch_one_video_by_share_url" +
    `?share_url=${encodeURIComponent(url)}`;

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "1dleryu-TikTok-Analytics-Bot/2.0"
    },
    signal: AbortSignal.timeout(20000)
  });

  const body = await response.text();

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`TikHub returned non-JSON HTTP ${response.status}`);
  }

  if (!response.ok || data?.code !== 200) {
    throw new Error(
      `TikHub HTTP ${response.status}: ${data?.message || data?.msg || "request failed"}`
    );
  }

  if (!data?.data) {
    throw new Error("TikHub returned no data");
  }

  return data;
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
    "User-Agent": "TelegramTikTokBot/2.0"
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

  const data = await response.json();

  if (data?.code !== 0 || !data?.data) {
    throw new Error(data?.msg || "TikWM returned no data");
  }

  return data;
}

function normalizeTikTok(providerResponse, provider) {
  const root = providerResponse?.data ?? providerResponse;
  const video = findVideoObject(root) || {};
  const stats = findObjectByKeys(root, [
    "playCount", "diggCount", "commentCount", "shareCount"
  ]) || {};
  const author = video.author || findObjectByKeys(root, [
    "uniqueId", "nickname", "secUid"
  ]) || {};
  const music = video.music || video.music_info || findObjectByKeys(root, [
    "musicId", "musicName"
  ]) || {};

  const id =
    firstString(
      video.id,
      video.aweme_id,
      root?.aweme_id,
      root?.awemeId,
      providerResponse?.data?.aweme_id,
      findScalar(root, ["id"])
    );

  const title =
    firstString(
      root?.desc,
      root?.title,
      video.title,
      findScalar(root, ["desc"])
    ) || "(no caption)";

  const createTime = firstNumber(
    root?.create_time,
    root?.createTime,
    video.create_time,
    video.createTime,
    findScalar(root, ["create_time", "createTime"])
  );

  const region =
    firstString(
      root?.region,
      root?.region_code,
      root?.regionCode,
      video.region,
      findScalar(root, ["region", "region_code"])
    ) || "—";

  const representations = extractRepresentations(root, video);

  const primary = chooseBestRepresentation(representations);

  const duration = firstNumber(
    video.duration,
    root?.duration,
    findScalar(root, ["duration"])
  );

  const nickname = firstString(
    author.nickname,
    author.name,
    root?.author?.nickname,
    findScalar(root, ["nickname"])
  ) || "Unknown";

  const uniqueIdRaw = firstString(
    author.unique_id,
    author.uniqueId,
    author.unique_id_str,
    root?.author?.unique_id,
    root?.author?.uniqueId
  );

  const uniqueId = uniqueIdRaw
    ? (uniqueIdRaw.startsWith("@") ? uniqueIdRaw : `@${uniqueIdRaw}`)
    : "";

  // TikHub App V3 commonly exposes TikTok statistics under statistics/stats.
  // TikWM uses play_count/digg_count/etc. This fallback map supports both.
  const views = firstNumber(
    stats.playCount, stats.play_count,
    root?.statistics?.playCount, root?.statistics?.play_count,
    root?.stats?.playCount, root?.stats?.play_count,
    root?.play_count
  );

  const likes = firstNumber(
    stats.diggCount, stats.digg_count,
    root?.statistics?.diggCount, root?.statistics?.digg_count,
    root?.stats?.diggCount, root?.stats?.digg_count,
    root?.digg_count
  );

  const comments = firstNumber(
    stats.commentCount, stats.comment_count,
    root?.statistics?.commentCount, root?.statistics?.comment_count,
    root?.stats?.commentCount, root?.stats?.comment_count,
    root?.comment_count
  );

  const shares = firstNumber(
    stats.shareCount, stats.share_count,
    root?.statistics?.shareCount, root?.statistics?.share_count,
    root?.stats?.shareCount, root?.stats?.share_count,
    root?.share_count
  );

  const favorites = firstNumber(
    stats.collectCount, stats.collect_count,
    root?.statistics?.collectCount, root?.statistics?.collect_count,
    root?.stats?.collectCount, root?.stats?.collect_count,
    root?.collect_count
  );

  const downloads = firstNumber(
    stats.downloadCount, stats.download_count,
    root?.statistics?.downloadCount, root?.statistics?.download_count,
    root?.stats?.downloadCount, root?.stats?.download_count,
    root?.download_count
  );

  const musicTitle = firstString(
    music.title,
    music.name,
    music.music_name,
    root?.music?.title,
    root?.music?.name
  );

  const musicAuthor = firstString(
    music.author,
    music.author_name,
    root?.music?.author
  );

  return {
    provider,
    id,
    title: String(title).trim(),
    author: { nickname, uniqueId },
    region,
    createTime,
    duration,
    views,
    likes,
    comments,
    favorites,
    shares,
    downloads,
    musicTitle,
    musicAuthor,
    representations,
    primary,
    videoUrl: firstString(
      primary?.url,
      video.playAddr,
      video.play,
      root?.play,
      root?.hdplay
    ),
    audioUrl: firstString(
      root?.music?.playUrl,
      root?.music?.play,
      root?.music_info?.play
    )
  };
}

function findVideoObject(value) {
  if (!value || typeof value !== "object") return null;

  if (
    value.video &&
    typeof value.video === "object" &&
    (
      value.video.playAddr ||
      value.video.play_addr ||
      value.video.downloadAddr ||
      value.video.bitrateInfo ||
      value.video.bitRate
    )
  ) {
    return value;
  }

  if (
    value.playAddr ||
    value.play_addr ||
    value.downloadAddr ||
    value.bitrateInfo ||
    value.bitRate
  ) {
    return value;
  }

  for (const key of Object.keys(value)) {
    const found = findVideoObject(value[key]);
    if (found) return found;
  }

  return null;
}

function findObjectByKeys(value, keys) {
  if (!value || typeof value !== "object") return null;

  if (keys.some((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    return value;
  }

  for (const key of Object.keys(value)) {
    const found = findObjectByKeys(value[key], keys);
    if (found) return found;
  }

  return null;
}

function findScalar(value, keys) {
  if (!value || typeof value !== "object") return null;

  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) {
      return value[key];
    }
  }

  for (const key of Object.keys(value)) {
    const found = findScalar(value[key], keys);
    if (found !== null && found !== undefined) return found;
  }

  return null;
}

function extractRepresentations(root, videoContainer) {
  const video = videoContainer?.video && typeof videoContainer.video === "object"
    ? videoContainer.video
    : videoContainer;

  const candidates = [
    video?.bitrateInfo,
    video?.bitrate_info,
    video?.bitRateInfo,
    video?.bit_rate_info,
    root?.bitrateInfo,
    root?.bitrate_info
  ];

  let list = candidates.find(Array.isArray) || [];

  // Some TikTok responses expose bit_rate as an array.
  if (!list.length && Array.isArray(video?.bit_rate)) list = video.bit_rate;

  return list
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const addr = item.playAddr || item.play_addr || item.PlayAddr || {};
      const urlList = Array.isArray(addr.urlList)
        ? addr.urlList
        : Array.isArray(addr.UrlList)
          ? addr.UrlList
          : Array.isArray(item.urlList)
            ? item.urlList
            : [];

      const url =
        firstString(
          addr.url,
          addr.url_list?.[0],
          urlList[0],
          item.url,
          item.playUrl,
          item.play_url
        );

      const width = firstNumber(
        addr.width, addr.Width,
        item.width, item.Width
      );

      const height = firstNumber(
        addr.height, addr.Height,
        item.height, item.Height
      );

      const size = firstNumber(
        addr.dataSize, addr.DataSize,
        item.dataSize, item.DataSize,
        item.fileSize, item.file_size
      );

      const bitrate = firstNumber(
        item.bitrate, item.Bitrate,
        item.bit_rate, item.bitRate
      );

      const codec = firstString(
        item.codecType, item.CodecType,
        item.codec_type, item.codec
      );

      const gearName = firstString(
        item.GearName, item.gearName, item.gear_name,
        item.quality, item.qualityName
      );

      const fps = firstNumber(
        item.fps, item.Fps,
        addr.fps, addr.Fps
      ) || inferFps(gearName);

      return {
        gearName: gearName || "unknown",
        width,
        height,
        fps,
        bitrate,
        codec: codec || "unknown",
        size,
        url
      };
    })
    .filter((item) => item.url || item.width || item.height || item.bitrate);
}

function chooseBestRepresentation(representations) {
  if (!representations.length) return null;

  return [...representations].sort((a, b) => {
    const pixelsA = (a.width || 0) * (a.height || 0);
    const pixelsB = (b.width || 0) * (b.height || 0);
    if (pixelsA !== pixelsB) return pixelsB - pixelsA;
    return (b.bitrate || 0) - (a.bitrate || 0);
  })[0];
}

function inferFps(gearName) {
  if (!gearName) return null;
  const match = String(gearName).match(/(?:^|[_-])(\d{2,3})(?:$|[_-])/);
  if (!match) return null;

  const n = Number(match[1]);
  return n >= 20 && n <= 120 ? n : null;
}

function formatAnalytics(d) {
  const posted = formatDate(d.createTime);
  const duration = formatDuration(d.duration);
  const primary = d.primary;

  const lines = [
    "🎵 TIKTOK ANALYTICS",
    "",
    `👤 ${d.author.nickname}${d.author.uniqueId ? ` ${d.author.uniqueId}` : ""}`,
    `🆔 Video ID: ${d.id}`,
    `🔌 Provider: ${d.provider}`,
    "",
    "📊 STATISTICS",
    `👁 Views: ${formatNumber(d.views)}`,
    `❤️ Likes: ${formatNumber(d.likes)}`,
    `💬 Comments: ${formatNumber(d.comments)}`,
    `⭐ Favorites: ${formatNumber(d.favorites)}`,
    `🔄 Shares: ${formatNumber(d.shares)}`,
    `⬇️ Downloads: ${formatNumber(d.downloads)}`,
    "",
    "📝 CAPTION",
    d.title || "(no caption)",
    "",
    "🌎 POST INFORMATION",
    `Country/Region: ${d.region || "—"}`,
    `Posted: ${posted}`,
    "",
    "🎥 QUALITY",
    `Resolution: ${formatResolution(primary)}`,
    `FPS: ${primary?.fps ? `${primary.fps} FPS` : "—"}`,
    `Bitrate: ${formatBitrate(primary?.bitrate)}`,
    `Codec: ${primary?.codec || "—"}`,
    `Duration: ${duration}`,
    `Size: ${formatBytes(primary?.size)}`,
    `Format: MP4`
  ];

  if (d.representations.length) {
    lines.push("", "📦 AVAILABLE QUALITIES");

    for (const item of d.representations.slice(0, 12)) {
      lines.push(
        `• ${item.gearName}`,
        `  ${formatResolution(item)}${item.fps ? `${item.fps}fps` : ""} • ${formatBitrate(item.bitrate)} • ${String(item.codec).toUpperCase()} • ${formatBytes(item.size)}`
      );
    }
  }

  lines.push(
    "",
    "🛡️ SHADOWBAN",
    "Status: Not directly provided by TikHub"
  );

  return lines.join("\n");
}

function buildDownloadKeyboard(d) {
  const row = [];

  if (d.videoUrl) {
    row.push({
      text: "⬇️ Download Video",
      url: d.videoUrl
    });
  }

  if (d.audioUrl) {
    row.push({
      text: "🎵 Download Audio",
      url: d.audioUrl
    });
  }

  if (row.length === 0) return null;

  return {
    inline_keyboard: [row]
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "" && !Number.isNaN(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function formatDate(unix) {
  if (!unix) return "Unknown";
  const timestamp = Number(unix);
  const d = new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1000);
  if (Number.isNaN(d.getTime())) return "Unknown";

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short"
  }).format(d);
}

function formatDuration(sec) {
  if (sec == null || Number.isNaN(Number(sec))) return "—";
  const s = Math.max(0, Math.floor(Number(sec)));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function formatNumber(n) {
  if (n == null || Number.isNaN(Number(n))) return "0";
  return Number(n).toLocaleString("en-US");
}

function formatBytes(bytes) {
  const b = Number(bytes);
  if (!b || Number.isNaN(b)) return "—";
  if (b >= 1_000_000_000) return `~${(b / 1_000_000_000).toFixed(2)} GB`;
  if (b >= 1_000_000) return `~${(b / 1_000_000).toFixed(2)} MB`;
  if (b >= 1_000) return `~${(b / 1_000).toFixed(1)} KB`;
  return `${b} B`;
}

function formatBitrate(bitrate) {
  const b = Number(bitrate);
  if (!b || Number.isNaN(b)) return "—";
  if (b >= 1_000_000) return `${(b / 1_000_000).toFixed(2)} Mbps`;
  if (b >= 1_000) return `${(b / 1_000).toFixed(0)} Kbps`;
  return `${b} bps`;
}

function formatResolution(item) {
  if (!item) return "—";
  if (item.width && item.height) return `${item.width}×${item.height}`;
  if (item.gearName) {
    const match = String(item.gearName).match(/(\d{3,4})/);
    if (match) return `${match[1]}p`;
  }
  return "—";
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
