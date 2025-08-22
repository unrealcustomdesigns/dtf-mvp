import { getLatest } from '@/lib/gallery';
import GalleryGrid from './grid';

export const revalidate = 60; // refresh list every 60s

export default async function GalleryPage() {
  const items = await getLatest(60, 'approved');
  return (
    <div className="min-h-screen bg-[#3A3B3D] py-8 px-4">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-white text-2xl font-semibold mb-4">Recent Designs</h1>
        <GalleryGrid items={items} />
      </div>
    </div>
  );
}
