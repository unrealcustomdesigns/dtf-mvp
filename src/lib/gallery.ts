import { Redis } from '@upstash/redis';

export type GalleryItem = {
  id: string;
  createdAt: number;
  prompt: string;
  proofUrl: string;      // thumbnail
  finalUrl: string;      // print PNG
  svgUrl?: string;
  vectorPngUrl?: string;
  status: 'approved' | 'pending' | 'hidden';
};

export const galleryRedis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

export async function addToGallery(item: GalleryItem) {
  if (!galleryRedis) return;
  // Store a per-item doc
  await galleryRedis.set(`gallery:item:${item.id}`, JSON.stringify(item));
  // Push to head of a FIFO list
  await galleryRedis.lpush('gallery:items', item.id);
  // Keep only latest N items (e.g., 1000)
  await galleryRedis.ltrim('gallery:items', 0, 999);
}

export async function getLatest(limit = 60, status: 'approved'|'pending'|'hidden'|'all' = 'approved') {
  if (!galleryRedis) return [] as GalleryItem[];
  const ids = await galleryRedis.lrange<string>('gallery:items', 0, limit - 1);
  const docs = await Promise.all(ids.map(id => galleryRedis.get<string>(`gallery:item:${id}`)));
  const items = docs.filter(Boolean).map(s => JSON.parse(s as string) as GalleryItem);
  if (status === 'all') return items;
  return items.filter(it => it.status === status);
}

export async function getItem(id: string) {
  if (!galleryRedis) return null;
  const s = await galleryRedis.get<string>(`gallery:item:${id}`);
  return s ? (JSON.parse(s) as GalleryItem) : null;
}

export async function setStatus(id: string, status: GalleryItem['status']) {
  if (!galleryRedis) return;
  const it = await getItem(id);
  if (!it) return;
  it.status = status;
  await galleryRedis.set(`gallery:item:${id}`, JSON.stringify(it));
}
