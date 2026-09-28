/**
 * Optional FPS probe from an MP4 URL (direct, no proxy).
 * Often blocked from Vercel IPs — bot still works without FPS.
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export async function probeVideoSource(videoUrl, opts = {}) {
  if (!videoUrl || typeof videoUrl !== "string") return null;
  const timeoutMs = opts.timeoutMs ?? 12000;
  const rangeBytes = opts.rangeBytes ?? 2_097_151;

  try {
    const head = await fetchRange(videoUrl, 0, rangeBytes, timeoutMs);
    const parsed = head ? parseMp4VideoTrack(head) : null;
    if (parsed?.fps) return finalize(parsed);
    return finalize(parsed);
  } catch (e) {
    console.error("fpsProbe:", e.message || e);
    return null;
  }
}

async function fetchRange(url, start, end, timeoutMs) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Range: `bytes=${start}-${end}`,
      Accept: "*/*",
      Referer: "https://www.tiktok.com/"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok && res.status !== 206) return null;
  return new Uint8Array(await res.arrayBuffer());
}

function finalize(meta) {
  if (!meta || (!meta.fps && !meta.width)) return null;
  if (meta.fps && meta.fps > 1 && meta.fps < 128) {
    const standards = [24, 25, 30, 50, 60];
    let best = meta.fps;
    let bestDiff = 0.75;
    for (const s of standards) {
      const d = Math.abs(meta.fps - s);
      if (d < bestDiff) {
        bestDiff = d;
        best = s;
      }
    }
    meta.fps = bestDiff < 0.75 ? best : Math.round(meta.fps);
  }
  return {
    fps: meta.fps ?? null,
    width: meta.width ?? null,
    height: meta.height ?? null,
    codec: meta.codec ?? null,
    source: "mp4"
  };
}

function rd32(u8, o) {
  return ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
}
function rd16(u8, o) {
  return (u8[o] << 8) | u8[o + 1];
}
function typeAt(u8, o) {
  return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
}

function parseMp4VideoTrack(u8) {
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
      if (type === "trak" && child.inVideo && child.fps && !out.fps) out.fps = child.fps;
    } else if (type === "hdlr" && ds + 12 <= de) {
      const h = typeAt(u8, ds + 8);
      if (h === "vide") ctx.inVideo = true;
      if (h === "soun") ctx.inVideo = false;
    } else if (type === "vmhd") ctx.inVideo = true;
    else if (type === "smhd") ctx.inVideo = false;
    else if (type === "mdhd") {
      const v = u8[ds];
      if (v === 0 && ds + 16 <= de) ctx.timescale = rd32(u8, ds + 12);
      else if (v === 1 && ds + 24 <= de) ctx.timescale = rd32(u8, ds + 20);
    } else if (type === "stts" && ctx.inVideo && ctx.timescale) {
      const fps = fpsFromStts(u8, ds, de, ctx.timescale);
      if (fps) {
        ctx.fps = fps;
        out.fps = out.fps || fps;
      }
    } else if ((type === "avc1" || type === "hvc1" || type === "hev1") && ds + 28 <= de) {
      ctx.inVideo = true;
      const w = rd16(u8, ds + 24);
      const h = rd16(u8, ds + 26);
      if (w > 0 && h > 0) {
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
  if (end - start < 16) return null;
  const n = rd32(u8, start + 4);
  if (n < 1 || n > 100000) return null;
  let samples = 0, ticks = 0, pos = start + 8;
  for (let i = 0; i < Math.min(n, 2000) && pos + 8 <= end; i++) {
    const c = rd32(u8, pos);
    const d = rd32(u8, pos + 4);
    samples += c;
    ticks += c * d;
    pos += 8;
  }
  if (!samples || !ticks) return null;
  const fps = timescale / (ticks / samples);
  return fps > 1 && fps < 128 ? fps : null;
}

export default { probeVideoSource };
