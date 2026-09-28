import { probeVideoSource } from "./lib/fpsProbe.js";
import { scrapeFps } from "./lib/fpsScrape.js";
import { getFpsFromTikWmStructure } from "./lib/mp4Parser.js";

export const config = { maxDuration: 60 };

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
          "Send any TikTok video URL.\n\n" +
          "1️⃣ First you get a preview card\n" +
          "2️⃣ Tap <b>👁 Check</b> for full video analytics\n\n" +
          "Commands: /start · /help · /id",
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
  const data = callbackQuery.data || "";
  const callbackId = callbackQuery.id;

  if (!chatId) return;

  // Answer immediately so button stops loading
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackId,
      text: data.startsWith("check:") ? "Loading analytics…" : undefined
    })
  });

  if (data === "help") {
    await sendHelp(token, chatId);
    return;
  }
  if (data === "my_id") {
    await sendMessage(
      token,
      chatId,
      `🆔 Your Telegram ID: <code>${chatId}</code>`,
      null,
      "HTML"
    );
    return;
  }

  // Full analytics on Check
  if (data.startsWith("check:")) {
    const videoId = data.slice(6);
    if (!videoId) return;

    let loadingMsgId = null;
    try {
      const loading = await sendMessage(
        token,
        chatId,
        "⏳ <b>Loading video analytics…</b>",
        null,
        "HTML"
      );
      loadingMsgId = loading?.result?.message_id || null;
    } catch {
      /* ignore */
    }

    await sendChatAction(token, chatId, "typing");

    try {
      const normalized = await fetchVideoData(videoId);
      if (!normalized) {
        await deleteMessage(token, chatId, loadingMsgId);
        await sendMessage(token, chatId, "❌ Could not load analytics for this video.");
        return;
      }

      const formatted = formatFullAnalytics(normalized);
      const keyboard = buildDownloadKeyboard(normalized);

      await deleteMessage(token, chatId, loadingMsgId);

      // 1) Thumbnail / video at top (short caption so nothing is cut)
      const mediaCaption = "📊 <b>VIDEO — ANALYTICS</b>";
      const mediaSent = await sendPreviewMedia(
        token,
        chatId,
        normalized,
        mediaCaption,
        null
      );

      // 2) Full analytics text + download buttons
      await sendMessage(token, chatId, formatted, keyboard, "HTML");

      if (!mediaSent) {
        // media optional; text already sent
      }
    } catch (e) {
      console.error("Check analytics error:", e);
      await deleteMessage(token, chatId, loadingMsgId);
      await sendMessage(token, chatId, "❌ Failed to load analytics. Try again.");
    }
  }
}

async function sendHelp(token, chatId) {
  await sendMessage(
    token,
    chatId,
    "🤖 <b>TikTok Analytics Bot — Help</b>\n\n" +
      "Paste any public TikTok video URL.\n\n" +
      "<b>Flow</b>\n" +
      "1. Preview card (thumbnail, stats, actions)\n" +
      "2. Tap <b>👁 Check</b> → full VIDEO ANALYTICS\n\n" +
      "Also: download video / audio buttons after Check.\n\n" +
      "/start · /help · /id",
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
    if (match) return match[0].replace(/[.,;:!?)]+$/, "");
  }

  const idMatch = text.match(/\b(\d{15,25})\b/);
  if (idMatch) return idMatch[1];
  return null;
}

