import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import sharp from 'sharp';
import crypto from 'node:crypto';
import { put } from '@vercel/blob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// inches → pixels at 300 DPI
const px = (inches: number, dpi = 300) => Math.round(inches * dpi);

export async function POST(req: Request) {
  try {
    // Basic env checks so we fail with JSON, not an exception
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: 'OPENAI_API_KEY is missing' }, { status: 500 });
    }

    const token = process.env.BLOB_READ_WRITE_TOKEN; // set in Vercel → Env Vars
    if (!token) {
      // Not fatal in Vercel prod (it can work without), but helps local/dev
      // We’ll still try to write; if it throws, we catch and return JSON.
      console.warn('BLOB_READ_WRITE_TOKEN not set'); // shows in Vercel logs
    }

    // Parse body defensively
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { prompt, widthIn, heightIn } = (body ?? {}) as {
      prompt?: string;
      widthIn?: number;
      heightIn?: number;
    };

    const cleanPrompt = (prompt ?? '').trim();
    const wIn = Number(widthIn);
    const hIn = Number(heightIn);
    if (!cleanPrompt || !wIn || !hIn) {
      return NextResponse.json({ error: 'prompt, widthIn, heightIn are required' }, { status: 400 });
    }

    const dpi = 300;
    const bleedIn = 0.125; // 1/8"
    const trimW = px(wIn, dpi);
    const trimH = px(hIn, dpi);
    const finalW = px(wIn + 2 * bleedIn, dpi);
    const finalH = px(hIn + 2 * bleedIn, dpi);

    // 1) Generate a base transparent PNG
    const gen = await openai.images.generate({
      model: 'gpt-image-1',
      prompt: `${cleanPrompt}\nStyle: clean edges, no watermark, no text.\nBackground: transparent.`,
      size: '1024x1024',
      background: 'transparent',
    });

    const first = Array.isArray(gen.data) ? gen.data[0] : undefined;
    if (!first) {
      return NextResponse.json({ error: 'Image generation returned no data' }, { status: 502 });
    }

    let basePng: Buffer;
    if (first.b64_json) {
      basePng = Buffer.from(first.b64_json, 'base64');
    } else if (first.url) {
      const resp = await fetch(first.url);
      if (!resp.ok) {
        return NextResponse.json({ error: `Failed to fetch image URL (HTTP ${resp.status})` }, { status: 502 });
      }
      const arr = await resp.arrayBuffer();
      basePng = Buffer.from(arr);
    } else {
      return NextResponse.json({ error: 'Image generation had neither b64_json nor url' }, { status: 502 });
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

    // 4) Upload to Vercel Blob (explicit token if present)
    const id = crypto.randomUUID();
    const baseOpts = { access: 'public' as const, contentType: 'image/png' };
    const putOpts = token ? { ...baseOpts, token } : baseOpts;

    const finalBlob = await put(`dtf/${id}-final.png`, finalPng, putOpts);
    const proofBlob = await put(`dtf/${id}-proof.png`, proofPng, putOpts);

    return NextResponse.json({ finalUrl: finalBlob.url, proofUrl: proofBlob.url });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to generate';
    console.error('[DTF API ERROR]', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
