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
      n: 1,
    }),
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

// ---------- image-js types & guards (no any) ----------
type ImageJsImage = {
  width: number;
  height: number;
  resize(opts: { width?: number; height?: number }): ImageJsImage;
  crop(opts: { x: number; y: number; width: number; height: number }): ImageJsImage;
  toBuffer(opts: { format: 'png' }): Uint8Array | Buffer;
};
type ImageJsLoader = { load: (data: ArrayBuffer | Uint8Array | Buffer) => Promise<ImageJsImage> };
type ImageJsModuleShape =
  | { Image: ImageJsLoader }
  | { default: ImageJsLoader }
  | { default: { Image: ImageJsLoader } }
  | { default?: unknown; Image?: unknown };

function hasLoad(x: unknown): x is ImageJsLoader {
  return typeof x === 'object' && x !== null && 'load' in x && typeof (x as { load: unknown }).load === 'function';
}
function hasImageLoader(x: unknown): x is { Image: ImageJsLoader } {
  return typeof x === 'object' && x !== null && 'Image' in x && hasLoad((x as { Image: unknown }).Image);
}

// ---------- core ----------
async function generateDTF(prompt: string, widthIn: number, heightIn: number) {
  const dpi = 300;
  const bleedIn = 0.125;

  const trimW = px(widthIn, dpi);
  const trimH = px(heightIn, dpi);
  const finalW = px(widthIn + 2 * bleedIn, dpi);
  const finalH = px(heightIn + 2 * bleedIn, dpi);

  // 1) Generate base PNG from OpenAI
  const basePng = await step('openai_generate', () => generateBasePngViaREST(prompt));

  // 2) Normalize + resize; fall back to image-js if Sharp errors
  const resizedTrim = await step('sharp_resize', async () => {
    if (!Number.isFinite(trimW) || !Number.isFinite(trimH) || trimW <= 0 || trimH <= 0) {
      throw new Error(`invalid_dimensions: trimW=${trimW}, trimH=${trimH}`);
    }

    try {
      // Normalize model output to plain RGBA PNG first
      const normalized = await sharp(basePng).ensureAlpha().toFormat('png').toBuffer();
      // Strict two-arg resize (no options object)
      return await sharp(normalized).resize(trimW, trimH).toBuffer();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[DTF] sharp resize failed, falling back to image-js:', msg);

      // Pure-JS fallback (no native bindings)
      const modUnknown = (await import('image-js')) as unknown as ImageJsModuleShape;

      let ImageCls: ImageJsLoader | undefined;
      if (hasImageLoader(modUnknown)) {
        ImageCls = modUnknown.Image;
      } else if ('default' in modUnknown && modUnknown.default) {
        const def = (modUnknown as { default: unknown }).default;
        if (hasLoad(def)) ImageCls = def;
        else if (hasImageLoader(def)) ImageCls = (def as { Image: ImageJsLoader }).Image;
      }

      if (!ImageCls) throw new Error('image-js export shape not recognized (no Image.load)');

      const img = await ImageCls.load(basePng);

      // Cover scale (like Sharp fit:'cover'): fill both dims, then crop center
      const scale = Math.max(trimW / img.width, trimH / img.height);
      const newW = Math.max(1, Math.round(img.width * scale));
      const newH = Math.max(1, Math.round(img.height * scale));

      const resized = img.resize({ width: newW, height: newH });
      const x = Math.max(0, Math.floor((newW - trimW) / 2));
      const y = Math.max(0, Math.floor((newH - trimH) / 2));
      const cropped = resized.crop({ x, y, width: trimW, height: trimH });

      const out = cropped.toBuffer({ format: 'png' });
      return Buffer.isBuffer(out) ? out : Buffer.from(out);
    }
  });

  // 3) Add bleed + set 300 DPI (final PNG)
  const finalPng = await step('sharp_bleed', () =>
    sharp({
      create: { width: finalW, height: finalH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: resizedTrim, left: Math.round((finalW - trimW) / 2), top: Math.round((finalH - trimH) / 2) }])
      .png({ compressionLevel: 9 })
      .withMetadata({ density: dpi })
      .toBuffer()
  );

  // 4) Proof overlay (trim=red, safe=green)
  const proofPng = await step('sharp_proof', async () => {
    const bleedPx = px(bleedIn, dpi);
    const safeInset = bleedPx + px(0.125, dpi);

    const line = (w: number, h: number, r: number, g: number, b: number, a = 0.7) =>
      sharp({ create: { width: w, height: h, channels: 4, background: { r, g, b, alpha: a } } })
        .png()
        .toBuffer();

    return await sharp(finalPng)
      .composite([
        // Trim (red)
        { input: await line(finalW, 2, 255, 0, 0), left: 0, top: bleedPx },
        { input: await line(finalW, 2, 255, 0, 0), left: 0, top: finalH - bleedPx - 2 },
        { input: await line(2, finalH, 255, 0, 0), left: bleedPx, top: 0 },
        { input: await line(2, finalH, 255, 0, 0), left: finalW - bleedPx - 2, top: 0 },
        // Safe (green)
        { input: await line(finalW - safeInset * 2, 2, 0, 255, 0), left: safeInset, top: safeInset },
        { input: await line(finalW - safeInset * 2, 2, 0, 255, 0), left: safeInset, top: finalH - safeInset - 2 },
        { input: await line(2, finalH - safeInset * 2, 0, 255, 0), left: safeInset, top: safeInset },
        { input: await line(2, finalH - safeInset * 2, 0, 255, 0), left: finalW - safeInset - 2, top: safeInset },
      ])
      .png({ compressionLevel: 9 })
      .withMetadata({ density: dpi })
      .toBuffer();
  });

  // 5) Upload to Vercel Blob (public)
  const token = process.env.BLOB_READ_WRITE_TOKEN; // optional
  const baseOpts = { access: 'public' as const, contentType: 'image/png' };
  const putOpts: Parameters<typeof put>[2] = token ? { ...baseOpts, token } : baseOpts;

  const id = crypto.randomUUID();
  const [finalBlob, proofBlob] = await step('blob_put', () =>
    Promise.all([
      put(`dtf/${id}-final.png`, finalPng, putOpts),
      put(`dtf/${id}-proof.png`, proofPng, putOpts),
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
