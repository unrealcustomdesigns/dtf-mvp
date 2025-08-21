import type { NextApiRequest, NextApiResponse } from 'next';
import OpenAI from 'openai';
import sharp from 'sharp';
import crypto from 'node:crypto';
import { put } from '@vercel/blob';

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ?? '*';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// inches → pixels at 300 DPI
const px = (inches: number, dpi = 300) => Math.round(inches * dpi);

async function generateDTF(prompt: string, widthIn: number, heightIn: number) {
  const dpi = 300;
  const bleedIn = 0.125;

  const trimW = px(widthIn, dpi);
  const trimH = px(heightIn, dpi);
  const finalW = px(widthIn + 2 * bleedIn, dpi);
  const finalH = px(heightIn + 2 * bleedIn, dpi);

  // 1) Base image (omit background option; put "transparent background" in prompt)
  const gen = await openai.images.generate({
    model: 'gpt-image-1',
    prompt:
      `${prompt}\n` +
      `Style: clean edges, no watermark, no text.\n` +
      `Transparent background.`,
    size: '1024x1024'
  });

  const first = Array.isArray(gen.data) ? gen.data[0] : undefined;
  if (!first) throw new Error('Image generation returned no data');

  let basePng: Buffer;
  if (first.b64_json) {
    basePng = Buffer.from(first.b64_json, 'base64');
  } else if (first.url) {
    const resp = await fetch(first.url);
    if (!resp.ok) throw new Error(`Failed to fetch image URL (HTTP ${resp.status})`);
    basePng = Buffer.from(await resp.arrayBuffer());
  } else {
    throw new Error('Image generation had neither b64_json nor url');
  }

  // 2) Resize to trim, add bleed, set 300 DPI
  const resizedTrim = await sharp(basePng)
    .resize({ width: trimW, height: trimH, fit: 'cover' })
    .png()
    .toBuffer();

  const finalPng = await sharp({
    create: { width: finalW, height: finalH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: resizedTrim, left: Math.round((finalW - trimW) / 2), top: Math.round((finalH - trimH) / 2) }])
    .png({ compressionLevel: 9 })
    .withMetadata({ density: dpi })
    .toBuffer();

  // 3) Proof overlay (trim=red, safe=green)
  const bleedPx = px(bleedIn, dpi);
  const safeInset = bleedPx + px(0.125, dpi);
  const line = (w: number, h: number, r: number, g: number, b: number, a = 0.7) =>
    sharp({ create: { width: w, height: h, channels: 4, background: { r, g, b, alpha: a } } }).png().toBuffer();

  const proofPng = await sharp(finalPng)
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

  // 4) Upload to Vercel Blob
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const baseOpts = { access: 'public' as const, contentType: 'image/png' };
  const putOpts = token ? { ...baseOpts, token } : baseOpts;

  const id = crypto.randomUUID();
  const finalBlob = await put(`dtf/${id}-final.png`, finalPng, putOpts);
  const proofBlob = await put(`dtf/${id}-proof.png`, proofPng, putOpts);

  return { finalUrl: finalBlob.url, proofUrl: proofBlob.url };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  // CORS (Shopify-friendly)
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }

  try {
    if (!process.env.OPENAI_API_KEY) { res.status(500).json({ error: 'OPENAI_API_KEY is missing' }); return; }

    const { prompt, widthIn, heightIn } = (req.body ?? {}) as {
      prompt?: string; widthIn?: number; heightIn?: number;
    };

    const cleanPrompt = (prompt ?? '').trim();
    const wIn = Number(widthIn);
    const hIn = Number(heightIn);
    if (!cleanPrompt || !wIn || !hIn) { res.status(400).json({ error: 'prompt, widthIn, heightIn are required' }); return; }

    const out = await generateDTF(cleanPrompt, wIn, hIn);
    res.status(200).json(out); return;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to generate';
    console.error('[DTF API ERROR]', err);
    res.status(500).json({ error: message }); return;
  }
}