async function analyzeTikTok(token, chatId, url) {
  let loadingMsgId = null;
  try {
    const loading = await sendMessage(
      token,
      chatId,
      "⏳ <b>Loading data…</b>",
      null,
      "HTML"
    );
    loadingMsgId = loading?.result?.message_id || null;
  } catch {
    /* ignore */
  }

  await sendChatAction(token, chatId, "typing");

  try {
    const d = await fetchVideoData(url);

    if (!d) {
      await deleteMessage(token, chatId, loadingMsgId);
      await sendMessage(
        token,
        chatId,
        "❌ Could not fetch TikTok data.\n\nMake sure the URL is a public video."
      );
      return;
    }

    const cardCaption = formatPreviewCard(d);
    const keyboard = buildPreviewKeyboard(d);

    const sent = await sendPreviewMedia(token, chatId, d, cardCaption, keyboard);

    await deleteMessage(token, chatId, loadingMsgId);

    if (!sent) {
      await sendMessage(token, chatId, cardCaption, keyboard, "HTML");
    }
  } catch (error) {
    console.error("TikTok analysis error:", error);
    await deleteMessage(token, chatId, loadingMsgId);
    await sendMessage(
      token,
      chatId,
      "❌ Something went wrong while analyzing the video. Please try again later."
    );
  }
}

/** Compact first response (Kami Checker style) */
function formatPreviewCard(d) {
  const author = d.author || {};
  const nickname = escapeHtml(author.nickname || "Unknown");
  const uniqueId = author.unique_id ? escapeHtml(author.unique_id) : "";
  const duration = formatDuration(d.duration);
  const posted = formatDateShort(d.create_time);
  const regionCode = (d.region || "").toString().trim().toUpperCase();
  const flag = regionFlag(regionCode);
  const country = countryName(regionCode);
  const regionLine = regionCode
    ? `${flag ? flag + " " : ""}${escapeHtml(country || regionCode)}`
    : "—";

  const titleRaw = (d.title || "(no caption)").trim();
  const title =
    titleRaw.length > 180
      ? escapeHtml(titleRaw.slice(0, 177)) + "…"
      : escapeHtml(titleRaw);

  const authorLine = uniqueId
    ? `👤 <a href="https://www.tiktok.com/@${uniqueId}">${nickname}</a>`
    : `👤 ${nickname}`;

  const lines = [
    `🎬 <b>VIDEO</b> · ${duration}`,
    authorLine + (posted ? `  📅 ${posted}` : ""),
    `📍 ${regionLine}`,
    "",
    `<blockquote expandable>${title}</blockquote>`,
    "",
    `👁 ${formatCompact(d.play_count)}  ❤ ${formatCompact(d.digg_count)}  💬 ${formatCompact(d.comment_count)}  ⭐ ${formatCompact(d.collect_count)}  ↪️ ${formatCompact(d.share_count)}`,
    "",
    "↓ <b>Choose an action</b>"
  ];

  return lines.join("\n");
}

function buildPreviewKeyboard(d) {
  const videoId = d.id || "";
  const videoUrl = d.hdplay || d.play || null;
  const audioUrl = d.music || (d.music_info && d.music_info.play) || null;
  const coverUrl = d.cover || d.origin_cover || null;
  const uniqueId = (d.author && d.author.unique_id) || "";

  const rows = [];

  // Quality / download row (URL buttons when available)
  const qualityRow = [];
  if (videoUrl) {
    qualityRow.push({ text: "Video", url: videoUrl });
  }
  if (audioUrl) {
    qualityRow.push({ text: "MP3", url: audioUrl });
  }
  if (coverUrl) {
    qualityRow.push({ text: "Cover", url: coverUrl });
  }
  if (qualityRow.length) rows.push(qualityRow);

  // Check → full analytics (callback)
  const actionRow = [];
  if (videoId) {
    // callback_data max 64 bytes — video ids fit
    actionRow.push({ text: "Check", callback_data: `check:${videoId}` });
  }
  if (uniqueId) {
    actionRow.push({
      text: `👤 ${uniqueId}`.slice(0, 30),
      url: `https://www.tiktok.com/@${uniqueId}`
    });
  }
  if (actionRow.length) rows.push(actionRow);

  if (!rows.length) return null;
  return { inline_keyboard: rows };
}

function buildDownloadKeyboard(d) {
  const row = [];
  const videoUrl = d.hdplay || d.play || null;
  if (videoUrl) row.push({ text: "Download Video", url: videoUrl });
  const audioUrl = d.music || (d.music_info && d.music_info.play) || null;
  if (audioUrl) row.push({ text: "Download Audio", url: audioUrl });
  if (row.length === 0) return null;
  return { inline_keyboard: [row] };
}

