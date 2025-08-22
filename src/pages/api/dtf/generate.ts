import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'node:crypto';
import { put } from '@vercel/blob';
import { Image } from 'image-js';

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ?? '*';

// Behavior
const VARIATIONS = Number(process.env.VARIATIONS || 3);
const MARGIN_FRACTION = Number(process.env.MARGIN_FRACTION || 0.12);
const MAX_GEN_SIDE = Number(process.env.NEBIUS_MAX_SIZE || 2048);

// remove.bg
const REMOVE_BG_KEY = process.env.REMOVE_BG_API_KEY || '';
const REMOVE_BG_SIZE = process.env.REMOVE_BG_SIZE || 'auto';
const REMOVE_BG_CHANNELS = process.env.REMOVE_BG_CHANNELS || 'rgba';

// vectorizer.ai
const VECTORIZER_ID = process.env.VECTORIZER_API_ID || '';
const VECTORIZER_SECRET = process.env.VECTORIZER_API_SECRET || '';
const VECTORIZER_MODE =
  (process.env.VECTORIZER_MODE as 'production' | 'test' | 'test_preview' | 'preview') || 'production';
const VECTORIZER_MAX_COLORS = Number(process.env.VECTORIZER_MAX_COLORS || 0) || undefined;
const VECTORIZER_RETENTION_DAYS = Number(process.env.VECTORIZER_RETENTION_DAYS || 0) || 0;

// ---------- small utils ----------
const px = (inches: number, dpi = 300) => Math.round(inches * dpi);

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    console.log(`[DTF] STEP_OK ${name}`);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[DTF] STEP_FAIL ${name}: ${msg}`);
    throw new Error(`${name}: ${msg}`);
  }
}

function isPng(buf: Buffer): boolean {
  return (
    buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  );
}

function pickGenSize(targetMaxSidePx: number): string {
  const candidate =
    targetMaxSidePx >= 1800 ? 2048 :
    targetMaxSidePx >= 1200 ? 1536 : 1024;
  const s = Math.min(MAX_GEN_SIDE, candidate);
  return `${s}x${s}`;
}

// ---------- normalize to PNG (pure JS via image-js only) ----------
type ImgJsLoaded = {
  width: number; height: number;
  toBuffer: (mime: 'image/png') => Uint8Array | Buffer;
};
type ImgJsCtor = typeof Image & {
  load: (data: ArrayBuffer | Uint8Array | Buffer) => Promise<ImgJsLoaded>;
};

async function ensurePng(buf: Buffer): Promise<{ png: Buffer; isActuallyPng: boolean }> {
  if (isPng(buf)) return { png: buf, isActuallyPng: true };
  try {
    const I = Image as unknown as ImgJsCtor;
    const img = await I.load(buf);
    const out = img.toBuffer('image/png');
    return { png: Buffer.isBuffer(out) ? out : Buffer.from(out), isActuallyPng: false };
  } catch {
    console.warn('[DTF] normalize_fallback_passthrough: could not decode non-PNG');
    return { png: buf, isActuallyPng: false };
  }
}

// ---------- Nebius image generation (OpenAI-compatible) ----------
type NebiusItem = { b64_json?: string; url?: string };
type NebiusList = { data?: NebiusItem[]; error?: { message?: string } };

async function generateBasePngs(
  userPrompt: string,
  count: number,
  desiredTrimW: number,
  desiredTrimH: number
): Promise<Buffer[]> {
  const host  = process.env.NEBIUS_BASE_URL || 'https://api.studio.nebius.ai';
  const key   = process.env.NEBIUS_API_KEY;
  const model = process.env.NEBIUS_IMAGE_MODEL || 'black-forest-labs/flux-dev';
  if (!key) throw new Error('NEBIUS_API_KEY is missing');

  // silently prefix the prompt
  const prompt = `Vector style. ${userPrompt}`;

  const size = pickGenSize(Math.max(desiredTrimW, desiredTrimH));
  const accum: Buffer[] = [];
  let remaining = Math.max(1, Math.floor(count));
  let attempts = 0;

  while (remaining > 0 && attempts < 6) {
    attempts++;

    const resp = await fetch(`${host}/v1/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt:
          `${prompt}\n` +
          `Transparent background. Centered subject. Full subject in frame. Extra space from edges. ` +
          `Clean edges. No watermark. No text.`,
        size,
        n: remaining,
        response_format: 'b64_json',
        image_format: 'png'
      }),
    });

    const text = await resp.text();
    if (!resp.ok) {
      let msg = text;
      try { msg = (JSON.parse(text) as NebiusList)?.error?.message || msg; } catch {}
      throw new Error(`Nebius error (${resp.status}): ${msg}`);
    }

    const json = JSON.parse(text) as NebiusList;
    const items = Array.isArray(json.data) ? json.data : [];
    if (!items.length) {
      console.warn('[DTF] base_generate: provider returned 0 items; retrying');
      await new Promise(r => setTimeout(r, 600));
      continue;
    }

    // Prefer base64 PNGs
    const b64Buffers: Buffer[] = [];
    for (const it of items) if (it.b64_json) b64Buffers.push(Buffer.from(it.b64_json, 'base64'));

    if (b64Buffers.length) {
      accum.push(...b64Buffers);
    } else {
      // Fallback to URLs; prefer server-side PNG if supported
      for (const it of items) {
        if (!it.url) continue;
        const r = await fetch(it.url, { headers: { Accept: 'image/png,image/*;q=0.8' } });
        if (!r.ok) { console.warn(`[DTF] base_generate: url fetch ${r.status}; skipping`); continue; }
        accum.push(Buffer.from(await r.arrayBuffer()));
        if (accum.length >= count) break;
      }
    }

    remaining = count - accum.length;
    if (remaining > 0) await new Promise(r => setTimeout(r, 400));
  }

  if (!accum.length) throw new Error('Nebius returned no usable image buffers');
  if (accum.length < count) console.warn(`[DTF] base_generate: got only ${accum.length}/${count} after ${attempts} attempt(s)`);
  else console.log(`[DTF] base_generate: got ${accum.length}/${count}`);

  return accum.slice(0, count);
}

