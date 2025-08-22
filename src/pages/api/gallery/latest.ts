import type { NextApiRequest, NextApiResponse } from 'next';
import { Redis } from '@upstash/redis';

type GalleryItem = {
  id: string;
  createdAt: number;
  prompt: string;
  proofUrl: string;
  finalUrl: string;
  svgUrl?: string;
  vectorPngUrl?: string;
  status: 'approved' | 'pending' | 'hidden';
};

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

/** Coerce any redis value to a GalleryItem or null (supports string JSON, object). */
function asItem(val: unknown): GalleryItem | null {
  if (!val) return null;
  if (typeof val === 'string') {
    const s = val.trim();
    if (!s) return null;
    if (s.startsWith('{')) {
      try { return JSON.parse(s) as GalleryItem; } catch { return null; }
    }
    return null; // plain id string, not an item
  }
  if (typeof val === 'object') return val as GalleryItem; // Upstash may decode to object
  return null;
}

async function getDocById(id: string): Promise<GalleryItem | null> {
  if (!redis) return null;
  const raw = await redis.get<unknown>(`gallery:item:${id}`);
  return asItem(raw);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!redis) { res.status(200).json({ ok: false, reason: 'no_redis_env' }); return; }

  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 20)));

  // IMPORTANT: read as unknown — NOT string — so we can handle raw objects
  const entries = await redis.lrange<unknown>('gallery:items', 0, limit - 1);

  const ids: string[] = [];
  const items: GalleryItem[] = [];

  for (const entry of entries) {
    if (typeof entry === 'string') {
      const s = entry.trim();
      if (s.startsWith('{')) { const it = asItem(s); if (it) items.push(it); }
      else if (s) { ids.push(s); } // id
    } else if (typeof entry === 'object' && entry) {
      const it = asItem(entry);
      if (it) items.push(it);
    }
  }

  if (ids.length) {
    const docs = await Promise.all(ids.map(getDocById));
    for (const it of docs) if (it) items.push(it);
  }

  res.status(200).json({
    ok: true,
    totalListEntries: entries.length,
    idOnlyEntries: ids.length,
    count: items.length,
    items,
  });
}
