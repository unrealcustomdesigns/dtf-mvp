import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import sharp from 'sharp';
import crypto from 'node:crypto';
import { put } from '@vercel/blob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// CORS helper (lets you embed from Shopify too)
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ?? '*';
const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOW_ORIGIN,
  'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// inches → pixels @300 DPI
const px = (inches: number, dpi = 300) => Math.round(inches * dpi);

async function generateDTF({
  prompt, widthIn, heightIn,
}: { prompt: string; widthIn: number; heightIn: number }) {
  const dpi = 300;
  const bleedIn = 0.125;

  const trimW = px(widthIn, dpi);
  const trimH = px(heightIn, dpi);
  const finalW = px(widthIn + 2 * bleedIn, dpi);
  const finalH = px(heightIn + 2 * bleedIn, dpi);

  const gen = await openai.images.generate({
    model: 'gpt-image-1',
    prompt: `${prompt}\nStyle: clean edges, no watermark, no text.\nBackground: transparent.`,
    size: '1024x1024',
    background: 'transparent',
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

  // Vercel Blob
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const baseOpts = { access: 'public' as const, contentType: 'image/png' };
  const putOpts = token ? { ...baseOpts, token } : baseOpts;

  const id = crypto.randomUUID();
  const finalBlob = await put(`dtf/${id}-final.png`, finalPng, putOpts);
  const proofBlob = await put(`dtf/${id}-proof.png`, proofPng, putOpts);

  return { finalUrl: finalBlob.url, proofUrl: proofBlob.url };
}

/** Handle POST (normal flow) */
export async function POST(req: Request) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: 'OPENAI_API_KEY is missing' }, { status: 500, headers: corsHeaders });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: corsHeaders });
    }
    const { prompt, widthIn, heightIn } = (body ?? {}) as { prompt?: string; widthIn?: number; heightIn?: number };
    const cleanPrompt = (prompt ?? '').trim();
    const wIn = Number(widthIn);
    const hIn = Number(heightIn);

    if (!cleanPrompt || !wIn || !hIn) {
      return NextResponse.json({ error: 'prompt, widthIn, heightIn are required' }, { status: 400, headers: corsHeaders });
    }

    const out = await generateDTF({ prompt: cleanPrompt, widthIn: wIn, heightIn: hIn });
    return NextResponse.json(out, { headers: corsHeaders });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to generate';
    console.error('[DTF API ERROR]', err);
    return NextResponse.json({ error: message }, { status: 500, headers: corsHeaders });
  }
}

/** Handle OPTIONS (preflight) */
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

/** GET fallback so a stray GET won't 405; visit /api/dtf/generate?prompt=...&widthIn=10&heightIn=10 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const prompt = (url.searchParams.get('prompt') || '').trim();
  const wIn = Number(url.searchParams.get('widthIn'));
  const hIn = Number(url.searchParams.get('heightIn'));

  if (prompt && wIn && hIn) {
    try {
      const out = await generateDTF({ prompt, widthIn: wIn, heightIn: hIn });
      return NextResponse.json(out, { headers: corsHeaders });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to generate';
      return NextResponse.json({ error: message }, { status: 500, headers: corsHeaders });
    }
  }

  return NextResponse.json(
    { ok: true, message: 'Use POST with JSON body { prompt, widthIn, heightIn } or pass them as query params.' },
    { headers: corsHeaders }
  );
}