// ---------- remove.bg (optional) ----------
async function removeBackground(png: Buffer): Promise<Buffer> {
  if (!REMOVE_BG_KEY) throw new Error('REMOVE_BG_API_KEY missing');
  const form = new FormData();
  const bytes = Uint8Array.from(png); // Node 22: hand File/Blob a plain ArrayBuffer
  form.append('image_file', new File([bytes], 'input.png', { type: 'image/png' }));
  form.append('size', REMOVE_BG_SIZE);
  form.append('format', 'png');
  form.append('channels', REMOVE_BG_CHANNELS);

  const resp = await fetch('https://api.remove.bg/v1.0/removebg', {
    method: 'POST',
    headers: { 'X-Api-Key': REMOVE_BG_KEY },
    body: form,
  });

  if (resp.ok) {
    const arr = await resp.arrayBuffer();
    return Buffer.from(arr);
  }
  const msg = await resp.text();
  throw new Error(`remove.bg ${resp.status}: ${msg}`);
}

// ---------- vectorizer.ai (PNG → SVG + token) ----------
type VectorizeResult = { svg: Buffer; token?: string };

async function vectorizeWithVectorizer(png: Buffer): Promise<VectorizeResult> {
  if (!VECTORIZER_ID || !VECTORIZER_SECRET) throw new Error('Vectorizer credentials missing');
  const auth = 'Basic ' + Buffer.from(`${VECTORIZER_ID}:${VECTORIZER_SECRET}`).toString('base64');

  const form = new FormData();
  const bytes = Uint8Array.from(png);
  form.append('image', new File([bytes], 'input.png', { type: 'image/png' }));
  form.append('mode', VECTORIZER_MODE);
  if (VECTORIZER_MAX_COLORS) form.append('processing.max_colors', String(VECTORIZER_MAX_COLORS));
  if (VECTORIZER_RETENTION_DAYS > 0) form.append('policy.retention_days', String(VECTORIZER_RETENTION_DAYS));

  const resp = await fetch('https://vectorizer.ai/api/v1/vectorize', {
    method: 'POST',
    headers: { Authorization: auth },
    body: form,
  });

  const token = resp.headers.get('X-Image-Token') || resp.headers.get('x-image-token') || undefined;

  if (resp.status === 200) {
    const arr = await resp.arrayBuffer();
    return { svg: Buffer.from(arr), token };
  }
  const msg = await resp.text();
  throw new Error(`Vectorizer ${resp.status}: ${msg}`);
}