/** Second response — full analytics */
function formatFullAnalytics(d) {
  const author = d.author || {};
  const music = d.music_info || {};

  const nickname = escapeHtml(author.nickname || "Unknown");
  const uniqueId = author.unique_id ? escapeHtml(author.unique_id) : "";
  const posted = formatDate(d.create_time);
  const duration = formatDuration(d.duration);
  const regionCode = (d.region || "").toString().trim().toUpperCase();
  const flag = regionFlag(regionCode);
  const country = countryName(regionCode);
  const regionLabel = regionCode
    ? `${flag ? flag + " " : ""}${escapeHtml(country || regionCode)}`
    : "—";
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
  if (d.width && d.height) resolutionLabel = `${d.width} × ${d.height}`;

  let fpsLabel = "—";
  if (d.fps != null && !isNaN(d.fps)) fpsLabel = `${Number(d.fps)} fps`;

  // Profile like 1440p59
  let qualityShort = null;
  if (d.width && d.height) {
    const shortSide = Math.min(Number(d.width), Number(d.height));
    const shortRes =
      shortSide >= 1440
        ? "1440p"
        : shortSide >= 1080
          ? "1080p"
          : shortSide >= 720
            ? "720p"
            : `${shortSide}p`;
    if (d.fps != null && !isNaN(d.fps)) {
      qualityShort = `${shortRes}${Math.round(Number(d.fps))}`;
    } else {
      qualityShort = shortRes;
    }
  }

  // Bitrate → Mbps display (~25.0 MBps style used by Kami = Mbps)
  let bitrateLabel = null;
  if (d.bitrate_bps != null && !isNaN(d.bitrate_bps) && d.bitrate_bps > 0) {
    const mbps = Number(d.bitrate_bps) / 1_000_000;
    bitrateLabel = `~${mbps.toFixed(1)} Mbps`;
  }

  const codecLabel = d.codec ? String(d.codec).toLowerCase() : null;

  const streamUrl = d.hdplay || d.play || null;

  // Format bitrate for display (Mbps or KBps like Kami)
  function formatBitrate(bps) {
    if (bps == null || isNaN(bps) || bps <= 0) return null;
    const n = Number(bps);
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MBps`;
    if (n >= 1_000) return `${Math.round(n / 1_000)} KBps`;
    return `${n} bps`;
  }

  // Build multi-stream CDN list (live variants)
  const streamList = Array.isArray(d.streams) ? d.streams : [];
  const streamBlocks = [];

  if (streamList.length) {
    for (const s of streamList.slice(0, 8)) {
      const name = escapeHtml(s.name || "play_addr");
      const parts = [];
      if (s.profile) parts.push(s.profile);
      const br = formatBitrate(s.bitrate_bps);
      if (br) parts.push(br);
      if (s.codec) parts.push(s.codec);
      if (s.size) parts.push(formatBytes(s.size));
      const detail = parts.length ? parts.join(" · ") : "—";
      const href = s.url || streamUrl || null;
      // Only gear name (adapt_*) is clickable — not the stats line
      if (href) {
        streamBlocks.push(
          `<a href="${escapeHtml(href)}">${name}</a>\n${escapeHtml(detail)}`
        );
      } else {
        streamBlocks.push(`${name}\n${escapeHtml(detail)}`);
      }
    }
  } else {
    // Fallback single play_addr
    const playParts = [];
    if (qualityShort) playParts.push(qualityShort);
    if (bitrateLabel) playParts.push(bitrateLabel);
    if (codecLabel) playParts.push(codecLabel);
    if (sizeLabel && sizeLabel !== "—") playParts.push(sizeLabel);
    const playAddrLine = playParts.length ? playParts.join(" · ") : "—";
    if (streamUrl) {
      streamBlocks.push(
        `<a href="${escapeHtml(streamUrl)}">play_addr</a>\n${escapeHtml(playAddrLine)}`
      );
    } else {
      streamBlocks.push(`play_addr\n${escapeHtml(playAddrLine)}`);
    }
  }

  // expandable = Telegram collapsible quote (chevron)
  const playAddrBlock =
    streamBlocks.length > 0
      ? `<blockquote expandable>${streamBlocks.join("\n\n")}</blockquote>`
      : "";

  const originalLine =
    d.width && d.height
      ? `| Original | ${d.width}×${d.height}${
          d.fps != null && !isNaN(d.fps) ? ` · ${Math.round(Number(d.fps))}fps` : ""
        }`
      : null;

  const quotedCaption = `<blockquote expandable>${title}</blockquote>`;

  // Layout: QUALITY → Browser/Phone → Original → Duration/Format → stream CDN (adapt_*/play_addr)
  const qualityLines = [
    "☆ <b>QUALITY</b>",
    `  ⚬ Browser | ${qualityShort || "—"}`,
    `  ⚬ Phone | ${qualityShort || "—"}`,
    ""
  ];
  if (originalLine) {
    qualityLines.push(escapeHtml(originalLine));
  }
  qualityLines.push(
    `  ⚬ Duration: ${duration}`,
    `  ⚬ Format: MP4`
  );
  // Stream CDN list at the bottom (after Original)
  if (playAddrBlock) {
    qualityLines.push("");
    qualityLines.push(playAddrBlock);
  }

  const lines = [
    "📊 <b>VIDEO — ANALYTICS</b>",
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
    `  ⚬ Region Upload: ${regionLabel}`,
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

async function sendPreviewMedia(token, chatId, d, caption, keyboard) {
  const shortCaption =
    caption.length > 1000 ? caption.slice(0, 997) + "…" : caption;

  const videoUrl = d.hdplay || d.play || null;
  const coverUrl = d.cover || d.origin_cover || null;

  if (videoUrl) {
    const ok = await telegramApi(token, "sendVideo", {
      chat_id: chatId,
      video: videoUrl,
      caption: shortCaption,
      parse_mode: "HTML",
      supports_streaming: true,
      reply_markup: keyboard || undefined
    });
    if (ok) return true;
  }

  if (coverUrl) {
    const ok = await telegramApi(token, "sendPhoto", {
      chat_id: chatId,
      photo: coverUrl,
      caption: shortCaption,
      parse_mode: "HTML",
      reply_markup: keyboard || undefined
    });
    if (ok) return true;
  }

  return false;
}

async function telegramApi(token, method, payload) {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    );
    if (!response.ok) {
      const body = await response.text();
      console.error(`${method} failed:`, response.status, body);
      if (payload.parse_mode && response.status === 400) {
        const retryPayload = { ...payload };
        delete retryPayload.parse_mode;
        const retry = await fetch(
          `https://api.telegram.org/bot${token}/${method}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(retryPayload)
          }
        );
        return retry.ok;
      }
      return false;
    }
    return true;
  } catch (e) {
    console.error(`${method} error:`, e);
    return false;
  }
}

