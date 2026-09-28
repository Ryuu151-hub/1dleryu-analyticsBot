/**
 * Friend's method:
 * 1) TikWM → play URL (not full file)
 * 2) Range-download only the MP4 structure (moov / headers)
 * 3) Parse atoms → width, height, FPS
 *
 * Light & fast — typically 1–3 MB, not the whole video.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/**
 * @param {string} tiktokUrlOrId
 * @returns {Promise<{ fps: number|null, width: number|null, height: number|null, codec: string|null, source: string }>}
 */
export async function getFpsFromTikWmStructure(tiktokUrlOrId) {
  const play = await getTikWmPlayUrl(tiktokUrlOrId);
  if (!play?.url) {
    return { fps: null, width: play?.width || null, height: play?.height || null, codec: null, source: "no-play-url" };
  }

  // Structure only — head, then tail if moov is at end
  const meta = await parseMp4ViaRange(play.url);
  return {
    fps: meta?.fps ?? null,
    width: meta?.width || play.width || null,
    height: meta?.height || play.height || null,
    codec: meta?.codec || null,
    source: meta?.fps ? "mp4-structure" : "structure-no-fps"
  };
}

async function getTikWmPlayUrl(urlOrId) {
  const base = process.env.TIKWM_API_URL || "https://tikwm.com/api/";
  const params = new URLSearchParams({ url: String(urlOrId), hd: "1" });
  const res = await fetch(`${base}?${params}`, {
    headers: { Accept: "application/json", "User-Agent": "TelegramTikTokBot/1.0" },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`TikWM HTTP ${res.status}`);
  const json = await res.json();
  if (!json?.data) throw new Error(json?.msg || "TikWM failed");
  const d = json.data;
  return {
    url: d.hdplay || d.play || null,
    width: d.width ? Number(d.width) : null,
    height: d.height ? Number(d.height) : null
  };
}

/**
 * Download only structure bytes (not full MP4).
 */
async function parseMp4ViaRange(playUrl) {
  const chunk = 3_145_727; // ~3MB structure window

  // 1) Beginning of file (ftyp + often moov)
  let u8 = await rangeBytes(playUrl, 0, chunk);
  let meta = u8 ? parseMp4Structure(u8) : null;
  if (meta?.fps) return snap(meta);

  // 2) End of file (many TikTok files put moov at the end)
  try {
    const head = await fetch(playUrl, {
      method: "HEAD",
      headers: { "User-Agent": UA, Referer: "https://www.tiktok.com/" },
      signal: AbortSignal.timeout(8000)
    });
    const len = Number(head.headers.get("content-length") || 0);
    if (len > 500_000) {
      const start = Math.max(0, len - chunk - 1);
      const tail = await rangeBytes(playUrl, start, len - 1);
      if (tail) {
        const m2 = parseMp4Structure(tail);
        meta = merge(meta, m2);
      }
    }
  } catch (e) {
    console.error("mp4Parser tail:", e.message || e);
  }

  return snap(meta);
}

async function rangeBytes(url, start, end) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Range: `bytes=${start}-${end}`,
      Accept: "*/*",
      Referer: "https://www.tiktok.com/",
      Origin: "https://www.tiktok.com"
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok && res.status !== 206) {
    console.error("mp4Parser Range HTTP", res.status);
    return null;
  }
  return new Uint8Array(await res.arrayBuffer());
}

function merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    fps: a.fps ?? b.fps ?? null,
    width: a.width ?? b.width ?? null,
    height: a.height ?? b.height ?? null,
    codec: a.codec ?? b.codec ?? null
  };
}

function snap(meta) {
  if (!meta) return null;
  if (meta.fps && meta.fps > 1 && meta.fps < 128) {
    const std = [24, 25, 30, 50, 60];
    let best = meta.fps;
    let diff = 0.8;
    for (const s of std) {
      const d = Math.abs(meta.fps - s);
      if (d < diff) {
        diff = d;
        best = s;
      }
    }
    meta.fps = diff < 0.8 ? best : Math.round(meta.fps);
  }
  return meta;
}

/* -------- MP4 structure parser (video track only) -------- */

function rd32(u8, o) {
  return ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
}
function rd16(u8, o) {
  return (u8[o] << 8) | u8[o + 1];
}
function typeAt(u8, o) {
  return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
}

function parseMp4Structure(u8) {
  const out = { fps: null, width: null, height: null, codec: null };
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
      size = rd32(u8, offset + 8) === 0 ? rd32(u8, offset + 12) : end - offset;
      header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header) break;
    if (offset + size > end) size = end - offset;

    const ds = offset + header;
    const de = Math.min(offset + size, end);

    if (type === "moov" || type === "trak" || type === "mdia" || type === "minf" || type === "stbl") {
      const child = type === "trak" ? { inVideo: false, timescale: null } : { ...ctx };
      walk(u8, ds, de, out, depth + 1, child);
      if (type === "trak" && child.inVideo) {
        if (child.fps && !out.fps) out.fps = child.fps;
        if (child.width && !out.width) out.width = child.width;
        if (child.height && !out.height) out.height = child.height;
      }
    } else if (type === "hdlr" && ds + 12 <= de) {
      const h = typeAt(u8, ds + 8);
      if (h === "vide") ctx.inVideo = true;
      if (h === "soun") ctx.inVideo = false;
    } else if (type === "vmhd") {
      ctx.inVideo = true;
    } else if (type === "smhd") {
      ctx.inVideo = false;
    } else if (type === "mdhd" && ctx.inVideo) {
      const v = u8[ds];
      if (v === 0 && ds + 16 <= de) ctx.timescale = rd32(u8, ds + 12);
      else if (v === 1 && ds + 24 <= de) ctx.timescale = rd32(u8, ds + 20);
    } else if (type === "stts" && ctx.inVideo && ctx.timescale) {
      const fps = fpsFromStts(u8, ds, de, ctx.timescale);
      if (fps) {
        ctx.fps = fps;
        out.fps = out.fps || fps;
      }
    } else if (type === "tkhd" && ctx.inVideo) {
      const wh = sizeFromTkhd(u8, ds, de);
      if (wh) {
        ctx.width = wh.w;
        ctx.height = wh.h;
        out.width = out.width || wh.w;
        out.height = out.height || wh.h;
      }
    } else if ((type === "avc1" || type === "hvc1" || type === "hev1") && ds + 28 <= de) {
      ctx.inVideo = true;
      const w = rd16(u8, ds + 24);
      const h = rd16(u8, ds + 26);
      if (w > 0 && h > 0) {
        ctx.width = w;
        ctx.height = h;
        out.width = out.width || w;
        out.height = out.height || h;
      }
      out.codec = out.codec || (type === "avc1" ? "h264" : "hevc");
    }

    if (size <= header) break;
    offset += size;
  }
}

function fpsFromStts(u8, start, end, timescale) {
  if (end - start < 16 || !timescale) return null;
  const n = rd32(u8, start + 4);
  if (n < 1 || n > 100000) return null;
  let samples = 0;
  let ticks = 0;
  let pos = start + 8;
  for (let i = 0; i < Math.min(n, 2000) && pos + 8 <= end; i++) {
    const sampleCount = rd32(u8, pos);
    const sampleDelta = rd32(u8, pos + 4);
    samples += sampleCount;
    ticks += sampleCount * sampleDelta;
    pos += 8;
  }
  if (!samples || !ticks) return null;
  const fps = timescale / (ticks / samples);
  return fps > 1 && fps < 128 ? fps : null;
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

export default { getFpsFromTikWmStructure };
