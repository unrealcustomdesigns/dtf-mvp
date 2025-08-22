import type { NextApiRequest, NextApiResponse } from 'next';
import { Redis } from '@upstash/redis';

type GalleryItem = {
  id: string; createdAt: number; prompt: string;
  proofUrl: string; finalUrl: string; svgUrl?: string; vectorPngUrl?: string;
  status: 'approved' | 'pending' | 'hidden';
};

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
    : null;

function asItem(val: unknown): GalleryItem | null {
  if (!val) return null;
  if (typeof val === 'string') {
    const s = val.trim();
    if (s.startsWith('{')) { try { return JSON.parse(s) as GalleryItem; } catch { return null; } }
    return null;
  }
  if (typeof val === 'object') return val as GalleryItem;
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || String(req.query.token || '');
  if (token !== process.env.ADMIN_API_TOKEN) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (!redis) { res.status(500).json({ error: 'no_redis_env' }); return; }

  const raw = await redis.lrange<unknown>('gallery:items', 0, 999);
  const ids: string[] = [];
  const legacyItems: GalleryItem[] = [];

  for (const e of raw) {
    if (typeof e === 'string') {
      const s = e.trim();
      if (s.startsWith('{')) { const it = asItem(s); if (it) legacyItems.push(it); }
      else if (s) ids.push(s);
    } else if (typeof e === 'object' && e) {
      const it = asItem(e); if (it) legacyItems.push(it);
    }
  }

  let written = 0;
  // Write missing per-item docs
  for (const it of legacyItems) {
    await redis.set(`gallery:item:${it.id}`, JSON.stringify(it));
    ids.push(it.id);
    written++;
  }
  // Overwrite the list with IDs only (latest first)
  if (ids.length) {
    // Remove current list
    await redis.del('gallery:items');
    // Push back ids
    // lpush pushes in reverse order, so push in order to preserve newest-first
    for (const id of ids) await redis.lpush('gallery:items', id);
    await redis.ltrim('gallery:items', 0, 999);
  }

  res.status(200).json({ ok: true, ids: ids.length, normalizedFromLegacy: written });
}