async function deleteMessage(token, chatId, messageId) {
  if (!messageId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId })
    });
  } catch {
    /* ignore */
  }
}

async function fetchVideoData(url) {
  let web = null;
  let wm = null;

  // Parallel: TikTok page scrape (resolution/FPS) + TikWM (stats/downloads)
  const tasks = [
    fetchTikTokWeb(url).catch((e) => {
      console.error("TikTok web scrape error:", e.message || e);
      return null;
    }),
    fetchTikWM(url).catch((e) => {
      console.error("TikWM error:", e.message || e);
      return null;
    })
  ];
  const [webRes, wmRes] = await Promise.all(tasks);
  web = webRes;
  wm = wmRes;

  if (!web && !wm) return null;
  const merged = mergeSources(web, wm, url);

  // Friend method: TikWM play URL → Range structure only → MP4 parser (FPS + resolution)
  if (merged && (merged.fps == null || isNaN(merged.fps))) {
    try {
      const idOrUrl = merged.originalUrl || url || merged.id;
      const struct = await getFpsFromTikWmStructure(idOrUrl);
      console.log("mp4Parser result:", struct?.source, "fps=", struct?.fps, "wh=", struct?.width, struct?.height);
      if (struct?.fps) {
        merged.fps = struct.fps;
        if (struct.width) merged.width = struct.width;
        if (struct.height) merged.height = struct.height;
        if (struct.codec) merged.codec = struct.codec;
        if (Array.isArray(merged.streams)) {
          for (const s of merged.streams) {
            s.fps = struct.fps;
            s.profile = streamProfile(
              s.width || merged.width,
              s.height || merged.height,
              struct.fps
            );
          }
        } else if (merged.width && merged.height) {
          merged.streams = [
            {
              name: "play_addr",
              width: merged.width,
              height: merged.height,
              fps: struct.fps,
              bitrate_bps: null,
              codec: struct.codec || "h264",
              size: merged.size || null,
              url: merged.hdplay || merged.play || null,
              profile: streamProfile(merged.width, merged.height, struct.fps)
            }
          ];
        }
      } else if (struct?.width && struct?.height) {
        if (!merged.width) merged.width = struct.width;
        if (!merged.height) merged.height = struct.height;
      }
    } catch (e) {
      console.error("mp4Parser:", e.message || e);
    }
  }

  // Fallback probe on existing play URLs from merge
  if (merged && (merged.fps == null || isNaN(merged.fps))) {
    const candidates = [];
    if (merged.hdplay) candidates.push(merged.hdplay);
    if (merged.play && merged.play !== merged.hdplay) candidates.push(merged.play);
    for (const mediaUrl of candidates.slice(0, 2)) {
      try {
        const probed = await probeVideoSource(mediaUrl);
        if (probed?.fps) {
          merged.fps = probed.fps;
          if (Array.isArray(merged.streams)) {
            for (const s of merged.streams) {
              s.fps = probed.fps;
              s.profile = streamProfile(
                s.width || merged.width || probed.width,
                s.height || merged.height || probed.height,
                probed.fps
              );
            }
          }
          break;
        }
      } catch (e) {
        console.error("probeVideoSource:", e.message || e);
      }
    }
  }

  return merged;
}


