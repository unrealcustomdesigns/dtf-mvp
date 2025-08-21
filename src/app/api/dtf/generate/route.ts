import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import sharp from 'sharp';
import crypto from 'node:crypto';
import { put } from '@vercel/blob';

export const runtime = 'nodejs';        // sharp needs Node runtime
export const dynamic = 'force-dynamic'; // avoid caching during dev

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// inches → pixels at 300 DPI
const px = (inches: number, dpi = 300) => Math.round(inches * dpi);

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { prompt?: string; widthIn?: number; heightIn?: number };
    const prompt = body?.prompt?.trim();
    const widthIn = Number(body?.widthIn);
    const heightIn = Number(body?.heightIn);

    if (!prompt || !widthIn || !heightIn) {
      return NextResponse.json({ error: 'prompt, widthIn, heightIn are required' }, { status: 400 });
    }

    const dpi = 300;
    const bleedIn = 0.125; // 1/8"
    const trimW = px(widthIn, dpi);
    const trimH = px(heightIn, dpi);
    const finalW = px(widthIn + 2 * bleedIn, dpi);
    const finalH = px(heightIn + 2 * bleedIn, dpi);

    // 1) Generate a base transparent PNG (model may return b64 or url)
    const gen = await openai.images.generate({
      model: 'gpt-image-1',
      prompt: `${prompt}\nStyle: clean edges, no watermark, no text.\nBackground: transparent.`,
      size: '1024x1024',
      background: 'transparent',
    });

    // ✅ Type-safe narrowing so TS knows data[0] exists
    const first = Array.isArray(gen.data) ? gen.data[0] : undefined;
    if (!first) {
      return NextResponse.json({ error: 'Image generation returned no data' }, { status: 502 });
    }

    let basePng: Buffer;
    if (first.b64_json) {
      basePng = Buffer.from(first.b64_json, 'base64');
    } else if (first.url) {
      const resp = await fetch(first.url);
      const arr = await resp.arrayBuffer();
      basePng = Buffer.from(arr);
    } else {
      return NextResponse.json({ error: 'Image generation had neither b64_json nor url' }, { status: 502 });
    }

    // 2) Resize to exact trim, then add bleed canvas + set 300 DPI
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

    // 3) Proof overlay (trim=red, safe=green) — not in final
    const bleedPx = px(0.125, dpi);
    const safeInset = bleedPx + px(0.125, dpi); // extra 1/8"
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

    // 4) Upload to Vercel Blob (public URLs)
    const id = crypto.randomUUID();
    const finalBlob = await put(`dtf/${id}-final.png`, finalPng, { access: 'public', contentType: 'image/png' });
    const proofBlob = await put(`dtf/${id}-proof.png`, proofPng, { access: 'public', contentType: 'image/png' });

    return NextResponse.json({ finalUrl: finalBlob.url, proofUrl: proofBlob.url });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to generate';
    console.error(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