// Download other formats using Image Token (best effort: try GET with query, then POST form)
async function vectorizerDownload(token: string, format: 'svg'|'png'|'pdf'|'dxf'): Promise<Buffer> {
  const auth = 'Basic ' + Buffer.from(`${VECTORIZER_ID}:${VECTORIZER_SECRET}`).toString('base64');

  // Try GET style
  const url = `https://vectorizer.ai/api/v1/download?token=${encodeURIComponent(token)}&format=${encodeURIComponent(format)}`;
  let resp = await fetch(url, { headers: { Authorization: auth } });
  if (resp.ok) return Buffer.from(await resp.arrayBuffer());

  // Fallback: POST form
  const form = new FormData();
  form.append('token', token);
  form.append('format', format);
  resp = await fetch('https://vectorizer.ai/api/v1/download', {
    method: 'POST',
    headers: { Authorization: auth },
    body: form,
  });
  if (resp.ok) return Buffer.from(await resp.arrayBuffer());

  const msg = await resp.text();
  throw new Error(`Vectorizer download ${resp.status}: ${msg}`);
}

// ---------- PNGJS helpers ----------
async function padTransparentPng(pngBuf: Buffer, marginFraction = MARGIN_FRACTION): Promise<Buffer> {
  const { PNG } = await import('pngjs');
  const src = PNG.sync.read(pngBuf);

  const base = Math.min(src.width, src.height);
  const pad = Math.max(1, Math.floor(base * Math.max(0, marginFraction)));

  const outW = src.width + 2 * pad;
  const outH = src.height + 2 * pad;
  const out = new PNG({ width: outW, height: outH }); // transparent

  for (let y = 0; y < src.height; y++) {
    const srcStart = y * src.width * 4;
    const dstStart = ((y + pad) * outW + pad) * 4;
    out.data.set(src.data.subarray(srcStart, srcStart + src.width * 4), dstStart);
  }

  return PNG.sync.write(out);
}

async function resizeContainWithPngjs(pngBuf: Buffer, targetW: number, targetH: number): Promise<Buffer> {
  const { PNG } = await import('pngjs');
  const src = PNG.sync.read(pngBuf);

  const scale = Math.min(targetW / src.width, targetH / src.height);
  const scaledW = Math.max(1, Math.round(src.width * scale));
  const scaledH = Math.max(1, Math.round(src.height * scale));

  const scaled = new PNG({ width: scaledW, height: scaledH });
  const sData = src.data, dData = scaled.data;

  // bilinear
  for (let y = 0; y < scaledH; y++) {
    const gy = (y + 0.5) / scale - 0.5;
    const y0 = Math.max(0, Math.floor(gy));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const wy1 = gy - y0, wy0 = 1 - wy1;

    for (let x = 0; x < scaledW; x++) {
      const gx = (x + 0.5) / scale - 0.5;
      const x0 = Math.max(0, Math.floor(gx));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const wx1 = gx - x0, wx0 = 1 - wx1;

      const i00 = (y0 * src.width + x0) * 4;
      const i10 = (y0 * src.width + x1) * 4;
      const i01 = (y1 * src.width + x0) * 4;
      const i11 = (y1 * src.width + x1) * 4;
      const di  = (y * scaledW + x) * 4;

      for (let c = 0; c < 4; c++) {
        const v0 = sData[i00 + c] * wx0 + sData[i10 + c] * wx1;
        const v1 = sData[i01 + c] * wx0 + sData[i11 + c] * wx1;
        dData[di + c] = Math.round(v0 * wy0 + v1 * wy1);
      }
    }
  }

  const out = new PNG({ width: targetW, height: targetH }); // transparent
  const offsetX = Math.max(0, Math.floor((targetW - scaledW) / 2));
  const offsetY = Math.max(0, Math.floor((targetH - scaledH) / 2));

  for (let y = 0; y < scaledH; y++) {
    const srcStart = y * scaledW * 4;
    const dstStart = ((y + offsetY) * targetW + offsetX) * 4;
    out.data.set(scaled.data.subarray(srcStart, srcStart + scaledW * 4), dstStart);
  }

  return PNG.sync.write(out);
}

