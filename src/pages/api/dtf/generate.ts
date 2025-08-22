import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'node:crypto';
import { put } from '@vercel/blob';

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ?? '*';
const VARIATIONS = 3;
const MARGIN_FRACTION = 0.12; // 12% transparent margin around model output

// ---------- helpers ----------
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

function isPng(buf: Buffer): boolean {
  return (
    buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  );
}

// Normalize any input (jpeg/webp/…) to PNG Buffer — pure JS (image-js)
async function ensurePng(buf: Buffer): Promise<Buffer> {
  if (isPng(buf)) return buf;

  // robust dynamic import (ESM/CJS safe)
  const mod = await import('image-js');
  const ImageCls =
    (mod as any).Image ??
    ((mod as any).default && (mod as any).default.Image ? (mod as any).default.Image : undefined);

  if (!ImageCls || typeof ImageCls.load !== 'function') {
    throw new Error('image-js import failed: no Image.load');
  }

  const img = await ImageCls.load(buf); // decodes JPEG/WebP/etc.
  const out = img.toBuffer({ format: 'png' }); // returns Uint8Array
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

// ---------- image generation (Nebius: flux-dev) ----------
async function generateBasePngs(prompt: string, count: number): Promise<Buffer[]> {
  const host  = process.env.NEBIUS_BASE_URL || 'https://api.studio.nebius.ai';
  const key   = process.env.NEBIUS_API_KEY;
  const model = process.env.NEBIUS_IMAGE_MODEL || 'black-forest-labs/flux-dev';
  if (!key) throw new Error('NEBIUS_API_KEY is missing');

  const resp = await fetch(`${host}/v1/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt:
        `${prompt}\n` +
        `Transparent background. Centered subject. Full subject in frame. Extra space from edges. ` +
        `Clean edges. No watermark. No text.`,
      size: '1024x1024',
      n: count,
    }),
  });

  const text = await resp.text();
  if (!resp.ok) {
    let msg = text;
    try { msg = (JSON.parse(text)?.error?.message) || msg; } catch {}
    throw new Error(`Nebius error (${resp.status}): ${msg}`);
  }

  const data = JSON.parse(text);
  const items = Array.isArray(data?.data) ? data.data : [];
  if (!items.length) throw new Error('Nebius response missing data array');

  const out: Buffer[] = [];
  for (const item of items) {
    if (item?.b64_json) {
      out.push(Buffer.from(item.b64_json, 'base64'));
    } else if (item?.url) {
      const r = await fetch(item.url);
      if (!r.ok) throw new Error(`Nebius URL fetch ${r.status}`);
      out.push(Buffer.from(await r.arrayBuffer()));
    }
  }
  if (!out.length) throw new Error('Nebius returned no usable image buffers');
  return out;
}

// ---------- PNGJS utilities ----------
async function padTransparentPng(pngBuf: Buffer, marginFraction = MARGIN_FRACTION): Promise<Buffer> {
  const { PNG } = await import('pngjs');
  const src = PNG.sync.read(pngBuf); // { width, height, data: Uint8Array }

  const base = Math.min(src.width, src.height);
  const pad = Math.max(1, Math.floor(base * Math.max(0, marginFraction)));

  const outW = src.width + 2 * pad;
  const outH = src.height + 2 * pad;
  const out = new PNG({ width: outW, height: outH }); // zeroed => fully transparent

  for (let y = 0; y < src.height; y++) {
    const srcStart = y * src.width * 4;
    const dstStart = ((y + pad) * outW + pad) * 4;
    out.data.set(src.data.subarray(srcStart, srcStart + src.width * 4), dstStart);
  }

  return PNG.sync.write(out);
}

// “contain” (no crop): bilinear scale + center on transparent canvas
async function resizeContainWithPngjs(pngBuf: Buffer, targetW: number, targetH: number): Promise<Buffer> {
  const { PNG } = await import('pngjs');
  const src = PNG.sync.read(pngBuf); // { width, height, data: Uint8Array }

  const scale = Math.min(targetW / src.width, targetH / src.height);
  const scaledW = Math.max(1, Math.round(src.width * scale));
  const scaledH = Math.max(1, Math.round(src.height * scale));

  const scaled = new PNG({ width: scaledW, height: scaledH });
  const sData = src.data, dData = scaled.data;

  // bilinear scale
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

  // center on transparent target canvas
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

// process one candidate end-to-end
async function processOne(baseBuf: Buffer, trimW: number, trimH: number, idx: number): Promise<Buffer> {
  const normalized = await step(`normalize_${idx}`, () => ensurePng(baseBuf)); // <— NEW
  const padded     = await step(`pad_margin_${idx}`, () => padTransparentPng(normalized, MARGIN_FRACTION));
  const resized    = await step(`resize_trim_${idx}`,  () => resizeContainWithPngjs(padded, trimW, trimH));
  if (!Buffer.isBuffer(resized) || resized.length === 0) throw new Error(`resized_empty_${idx}`);
  return resized; // final PNG buffer (no DPI stamping)
}

// ---------- core ----------
async function generateDTF(prompt: string, widthIn: number, heightIn: number) {
  const dpi = 300; // informational only
  const trimW = px(widthIn, dpi);
  const trimH = px(heightIn, dpi);

  const bases  = await step('base_generate', () => generateBasePngs(prompt, VARIATIONS));
  const finals = await Promise.all(bases.map((buf, i) => processOne(buf, trimW, trimH, i + 1)));

  // Upload each to Blob
  const token = process.env.BLOB_READ_WRITE_TOKEN; // optional
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

// ---------- handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  // CORS
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
    const wIn = Number(widthIn);
    const hIn = Number(heightIn);

    if (!cleanPrompt || !wIn || !hIn) { res.status(400).json({ error: 'prompt, widthIn, heightIn are required' }); return; }

    const out = await generateDTF(cleanPrompt, wIn, hIn);
    res.status(200).json(out);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to generate';
    console.error('[DTF API ERROR]', err);
    res.status(500).json({ error: message });
  }
}
