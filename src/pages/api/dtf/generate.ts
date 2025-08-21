import type { NextApiRequest, NextApiResponse } from 'next';
import sharp from 'sharp';
import crypto from 'node:crypto';
import { put } from '@vercel/blob';

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ?? '*';

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

async function generateBasePngViaREST(prompt: string): Promise<Buffer> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is missing');

  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt: `${prompt}\nTransparent background. Clean edges. No watermark. No text.`,
      size: '1024x1024',
      n: 1
    })
  });

  const text = await resp.text();
  if (!resp.ok) {
    let msg = text;
    try { msg = (JSON.parse(text)?.error?.message) || msg; } catch {}
    throw new Error(`OpenAI error (${resp.status}): ${msg}`);
  }

  const data = JSON.parse(text);
  const item = data?.data?.[0];
  if (!item) throw new Error('OpenAI response missing data[0]');

  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');

  if (item.url) {
    const r = await fetch(item.url);
    if (!r.ok) throw new Error(`Failed to fetch image URL (HTTP ${r.status})`);
    const arr = await r.arrayBuffer();
    return Buffer.from(arr);
  }

  throw new Error('OpenAI image had neither b64_json nor url');
}

// ---------- PNGJS fallback (pure JS) ----------
async function resizeCoverWithPngjs(pngBuf: Buffer, targetW: number, targetH: number): Promise<Buffer> {
  const { PNG } = await import('pngjs');
  const src = PNG.sync.read(pngBuf);

  const scale = Math.max(targetW / src.width, targetH / src.height);
  const scaledW = Math.max(1, Math.round(src.width * scale));
  const scaledH = Math.max(1, Math.round(src.height * scale));

  const scaled = new PNG({ width: scaledW, height: scaledH });
  const sData = src.data, dData = scaled.data;

  // nearest-neighbor
  for (let y = 0; y < scaledH; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y / scale));
    for (let x = 0; x < scaledW; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x / scale));
      const si = (sy * src.width + sx) * 4;
      const di = (y * scaledW + x) * 4;
      dData[di]     = sData[si];
      dData[di + 1] = sData[si + 1];
      dData[di + 2] = sData[si + 2];
      dData[di + 3] = sData[si + 3];
    }
  }

  // center-crop
  const cropX = Math.max(0, Math.floor((scaledW - targetW) / 2));
  const cropY = Math.max(0, Math.floor((scaledH - targetH) / 2));
  const cropped = new PNG({ width: targetW, height: targetH });

  for (let y = 0; y < targetH; y++) {
    const srcRowStart = ((y + cropY) * scaledW + cropX) * 4;
    const dstRowStart = y * targetW * 4;
    scaled.data.copy(cropped.data, dstRowStart, srcRowStart, srcRowStart + targetW * 4);
  }

  return PNG.sync.write(cropped);
}

// ---------- core (NO BLEED) ----------
async function generateDTF(prompt: string, widthIn: number, heightIn: number) {
  const dpi = 300;

  const trimW = px(widthIn, dpi);
  const trimH = px(heightIn, dpi);

  // 1) Base PNG
  const basePng = await step('openai_generate', () => generateBasePngViaREST(prompt));

  // 2) Resize to exact trim (Sharp → PNGJS fallback)
  const resizedTrim = await step('resize_trim', async () => {
    if (!Number.isFinite(trimW) || !Number.isFinite(trimH) || trimW <= 0 || trimH <= 0) {
      throw new Error(`invalid_trim_dims: trimW=${trimW}, trimH=${trimH}`);
    }
    try {
      const normalized = await sharp(basePng).ensureAlpha().toFormat('png').toBuffer();
      return await sharp(normalized).resize(trimW, trimH).toBuffer();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[DTF] sharp resize failed, using PNGJS:', msg);
      return await resizeCoverWithPngjs(basePng, trimW, trimH);
    }
  });

// 3) Finalize (no DPI stamping to avoid Sharp quirk)
const finalPng = await step('finalize', async () => {
  // resizedTrim is already an exact-trim PNG Buffer
  if (!Buffer.isBuffer(resizedTrim) || resizedTrim.length === 0) {
    throw new Error('resizedTrim_not_buffer');
  }
  return resizedTrim;
});

  // 4) Proof = Final (no bleed/safe lines)
  const proofPng = await step('proof_passthrough', async () => finalPng);

  // 5) Upload to Blob
  const token = process.env.BLOB_READ_WRITE_TOKEN; // optional
  const baseOpts = { access: 'public' as const, contentType: 'image/png' };
  const putOpts: Parameters<typeof put>[2] = token ? { ...baseOpts, token } : baseOpts;

  const id = crypto.randomUUID();
  const [finalBlob, proofBlob] = await step('blob_put', () =>
    Promise.all([
      put(`dtf/${id}-final.png`, finalPng, putOpts),
      put(`dtf/${id}-proof.png`, proofPng, putOpts)
    ])
  );

  return { finalUrl: finalBlob.url, proofUrl: proofBlob.url };
}

// ---------- handler ----------
export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  // CORS (Shopify-friendly)
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

    if (!process.env.OPENAI_API_KEY) { res.status(500).json({ error: 'OPENAI_API_KEY is missing' }); return; }
    if (!cleanPrompt || !wIn || !hIn) { res.status(400).json({ error: 'prompt, widthIn, heightIn are required' }); return; }

    const out = await generateDTF(cleanPrompt, wIn, hIn);
    res.status(200).json(out);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to generate';
    console.error('[DTF API ERROR]', err);
    res.status(500).json({ error: message });
  }
}
