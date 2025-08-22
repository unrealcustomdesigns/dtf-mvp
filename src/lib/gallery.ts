import { Redis } from '@upstash/redis';

export type GalleryItem = {
  id: string;
  createdAt: number;
  prompt: string;
  proofUrl: string;
  finalUrl: string;
  svgUrl?: string;
  vectorPngUrl?: string;
  status: 'approved' | 'pending' | 'hidden';
};

export const galleryRedis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

// --- helpers ---------------------------------------------------------------

/** Safely coerce a Redis value (string or object) into a GalleryItem, or null. */
function asItem(val: unknown): GalleryItem | null {
  if (!val) return null;
  if (typeof val === 'string') {
    try {
      // If it's a JSON string, parse; if it's a plain string, reject.
      if (val.trim().startsWith('{')) return JSON.parse(val) as GalleryItem;
      return null;
    } catch {
      return null;
    }
  }
  if (typeof val === 'object') {
    // @upstash/redis can auto-de/serialize objects if you saved objects directly
    return val as GalleryItem;
  }
  return null;
}

/** Load per-item doc by id; handles both string and object storage. */
async function getDocById(id: string): Promise<GalleryItem | null> {
  if (!galleryRedis) return null;
  const raw = await galleryRedis.get<unknown>(`gallery:item:${id}`);
  return asItem(raw);
}

// --- public API ------------------------------------------------------------

/**
 * New path (recommended):
 * - store doc at key: gallery:item:{id}
 * - push id into list: gallery:items
 */
export async function addToGallery(item: GalleryItem) {
  if (!galleryRedis) return;
  await galleryRedis.set(`gallery:item:${item.id}`, JSON.stringify(item));
  await galleryRedis.lpush('gallery:items', item.id);
  await galleryRedis.ltrim('gallery:items', 0, 999); // keep latest 1000
}

/**
 * Backward compatible reader:
 * - If list entry looks like an id: fetch gallery:item:{id}
 * - If list entry looks like a JSON string: parse and use directly (legacy)
 */
export async function getLatest(
  limit = 60,
  status: 'approved' | 'pending' | 'hidden' | 'all' = 'approved'
): Promise<GalleryItem[]> {
  if (!galleryRedis) return [];

  const entries = await galleryRedis.lrange<unknown>('gallery:items', 0, limit - 1);

  const items: GalleryItem[] = [];
  for (const entry of entries) {
    let it: GalleryItem | null = null;

    if (typeof entry === 'string') {
      const s = entry.trim();
      if (s.startsWith('{')) {
        // Legacy: the list contains full JSON strings
        it = asItem(s);
      } else {
        // New: the list contains ids
        it = await getDocById(s);
      }
    } else if (typeof entry === 'object' && entry) {
      // Legacy: someone pushed objects directly to the list
      it = asItem(entry);
    }

    if (it) items.push(it);
  }

  if (status === 'all') return items;
  return items.filter((x) => x.status === status);
}

export async function getItem(id: string) {
  if (!galleryRedis) return null;
  const doc = await getDocById(id);
  return doc;
}

export async function setStatus(id: string, status: GalleryItem['status']) {
  if (!galleryRedis) return;
  const it = await getDocById(id);
  if (!it) return;
  it.status = status;
  await galleryRedis.set(`gallery:item:${id}`, JSON.stringify(it));
}
