import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'node:crypto';
import { put } from '@vercel/blob';
import { Image } from 'image-js';

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ?? '*';
const VARIATIONS = Number(process.env.VARIATIONS || 3);
const MARGIN_FRACTION = Number(process.env.MARGIN_FRACTION || 0.12);
const MAX_GEN_SIDE = Number(process.env.NEBIUS_MAX_SIZE || 2048);

const px = (inches: number, dpi = 300) => Math.round(inches * dpi);

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try { const r = await fn(); console.log(`[DTF] STEP_OK ${name}`); return r; }
  catch (e) { const m = e instanceof Error ? e.message : String(e); console.error(`[DTF] STEP_FAIL ${name}: ${m}`); throw new Error(`${name}: ${m}`); }
}

function isPng(buf: Buffer) {
  return buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
}

function pickGenSize(targetMaxSidePx: number): string {
  const candidate = targetMaxSidePx >= 1800 ? 2048 : targetMaxSidePx >= 1200 ? 1536 : 1024;
  const s = Math.min(MAX_GEN_SIDE, candidate);
  return `${s}x${s}`;
}

// --- pure-JS normalize with image-js only ---
type ImgJsLoaded = { width: number; height: number; toBuffer: (mime: 'image/png') => Uint8Array | Buffer; };
type ImgJsCtor = typeof Image & { load: (data: ArrayBuffer | Uint8Array | Buffer) => Promise<ImgJsLoaded> };

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

// --- Nebius (OpenAI-compatible) ---
type NebiusItem = { b64_json?: string; url?: string };
type NebiusList = { data?: NebiusItem[]; error?: { message?: string } };

async function generateBasePngs(prompt: string, count: number, desiredTrimW: number, desiredTrimH: number): Promise<Buffer[]> {
  const host  = process.env.NEBIUS_BASE_URL || 'https://api.studio.nebius.ai';
  const key   = process.env.NEBIUS_API_KEY;
  const model = process.env.NEBIUS_IMAGE_MODEL || 'black-forest-labs/flux-dev';
  if (!key) throw new Error('NEBIUS_API_KEY is missing');

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
      let msg = text; try { msg = (JSON.parse(text) as NebiusList)?.error?.message || msg; } catch {}
      throw new Error(`Nebius error (${resp.status}): ${msg}`);
    }

    const json = JSON.parse(text) as NebiusList;
    const items = Array.isArray(json.data) ? json.data : [];
    if (!items.length) { console.warn('[DTF] base_generate: provider returned 0 items; retrying'); await new Promise(r => setTimeout(r, 600)); continue; }

    // Prefer base64 PNGs
    const b64Buffers: Buffer[] = [];
    for (const it of items) if (it.b64_json) b64Buffers.push(Buffer.from(it.b64_json, 'base64'));

    if (b64Buffers.length) {
      accum.push(...b64Buffers);
    } else {
      // Fallback: fetch URL, prefer PNG if server supports it
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

// --- PNGJS helpers ---
async function padTransparentPng(pngBuf: Buffer, marginFraction = MARGIN_FRACTION): Promise<Buffer> {
  const { PNG } = await import('pngjs');
  const src = PNG.sync.read(pngBuf);
  const base = Math.min(src.width, src.height);
  const pad = Math.max(1, Math.floor(base * Math.max(0, marginFraction)));
  const outW = src.width + 2 * pad, outH = src.height + 2 * pad;
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

// --- pipeline for one candidate ---
async function processOne(baseBuf: Buffer, trimW: number, trimH: number, idx: number): Promise<Buffer> {
  const { png: normalized } = await step(`normalize_${idx}`, () => ensurePng(baseBuf));

  if (!isPng(normalized)) {
    console.warn(`[DTF] normalize_fallback_passthrough_${idx}: non-PNG kept as-is`);
    return normalized;
  }

  const padded  = await step(`pad_margin_${idx}`,  () => padTransparentPng(normalized, MARGIN_FRACTION));
  const resized = await step(`resize_trim_${idx}`, () => resizeContainWithPngjs(padded, trimW, trimH));
  if (!Buffer.isBuffer(resized) || resized.length === 0) throw new Error(`resized_empty_${idx}`);
  return resized;
}

// --- core ---
async function generateDTF(prompt: string, widthIn: number, heightIn: number) {
  const dpi = 300;
  const trimW = px(widthIn, dpi);
  const trimH = px(heightIn, dpi);

  const bases  = await step('base_generate', () => generateBasePngs(prompt, VARIATIONS, trimW, trimH));
  const finals = await Promise.all(bases.map((buf, i) => processOne(buf, trimW, trimH, i + 1)));

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const baseOpts = { access: 'public' as const, contentType: 'image/png' };
  const putOpts: Parameters<typeof put>[2] = token ? { ...baseOpts, token } : baseOpts;

  const uploaded = await step('blob_put', async () => {
    const id = crypto.randomUUID();
    const uploads = await Promise.all(
      finals.map((buffer, i) => put(`dtf/${id}-opt${i + 1}.png`, buffer, putOpts))
    );
    return uploads.map(u => ({ proofUrl: u.url, finalUrl: u.url }));
  });

  return { options: uploaded };
}

// --- handler ---
export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }

  try {
    const { prompt, widthIn, heightIn } = (req.body ?? {}) as {
      prompt?: string; widthIn?: number; heightIn?: number;
    };

    const cleanPrompt = (prompt ?? '').trim();
    const wIn = Number(widthIn), hIn = Number(heightIn);
    if (!cleanPrompt || !wIn || !hIn) { res.status(400).json({ error: 'prompt, widthIn, heightIn are required' }); return; }

    const out = await generateDTF(cleanPrompt, wIn, hIn);
    res.status(200).json(out);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to generate';
    console.error('[DTF API ERROR]', err);
    res.status(500).json({ error: message });
  }
}
