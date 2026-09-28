/**
 * Real FPS / resolution probe from a TikTok (or any) MP4 CDN URL.
 * Parses MP4 atoms from Range requests — video track only (ignores audio).
 *
 * Usage:
 *   import { probeVideoSource } from "./lib/fpsProbe.js";
 *   const meta = await probeVideoSource(mp4Url);
 *   // { fps, width, height, codec, timescale, source }
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/**
 * @param {string} videoUrl - Direct MP4 / play_addr CDN link
 * @param {{ timeoutMs?: number, rangeBytes?: number }} [opts]
 * @returns {Promise<{ fps: number|null, width: number|null, height: number|null, codec: string|null, timescale: number|null, source: string }|null>}
 */
export async function probeVideoSource(videoUrl, opts = {}) {
  if (!videoUrl || typeof videoUrl !== "string") return null;

  const timeoutMs = opts.timeoutMs ?? 15000;
  const rangeBytes = opts.rangeBytes ?? 4_194_303; // 4MB

  let best = null;

  // Head of file
  try {
    const head = await fetchRange(videoUrl, 0, rangeBytes, timeoutMs);
    if (head) best = mergeMeta(best, parseMp4VideoTrack(head));
  } catch {
    /* ignore */
  }
  if (best?.fps) return finalize(best);

  // Tail of file (moov often at end)
  try {
    const len = await contentLength(videoUrl, timeoutMs);
    if (len && len > 500_000) {
      const start = Math.max(0, len - rangeBytes - 1);
      const tail = await fetchRange(videoUrl, start, len - 1, timeoutMs);
      if (tail) best = mergeMeta(best, parseMp4VideoTrack(tail));
    }
  } catch {
    /* ignore */
  }

  return finalize(best);
}

async function fetchRange(url, start, end, timeoutMs) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Range: `bytes=${start}-${end}`,
      Accept: "*/*",
      Referer: "https://www.tiktok.com/",
      Origin: "https://www.tiktok.com"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok && res.status !== 206) return null;
  return new Uint8Array(await res.arrayBuffer());
}

