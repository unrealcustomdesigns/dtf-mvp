import { getItem } from '@/lib/gallery';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

// Next.js 15: params is a Promise in PageProps — await it.
type PageProps = { params: Promise<{ id: string }> };

function withDownload(u: string | undefined, filename: string): string | undefined {
  if (!u) return undefined;
  return `${u}${u.includes('?') ? '&' : '?'}download=${encodeURIComponent(filename)}`;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const it = await getItem(id);
  if (!it || it.status !== 'approved') {
    return { title: 'Design not found' };
  }
  const title = it.prompt.slice(0, 60);
  return {
    title,
    description: 'AI DTF design preview',
    openGraph: {
      title,
      images: [{ url: it.proofUrl }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      images: [it.proofUrl],
    },
  };
}

export default async function DesignPage({ params }: PageProps) {
  const { id } = await params;
  const it = await getItem(id);
  if (!it || it.status !== 'approved') {
    notFound();
  }

  // Mobile-friendly download URLs (force attachment via ?download=)
  const pngDL  = withDownload(it.finalUrl, 'dtf.png')!;
  const svgDL  = withDownload(it.svgUrl, 'dtf.svg');
  const vpngDL = withDownload(it.vectorPngUrl, 'dtf-vector.png');

  return (
    <div className="min-h-screen bg-[#3A3B3D] p-8 text-white">
      <div className="max-w-4xl mx-auto space-y-4">
        <h1 className="text-2xl font-semibold">{it.prompt}</h1>

        {/* You can switch to next/image later to silence the warning */}
        <img
          src={it.finalUrl}
          alt={it.prompt}
          className="w-full h-auto rounded border border-white/10 bg-white"
        />

        <div className="flex flex-wrap gap-2">
          <a className="inline-block bg-emerald-600 text-white px-3 py-1.5 rounded" href={pngDL}>
            Download PNG
          </a>
          {svgDL && (
            <a className="inline-block bg-indigo-600 text-white px-3 py-1.5 rounded" href={svgDL}>
              Download SVG
            </a>
          )}
          {vpngDL && (
            <a className="inline-block bg-blue-600 text-white px-3 py-1.5 rounded" href={vpngDL}>
              Download Vector PNG
            </a>
          )}
        </div>

        <div className="text-xs text-gray-300">
          Added: {new Date(it.createdAt).toLocaleString()}
        </div>
      </div>
    </div>
  );
}
