import type { NextApiRequest, NextApiResponse } from 'next';
import sharp from 'sharp';
import crypto from 'node:crypto';
import { put } from '@vercel/blob';

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ?? '*';

// tune this to change how much extra transparent space we add around the model output
const MARGIN_FRACTION = 0.12; // 12% of the shorter side

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
      prompt: `${prompt}\nTransparent background. Centered subject. Full subject in frame. Extra space from edges. Clean edges. No watermark. No text.`,
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

// ---------- PNGJS margin pad (transparent) ----------
async function padTransparentPng(pngBuf: Buffer, marginFraction = MARGIN_FRACTION): Promise<Buffer> {
  const { PNG } = await import('pngjs');
  const src = PNG.sync.read(pngBuf); // { width, height, data: RGBA }

  const base = Math.min(src.width, src.height);
  const pad = Math.max(1, Math.floor(base * Math.max(0, marginFraction)));

  const outW = src.width + 2 * pad;
  const outH = src.height + 2 * pad;

  const out = new PNG({ width: outW, height: outH }); // zeroed = fully transparent

  // blit src into out at (pad, pad) row-by-row
  for (let y = 0; y < src.height; y++) {
    const srcStart = y * src.width * 4;
    const dstStart = ((y + pad) * outW + pad) * 4;
    src.data.copy(out.data, dstStart, srcStart, srcStart + src.width * 4);
  }

  return PNG.sync.write(out);
}

// ---------- PNGJS “contain” (no crop): bilinear + centered transparent pad ----------
async function resizeContainWithPngjs(pngBuf: Buffer, targetW: number, targetH: number): Promise<Buffer> {
  const { PNG } = await import('pngjs');
  const src = PNG.sync.read(pngBuf); // { width, height, data: RGBA }

  // scale to fit INSIDE the box
  const scale = Math.min(targetW / src.width, targetH / src.height);
  const scaledW = Math.max(1, Math.round(src.width * scale));
  const scaledH = Math.max(1, Math.round(src.height * scale));

  // bilinear scale to scaledW × scaledH
  const scaled = new PNG({ width: scaledW, height: scaledH });
  const sData = src.data, dData = scaled.data;
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

  // center onto transparent canvas targetW × targetH
  const out = new PNG({ width: targetW, height: targetH }); // zeroed → transparent
  const offsetX = Math.max(0, Math.floor((targetW - scaledW) / 2));
  const offsetY = Math.max(0, Math.floor((targetH - scaledH) / 2));

  for (let y = 0; y < scaledH; y++) {
    const srcStart = y * scaledW * 4;
    const dstStart = ((y + offsetY) * targetW + offsetX) * 4;
    scaled.data.copy(out.data, dstStart, srcStart, srcStart + scaledW * 4);
  }

  return PNG.sync.write(out);
}

// ---------- core (NO BLEED, no DPI stamp; with auto margin before resize) ----------
async function generateDTF(prompt: string, widthIn: number, heightIn: number) {
  const dpi = 300; // informational only

  const trimW = px(widthIn, dpi);
  const trimH = px(heightIn, dpi);

  // 1) Base PNG
  const basePng = await step('openai_generate', () => generateBasePngViaREST(prompt));

  // 2) Add transparent margin around the model output to avoid “edge cuts”
const padded = await step('pad_margin', () => padTransparentPng(basePng, MARGIN_FRACTION));}