/**
 * Scrape public TikTok video page for width / height / FPS / bit_rate streams.
 * No API key. Resolves short links, then parses embedded JSON.
 */
async function fetchTikTokWeb(input) {
  let pageUrl = String(input).trim();

  // Raw id → canonical path (redirect still needed for full data sometimes)
  if (/^\d{15,25}$/.test(pageUrl)) {
    pageUrl = `https://www.tiktok.com/@/video/${pageUrl}`;
  }

  // Expand short links (vm/vt/t) — via proxy when configured
  if (/tiktok\.com\/(t\/|vm\/|vt\/)/i.test(pageUrl) || /https?:\/\/(vm|vt)\.tiktok\.com/i.test(pageUrl)) {
    try {
      const head = await fetch(pageUrl, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml"
        },
        signal: AbortSignal.timeout(12000)
      });
      if (head.url) pageUrl = head.url;
    } catch (e) {
      console.error("short-link resolve:", e.message || e);
    }
  }

  const response = await fetch(pageUrl, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.tiktok.com/"
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) throw new Error(`TikTok page HTTP ${response.status}`);

  const html = await response.text();
  const item = extractItemFromHtml(html);
  if (!item) throw new Error("No video JSON in page");

  return normalizeWebItem(item, response.url || pageUrl);
}