// ---------- per-option pipeline ----------
type OptionOut = {
  proofUrl: string;
  finalUrl: string;     // print PNG from our pad+contain path
  svgUrl?: string;      // vectorizer SVG
  vectorPngUrl?: string; // optional PNG fetched via vectorizer Download (token)
};

async function processOne(
  baseBuf: Buffer,
  trimW: number,
  trimH: number,
  idx: number,
  doRemoveBg: boolean,
  doVectorize: boolean
): Promise<OptionOut> {
  // Normalize to PNG
  let { png: normalized } = await step(`normalize_${idx}`, () => ensurePng(baseBuf));

  // 1) remove.bg first (user requested)
  if (doRemoveBg) {
    try {
      normalized = await step(`removebg_${idx}`, () => removeBackground(normalized));
    } catch (e) {
      console.warn(`[DTF] remove.bg failed for opt ${idx}:`, e instanceof Error ? e.message : e);
    }
  }

  // 2) vectorizer next (multi-format via token)
  let svgUrl: string | undefined;
  let vectorPngUrl: string | undefined;
  if (doVectorize) {
    try {
      const { svg, token } = await step(`vectorize_${idx}`, () => vectorizeWithVectorizer(normalized));
      const idv = crypto.randomUUID();
      const svgBlob = await put(`dtf/${idv}-opt${idx}.svg`, svg, { access: 'public', contentType: 'image/svg+xml' });
      svgUrl = svgBlob.url;

      if (token) {
        // Try fetching another format (PNG) via the download endpoint
        try {
          const vpng = await step(`vectorize_download_${idx}`, () => vectorizerDownload(token, 'png'));
          const pngBlob = await put(`dtf/${idv}-opt${idx}-vector.png`, vpng, {
            access: 'public',
            contentType: 'image/png',
          });
          vectorPngUrl = pngBlob.url;
        } catch (e) {
          console.warn(`[DTF] vectorizer download PNG failed opt ${idx}:`, e instanceof Error ? e.message : e);
        }
      }
    } catch (e) {
      console.warn(`[DTF] vectorizer failed for opt ${idx}:`, e instanceof Error ? e.message : e);
    }
  }

  // 3) Our print PNG path (pad + contain)
  const padded  = await step(`pad_margin_${idx}`,  () => padTransparentPng(normalized, MARGIN_FRACTION));
  const resized = await step(`resize_trim_${idx}`, () => resizeContainWithPngjs(padded, trimW, trimH));

  const id = crypto.randomUUID();
  const printBlob = await put(`dtf/${id}-opt${idx}.png`, resized, { access: 'public', contentType: 'image/png' });

  return { proofUrl: printBlob.url, finalUrl: printBlob.url, svgUrl, vectorPngUrl };
}

// ---------- core ----------
async function generateDTF(prompt: string, widthIn: number, heightIn: number, removeBg: boolean, vectorize: boolean) {
  const dpi = 300;
  const trimW = px(widthIn, dpi);
  const trimH = px(heightIn, dpi);

  const bases  = await step('base_generate', () => generateBasePngs(prompt, VARIATIONS, trimW, trimH));
  const options = await Promise.all(
    bases.map((buf, i) =>
      processOne(
        buf, trimW, trimH, i + 1,
        removeBg && !!REMOVE_BG_KEY,
        vectorize && !!VECTORIZER_ID && !!VECTORIZER_SECRET
      )
    )
  );
  return { options };
}

// ---------- handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }

  try {
    const { prompt, widthIn, heightIn, removeBg, vectorize } = (req.body ?? {}) as {
      prompt?: string; widthIn?: number; heightIn?: number; removeBg?: boolean; vectorize?: boolean;
    };

    const cleanPrompt = (prompt ?? '').trim();
    const wIn = Number(widthIn), hIn = Number(heightIn);
    if (!cleanPrompt || !wIn || !hIn) {
      res.status(400).json({ error: 'prompt, widthIn, heightIn are required' });
      return;
    }

    const out = await generateDTF(cleanPrompt, wIn, hIn, !!removeBg, !!vectorize);
    res.status(200).json(out);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to generate';
    console.error('[DTF API ERROR]', err);
    res.status(500).json({ error: message });
  }
}