async function contentLength(url, timeoutMs) {
  const res = await fetch(url, {
    method: "HEAD",
    headers: { "User-Agent": UA, Referer: "https://www.tiktok.com/" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const n = Number(res.headers.get("content-length") || 0);
  return n > 0 ? n : null;
}

function mergeMeta(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    fps: a.fps ?? b.fps ?? null,
    width: a.width ?? b.width ?? null,
    height: a.height ?? b.height ?? null,
    codec: a.codec ?? b.codec ?? null,
    timescale: a.timescale ?? b.timescale ?? null,
    source: a.source || b.source || "mp4"
  };
}

function finalize(meta) {
  if (!meta) return null;
  if (!meta.fps && !meta.width) return null;

  if (meta.fps && meta.fps > 1 && meta.fps < 128) {
    // Snap only when very close to a standard rate (avoid inventing 48fps from noise)
    const standards = [24, 25, 29.97, 30, 50, 59.94, 60];
    let snapped = meta.fps;
    let bestDiff = 0.6; // tight threshold
    for (const s of standards) {
      const d = Math.abs(meta.fps - s);
      if (d < bestDiff) {
        bestDiff = d;
        snapped = s === 29.97 ? 30 : s === 59.94 ? 60 : s;
      }
    }
    meta.fps = bestDiff < 0.6 ? snapped : Math.round(meta.fps);
  }

  return {
    fps: meta.fps ?? null,
    width: meta.width ?? null,
    height: meta.height ?? null,
    codec: meta.codec ?? null,
    timescale: meta.timescale ?? null,
    source: "mp4-video-track"
  };
}

/* ---------------- MP4 video-track parser ---------------- */

function rd32(u8, o) {
  return ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
}
function rd16(u8, o) {
  return (u8[o] << 8) | u8[o + 1];
}
function typeAt(u8, o) {
  return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
}

/**
 * Walk atoms; only keep stts/mdhd/tkhd from tracks that look like video.
 */
function parseMp4VideoTrack(u8) {
  const out = {
    fps: null,
    width: null,
    height: null,
    codec: null,
    timescale: null,
    source: "mp4"
  };
  walk(u8, 0, u8.length, out, 0, { inVideo: false, timescale: null });
  return out;
}

function walk(u8, start, end, out, depth, ctx) {
  if (depth > 16) return;
  let offset = start;

  while (offset + 8 <= end) {
    let size = rd32(u8, offset);
    const type = typeAt(u8, offset + 4);
    let header = 8;

    if (size === 1 && offset + 16 <= end) {
      const high = rd32(u8, offset + 8);
      const low = rd32(u8, offset + 12);
      size = high === 0 ? low : end - offset;
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }

    if (size < header) break;
    if (offset + size > end) size = end - offset;

    const ds = offset + header;
    const de = Math.min(offset + size, end);

    if (type === "moov" || type === "trak" || type === "mdia" || type === "minf" || type === "stbl") {
      // New trak resets video flag
      const childCtx =
        type === "trak"
          ? { inVideo: false, timescale: null }
          : { ...ctx };

      walk(u8, ds, de, out, depth + 1, childCtx);

      // Promote track-level results if this was a video trak
      if (type === "trak" && childCtx.inVideo) {
        if (childCtx.fps && !out.fps) out.fps = childCtx.fps;
        if (childCtx.timescale && !out.timescale) out.timescale = childCtx.timescale;
        if (childCtx.width && !out.width) out.width = childCtx.width;
        if (childCtx.height && !out.height) out.height = childCtx.height;
        if (childCtx.codec && !out.codec) out.codec = childCtx.codec;
      }
    } else if (type === "hdlr") {
      // Handler type at +8 from fullbox (version+flags=4) → component subtype 4 bytes
      // fullbox: version/flags (4) + pre_defined (4) + handler_type (4)
      if (ds + 12 <= de) {
        const handler = typeAt(u8, ds + 8);
        if (handler === "vide") ctx.inVideo = true;
        if (handler === "soun") ctx.inVideo = false;
      }
    } else if (type === "vmhd") {
      ctx.inVideo = true;
    } else if (type === "smhd") {
      ctx.inVideo = false;
    } else if (type === "mdhd" && ctx.inVideo !== false) {
      const version = u8[ds];
      let ts = null;
      if (version === 0 && ds + 16 <= de) ts = rd32(u8, ds + 12);
      else if (version === 1 && ds + 24 <= de) ts = rd32(u8, ds + 20);
      if (ts) {
        ctx.timescale = ts;
        if (ctx.inVideo) out.timescale = out.timescale || ts;
      }
    } else if (type === "stts" && ctx.inVideo) {
      const fps = fpsFromStts(u8, ds, de, ctx.timescale || out.timescale);
      if (fps) {
        ctx.fps = fps;
        out.fps = out.fps || fps;
      }
    } else if (type === "tkhd" && ctx.inVideo !== false) {
      const wh = sizeFromTkhd(u8, ds, de);
      if (wh) {
        if (ctx.inVideo) {
          ctx.width = wh.w;
          ctx.height = wh.h;
        }
        out.width = out.width || wh.w;
        out.height = out.height || wh.h;
      }
    } else if (
      (type === "avc1" || type === "hvc1" || type === "hev1" || type === "av01" || type === "mp4v") &&
      ds + 28 <= de
    ) {
      ctx.inVideo = true;
      const w = rd16(u8, ds + 24);
      const h = rd16(u8, ds + 26);
      if (w > 0 && h > 0 && w < 8192 && h < 8192) {
        ctx.width = w;
        ctx.height = h;
        out.width = out.width || w;
        out.height = out.height || h;
      }
      if (type === "hvc1" || type === "hev1") {
        ctx.codec = "hevc";
        out.codec = out.codec || "hevc";
      } else if (type === "avc1") {
        ctx.codec = "h264";
        out.codec = out.codec || "h264";
      } else if (type === "av01") {
        ctx.codec = "av1";
        out.codec = out.codec || "av1";
      }
    }

    if (size <= header) break;
    offset += size;
  }
}

function fpsFromStts(u8, start, end, timescale) {
  if (!timescale || end - start < 16) return null;
  const entryCount = rd32(u8, start + 4);
  if (entryCount < 1 || entryCount > 100000) return null;

  let totalSamples = 0;
  let totalTicks = 0;
  let pos = start + 8;
  const limit = Math.min(entryCount, 2000);

  for (let i = 0; i < limit && pos + 8 <= end; i++) {
    const sampleCount = rd32(u8, pos);
    const sampleDelta = rd32(u8, pos + 4);
    totalSamples += sampleCount;
    totalTicks += sampleCount * sampleDelta;
    pos += 8;
  }

  if (totalSamples <= 0 || totalTicks <= 0) return null;
  const avgDelta = totalTicks / totalSamples;
  if (avgDelta <= 0) return null;
  const fps = timescale / avgDelta;
  if (fps <= 1 || fps >= 128) return null;
  return fps;
}

function sizeFromTkhd(u8, start, end) {
  if (end - start < 4) return null;
  const version = u8[start];
  try {
    if (version === 0 && end - start >= 84) {
      const w = rd32(u8, start + 76) / 65536;
      const h = rd32(u8, start + 80) / 65536;
      if (w >= 2 && h >= 2) return { w: Math.round(w), h: Math.round(h) };
    }
    if (version === 1 && end - start >= 96) {
      const w = rd32(u8, start + 88) / 65536;
      const h = rd32(u8, start + 92) / 65536;
      if (w >= 2 && h >= 2) return { w: Math.round(w), h: Math.round(h) };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export default { probeVideoSource };
