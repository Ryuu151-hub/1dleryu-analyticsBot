/**
 * FPS helpers without TikHub.
 * Tries MP4 probe on TikWM play URL only (may fail on Vercel IPs).
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export async function scrapeFps(videoUrlOrId) {
  try {
    const wm = await fetchTikWmPlay(videoUrlOrId);
    if (!wm?.play) {
      return { fps: null, width: wm?.width || null, height: wm?.height || null, source: "tikwm-no-play" };
    }
    const probed = await probeMp4Fps(wm.play);
    if (probed?.fps) {
      return {
        fps: probed.fps,
        width: probed.width || wm.width || null,
        height: probed.height || wm.height || null,
        source: "mp4-probe"
      };
    }
    return {
      fps: null,
      width: wm.width || null,
      height: wm.height || null,
      source: "probe-failed"
    };
  } catch (e) {
    console.error("scrapeFps:", e.message || e);
    return { fps: null, width: null, height: null, source: "error" };
  }
}

async function fetchTikWmPlay(urlOrId) {
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
    play: d.hdplay || d.play || null,
    width: d.width || null,
    height: d.height || null
  };
}

async function probeMp4Fps(playUrl) {
  const res = await fetch(playUrl, {
    headers: {
      "User-Agent": UA,
      Range: "bytes=0-2097151",
      Referer: "https://www.tiktok.com/"
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok && res.status !== 206) return null;
  const u8 = new Uint8Array(await res.arrayBuffer());
  return parseSttsFps(u8);
}

function rd32(u8, o) {
  return ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
}
function typeAt(u8, o) {
  return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
}

function parseSttsFps(u8) {
  let timescale = null;
  let fps = null;
  let width = null;
  let height = null;
  let inVideo = false;

  function walk(start, end, depth) {
    if (depth > 14) return;
    let o = start;
    while (o + 8 <= end) {
      let size = rd32(u8, o);
      const type = typeAt(u8, o + 4);
      let hdr = 8;
      if (size === 1) {
        size = end - o;
        hdr = 16;
      } else if (size === 0) size = end - o;
      if (size < hdr) break;
      if (o + size > end) size = end - o;
      const ds = o + hdr;
      const de = Math.min(o + size, end);

      if (["moov", "trak", "mdia", "minf", "stbl"].includes(type)) {
        if (type === "trak") inVideo = false;
        walk(ds, de, depth + 1);
      } else if (type === "hdlr" && ds + 12 <= de) {
        inVideo = typeAt(u8, ds + 8) === "vide";
      } else if (type === "mdhd" && inVideo) {
        const v = u8[ds];
        if (v === 0 && ds + 16 <= de) timescale = rd32(u8, ds + 12);
        else if (v === 1 && ds + 24 <= de) timescale = rd32(u8, ds + 20);
      } else if (type === "stts" && inVideo && timescale) {
        const n = rd32(u8, ds + 4);
        if (n >= 1 && n < 10000 && ds + 16 <= de) {
          let samples = 0, ticks = 0, p = ds + 8;
          for (let i = 0; i < Math.min(n, 500) && p + 8 <= de; i++) {
            const c = rd32(u8, p);
            const d = rd32(u8, p + 4);
            samples += c;
            ticks += c * d;
            p += 8;
          }
          if (samples && ticks) {
            const f = timescale / (ticks / samples);
            if (f > 1 && f < 128) fps = Math.round(f);
          }
        }
      } else if ((type === "avc1" || type === "hvc1") && ds + 28 <= de) {
        inVideo = true;
        const w = (u8[ds + 24] << 8) | u8[ds + 25];
        const h = (u8[ds + 26] << 8) | u8[ds + 27];
        if (w > 0 && h > 0) {
          width = w;
          height = h;
        }
      }
      o += size;
    }
  }

  walk(0, u8.length, 0);
  if (!fps && !width) return null;
  return { fps, width, height };
}

export default { scrapeFps };
