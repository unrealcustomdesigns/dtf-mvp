import { getItem } from '@/lib/gallery';
import type { Metadata } from 'next';

type Props = { params: { id: string } };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const it = await getItem(params.id);
  if (!it) return { title: 'Design not found' };
  return {
    title: it.prompt.slice(0, 60),
    description: 'AI DTF design preview',
    openGraph: {
      title: it.prompt.slice(0, 60),
      images: [{ url: it.proofUrl }]
    },
    twitter: {
      card: 'summary_large_image',
      title: it.prompt.slice(0, 60),
      images: [it.proofUrl]
    }
  };
}

export default async function DesignPage({ params }: Props) {
  const it = await getItem(params.id);
  if (!it || it.status !== 'approved') {
    return <div className="min-h-screen bg-[#3A3B3D] text-white p-8">Design not found.</div>;
  }
  return (
    <div className="min-h-screen bg-[#3A3B3D] p-8 text-white">
      <div className="max-w-4xl mx-auto space-y-4">
        <h1 className="text-2xl font-semibold">{it.prompt}</h1>
        <img src={it.finalUrl} alt={it.prompt} className="w-full h-auto rounded border border-white/10 bg-white" />
        <div className="flex flex-wrap gap-2">
          <a className="inline-block bg-emerald-600 text-white px-3 py-1.5 rounded" href={it.finalUrl} download>Download PNG</a>
          {it.svgUrl && <a className="inline-block bg-indigo-600 text-white px-3 py-1.5 rounded" href={it.svgUrl} download>Download SVG</a>}
          {it.vectorPngUrl && <a className="inline-block bg-blue-600 text-white px-3 py-1.5 rounded" href={it.vectorPngUrl} download>Download Vector PNG</a>}
        </div>
        <div className="text-xs text-gray-300">Added: {new Date(it.createdAt).toLocaleString()}</div>
      </div>
    </div>
  );
}
