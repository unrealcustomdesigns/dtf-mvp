import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import sharp from 'sharp';
import crypto from 'node:crypto';
import { put } from '@vercel/blob';

export const runtime = 'nodejs';        // needed for sharp
export const dynamic = 'force-dynamic'; // avoid caching during dev

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// inches → pixels at 300 DPI
const px = (inches: number, dpi = 300) => Math.round(inches * dpi);

export async function POST(req: Request) {
  try {
    const { prompt, widthIn, heightIn } = await req.json();

    if (!prompt || !widthIn || !heightIn) {
      return NextResponse.json({ error: 'prompt, widthIn, heightIn are required' }, { status: 400 });
    }

    const dpi = 300;
    const bleedIn = 0.125; // 1/8"
    const trimW = px(Number(widthIn), dpi);
    const trimH = px(Number(heightIn), dpi);
    const finalW = px(Number(widthIn) + 2 * bleedIn, dpi);
    const finalH = px(Number(heightIn) + 2 * bleedIn, dpi);

    // 1) Generate base transparent PNG (≈1024x1024, resized later)
    const gen = await openai.images.generate({
      model: 'gpt-image-1',
      prompt: `${prompt}\nStyle: clean edges, no watermark, no text.\nBackground: transparent.`,
      size: '1024x1024',
      background: 'transparent'
    });
    const basePng = Buffer.from(gen.data[0].b64_json!, 'base64');

    // 2) Resize to exact trim, then add bleed canvas + 300 DPI metadata
    const resizedTrim = await sharp(basePng)
      .resize({ width: trimW, height: trimH, fit: 'cover' })
      .png()
      .toBuffer();

    const finalPng = await sharp({
      create: { width: finalW, height: finalH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    })
      .composite([{ input: resizedTrim, left: Math.round((finalW - trimW) / 2), top: Math.round((finalH - trimH) / 2) }])
      .png({ compressionLevel: 9 })
      .withMetadata({ density: dpi })
      .toBuffer();

    // 3) Proof overlay (trim=red, safe=green) — NOT in final
    const bleedPx = px(bleedIn, dpi);
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
        { input: await line(2, finalH - safeInset * 2, 0, 255, 0), left: finalW - safeInset - 2, top: safeInset }
      ])
      .png({ compressionLevel: 9 })
      .withMetadata({ density: dpi })
      .toBuffer();

    // 4) Save to Vercel Blob (public URLs)
    const id = crypto.randomUUID();
    const finalBlob = await put(`dtf/${id}-final.png`, finalPng, { access: 'public', contentType: 'image/png' });
    const proofBlob = await put(`dtf/${id}-proof.png`, proofPng, { access: 'public', contentType: 'image/png' });

    return NextResponse.json({ finalUrl: finalBlob.url, proofUrl: proofBlob.url });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err?.message || 'Failed to generate' }, { status: 500 });
    // ...rest of file above...

export async function POST(req: Request) {
  try {
    // your existing code...
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to generate';
    console.error(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}