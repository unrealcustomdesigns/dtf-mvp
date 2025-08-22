import type { NextApiRequest, NextApiResponse } from 'next';
import { Redis } from '@upstash/redis';

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!redis) { res.status(200).json({ ok: false, reason: 'no_redis_env' }); return; }

  // List IDs we’re tracking
  const ids = await redis.lrange<string>('gallery:items', 0, 19);
  // Expand first few docs
  const docs = await Promise.all(ids.slice(0, 10).map(id => redis.get<string>(`gallery:item:${id}`)));
  const items = docs.filter(Boolean).map(s => JSON.parse(s as string));

  res.status(200).json({ ok: true, count: ids.length, ids, first: items });
}