function extractItemFromHtml(html) {
  // 1) __UNIVERSAL_DATA_FOR_REHYDRATION__
  const uni = html.match(
    /id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (uni) {
    try {
      const j = JSON.parse(uni[1]);
      const detail =
        j?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct ||
        j?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct ||
        null;
      if (detail) return detail;
      // deep search
      const found = deepFindItemStruct(j);
      if (found) return found;
    } catch {
      /* continue */
    }
  }

  // 2) SIGI_STATE
  const sigi = html.match(
    /id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (sigi) {
    try {
      const j = JSON.parse(sigi[1]);
      if (j?.ItemModule) {
        const keys = Object.keys(j.ItemModule);
        if (keys.length) return j.ItemModule[keys[0]];
      }
      const found = deepFindItemStruct(j);
      if (found) return found;
    } catch {
      /* continue */
    }
  }

  // 3) Generic script JSON with itemStruct
  const scripts = html.matchAll(
    /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const m of scripts) {
    try {
      const j = JSON.parse(m[1]);
      const found = deepFindItemStruct(j);
      if (found) return found;
    } catch {
      /* next */
    }
  }

  // 4) Regex fallback for "itemStruct":{...} (limited)
  const im = html.match(/"itemStruct"\s*:\s*(\{)/);
  if (im) {
    try {
      const start = im.index + im[0].length - 1;
      const obj = extractJsonObject(html, start);
      if (obj) return JSON.parse(obj);
    } catch {
      /* ignore */
    }
  }

  return null;
}

function deepFindItemStruct(obj, depth = 0) {
  if (!obj || depth > 8) return null;
  if (typeof obj !== "object") return null;
  if (obj.itemStruct && obj.itemStruct.video) return obj.itemStruct;
  if (obj.video && (obj.awemeId || obj.id || obj.author) && obj.stats) return obj;
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const f = deepFindItemStruct(x, depth + 1);
      if (f) return f;
    }
    return null;
  }
  for (const k of Object.keys(obj)) {
    if (k === "props" || k === "children") continue;
    const f = deepFindItemStruct(obj[k], depth + 1);
    if (f) return f;
  }
  return null;
}

function extractJsonObject(text, startIdx) {
  let i = startIdx;
  if (text[i] !== "{") return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < text.length && i < startIdx + 500000; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

function streamProfile(w, h, fpsVal) {
  if (!w || !h) return null;
  const shortSide = Math.min(Number(w), Number(h));
  const label =
    shortSide >= 1440
      ? "1440p"
      : shortSide >= 1080
        ? "1080p"
        : shortSide >= 720
          ? "720p"
          : shortSide >= 540
            ? "540p"
            : `${shortSide}p`;
  if (fpsVal != null && !isNaN(fpsVal)) {
    return `${label}${Math.round(Number(fpsVal))}`;
  }
  return label;
}

function detectCodecFromEntry(entry) {
  if (!entry) return "h264";
  if (entry.is_h265 || entry.isH265 || entry.is_bytevc1) return "hevc";
  const gear = String(entry.gearName || entry.gear_name || "");
  if (/h265|bytevc|hevc/i.test(gear)) return "hevc";
  if (/h264|avc/i.test(gear)) return "h264";
  const ct = String(entry.CodecType || entry.codec_type || entry.codec || "");
  if (/h265|hevc|bytevc/i.test(ct)) return "hevc";
  return ct ? ct.toLowerCase() : "h264";
}

function normalizeWebItem(item, pageUrl) {
  const video = item.video || {};
  const author = item.author || {};
  const music = item.music || {};
  const stats = item.stats || item.statistics || {};

  const bitRates =
    video.bitrateInfo ||
    video.bit_rate ||
    video.bitRateList ||
    video.bitrate_info ||
    [];

  const streams = [];
  if (Array.isArray(bitRates)) {
    for (const entry of bitRates) {
      const addr =
        entry.PlayAddr ||
        entry.playAddr ||
        entry.play_addr ||
        entry.PlayAddrStruct ||
        {};
      const w = addr.Width || addr.width || entry.width || null;
      const h = addr.Height || addr.height || entry.height || null;
      const fpsVal =
        entry.FPS || entry.fps || entry.FrameRate || entry.frame_rate || null;
      const bps =
        entry.Bitrate ||
        entry.bitrate ||
        entry.bit_rate ||
        addr.Bitrate ||
        null;
      const size =
        addr.DataSize ||
        addr.data_size ||
        entry.DataSize ||
        entry.data_size ||
        null;
      const urlList =
        addr.UrlList ||
        addr.url_list ||
        entry.UrlList ||
        null;
      let url = null;
      if (Array.isArray(urlList) && urlList.length) url = urlList[0];
      else if (typeof addr === "string") url = addr;

      const gear =
        entry.GearName ||
        entry.gearName ||
        entry.gear_name ||
        entry.quality_type ||
        "play_addr";

      streams.push({
        name: String(gear),
        width: w ? Number(w) : null,
        height: h ? Number(h) : null,
        fps: fpsVal != null ? Number(fpsVal) : null,
        bitrate_bps: bps != null ? Number(bps) : null,
        codec: detectCodecFromEntry(entry),
        size: size != null ? Number(size) : null,
        url: url || null,
        profile: streamProfile(w, h, fpsVal)
      });
    }
    streams.sort((a, b) => {
      const ap = (a.width || 0) * (a.height || 0);
      const bp = (b.width || 0) * (b.height || 0);
      return bp - ap;
    });
  }

  // Main play address dimensions
  const playAddr = video.playAddr || video.play_addr || {};
  let width =
    video.width ||
    playAddr.width ||
    playAddr.Width ||
    (streams[0] && streams[0].width) ||
    null;
  let height =
    video.height ||
    playAddr.height ||
    playAddr.Height ||
    (streams[0] && streams[0].height) ||
    null;

  // ratio "1080p"
  const ratioStr = String(video.ratio || video.definition || "");
  const rm = ratioStr.match(/(\\d{3,4})p/i);
  if ((!width || !height) && rm) {
    const side = Number(rm[1]);
    width = width || side;
    height = height || Math.round(side * (16 / 9));
  }

  if (!streams.length && (width || height || playAddr)) {
    streams.push({
      name: "play_addr",
      width: width ? Number(width) : null,
      height: height ? Number(height) : null,
      fps: video.fps != null ? Number(video.fps) : null,
      bitrate_bps: null,
      codec: "h264",
      size:
        playAddr.dataSize ||
        playAddr.DataSize ||
        playAddr.data_size ||
        null,
      url: Array.isArray(playAddr.url_list)
        ? playAddr.url_list[0]
        : Array.isArray(playAddr.UrlList)
          ? playAddr.UrlList[0]
          : null,
      profile: streamProfile(width, height, video.fps)
    });
  }

  const best = streams[0] || null;
  const fps =
    (best && best.fps) ||
    (video.fps != null ? Number(video.fps) : null) ||
    null;

  const durationRaw = video.duration || item.duration || music.duration || 0;
  const durationSec =
    durationRaw > 1000
      ? Math.round(Number(durationRaw) / 1000)
      : Math.round(Number(durationRaw) || 0);

  const cover =
    video.cover ||
    video.originCover ||
    video.origin_cover ||
    video.dynamicCover ||
    null;
  const coverUrl =
    typeof cover === "string"
      ? cover
      : cover?.url_list?.[0] ||
        cover?.UrlList?.[0] ||
        null;

  return {
    source: "tiktok-web",
    id: String(item.id || item.awemeId || item.aweme_id || ""),
    title: item.desc || item.description || item.title || "",
    create_time: item.createTime || item.create_time || null,
    region: item.region || author.region || "",
    duration: durationSec,
    width: width ? Number(width) : null,
    height: height ? Number(height) : null,
    fps: fps,
    bitrate_bps: (best && best.bitrate_bps) || null,
    codec: (best && best.codec) || null,
    streams,
    play_count: stats.playCount ?? stats.play_count ?? null,
    digg_count: stats.diggCount ?? stats.digg_count ?? null,
    comment_count: stats.commentCount ?? stats.comment_count ?? null,
    share_count: stats.shareCount ?? stats.share_count ?? null,
    collect_count: stats.collectCount ?? stats.collect_count ?? null,
    download_count: stats.downloadCount ?? stats.download_count ?? null,
    author: {
      unique_id: author.uniqueId || author.unique_id || "",
      nickname: author.nickname || author.nickName || ""
    },
    music_info: {
      id: music.id || music.mid || "",
      title: music.title || "Original sound",
      author: music.authorName || music.author || "",
      play: music.playUrl || music.play_url || null
    },
    play: null,
    hdplay: null,
    music: music.playUrl || music.play_url || null,
    cover: coverUrl,
    origin_cover: coverUrl,
    size: (best && best.size) || null,
    hd_size: null,
    is_ad: !!item.isAd || !!item.is_ad,
    originalUrl: pageUrl
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

  const params = new URLSearchParams({ url: String(url), hd: "1" });
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
    cover: d.cover || null,
    origin_cover: d.origin_cover || d.cover || null,
    size: d.size || null,
    hd_size: d.hd_size || null,
    is_ad: !!d.is_ad
  };
}



function mergeSources(hub, wm, originalUrl) {
  const base = hub || wm;
  if (!base) return null;
  const other = hub ? wm : null;

  return {
    source: hub ? "tiktok-web" : "tikwm",
    id: base.id || (other && other.id) || "",
    title: base.title || (other && other.title) || "",
    create_time: base.create_time || (other && other.create_time) || null,
    region: base.region || (other && other.region) || "",
    duration: base.duration ?? (other && other.duration) ?? null,
    width: base.width ?? (other && other.width) ?? null,
    height: base.height ?? (other && other.height) ?? null,
    fps: base.fps ?? (other && other.fps) ?? null,
    bitrate_bps: base.bitrate_bps ?? (other && other.bitrate_bps) ?? null,
    codec: base.codec ?? (other && other.codec) ?? null,
    streams: (base.streams && base.streams.length)
      ? base.streams
      : (other && other.streams) || [],
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
    play: (other && other.play) || base.play || null,
    hdplay: (other && other.hdplay) || base.hdplay || null,
    music: (other && other.music) || base.music || null,
    cover: (other && other.cover) || base.cover || null,
    origin_cover:
      (other && other.origin_cover) ||
      base.origin_cover ||
      (other && other.cover) ||
      base.cover ||
      null,
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

function regionFlag(code) {
  if (!code || typeof code !== "string") return "";
  const cc = code.trim().toUpperCase();
  if (cc.length !== 2 || !/^[A-Z]{2}$/.test(cc)) return "";
  const A = 0x1f1e6;
  return [...cc].map((c) => String.fromCodePoint(A + c.charCodeAt(0) - 65)).join("");
}

function countryName(code) {
  const map = {
    US: "United States", GB: "United Kingdom", PH: "Philippines", ID: "Indonesia",
    VN: "Vietnam", TH: "Thailand", MY: "Malaysia", SG: "Singapore", JP: "Japan",
    KR: "South Korea", CN: "China", TW: "Taiwan", HK: "Hong Kong", IN: "India",
    AU: "Australia", NZ: "New Zealand", CA: "Canada", MX: "Mexico", BR: "Brazil",
    AR: "Argentina", CL: "Chile", CO: "Colombia", PE: "Peru", FR: "France",
    DE: "Germany", ES: "Spain", IT: "Italy", PT: "Portugal", NL: "Netherlands",
    BE: "Belgium", SE: "Sweden", NO: "Norway", DK: "Denmark", FI: "Finland",
    PL: "Poland", RU: "Russia", UA: "Ukraine", TR: "Turkey", SA: "Saudi Arabia",
    AE: "UAE", EG: "Egypt", ZA: "South Africa", NG: "Nigeria", KE: "Kenya",
    PK: "Pakistan", BD: "Bangladesh", RO: "Romania", CZ: "Czechia", AT: "Austria",
    CH: "Switzerland", IE: "Ireland", IL: "Israel", GR: "Greece", HU: "Hungary"
  };
  return map[code] || null;
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

function formatDateShort(unix) {
  if (!unix) return "";
  const d = new Date(Number(unix) * 1000);
  if (isNaN(d.getTime())) return "";
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
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

function formatCompact(n) {
  if (n == null || isNaN(n)) return "0";
  const num = Number(n);
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(num);
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
    /* ignore */
  }
}
