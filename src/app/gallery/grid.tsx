'use client';

import Image from 'next/image';
import { useMemo, useState } from 'react';

type Item = {
  id: string;
  createdAt: number;
  prompt: string;
  proofUrl: string;
  finalUrl: string;
  svgUrl?: string;
  vectorPngUrl?: string;
};

export default function GalleryGrid({ items }: { items: Item[] }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState<Item | null>(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter(it => it.prompt.toLowerCase().includes(s));
  }, [q, items]);

  return (
    <>
      <div className="mb-3">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search prompts…"
          className="w-full md:w-80 rounded border px-3 py-2 text-sm"
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {filtered.map((it) => (
          <button
            key={it.id}
            onClick={() => setActive(it)}
            className="group relative rounded-lg overflow-hidden border border-white/10 bg-white"
            title={it.prompt}
          >
            <Image
              src={it.proofUrl}
              alt={it.prompt}
              width={600}
              height={600}
              unoptimized
              className="w-full h-auto"
            />
            <div className="absolute inset-x-0 bottom-0 bg-black/50 text-white text-xs p-2 line-clamp-2">
              {it.prompt}
            </div>
          </button>
        ))}
      </div>

      {active && (
        <div
          className="fixed inset-0 z-50 bg-black/70 grid place-items-center p-4"
          onClick={(e) => { if (e.currentTarget === e.target) setActive(null); }}
        >
          <div className="w-full max-w-3xl bg-white rounded-xl overflow-hidden">
            <div className="flex items-center justify-between bg-[#1f2937] text-white px-3 py-2">
              <div className="text-sm line-clamp-1">{active.prompt}</div>
              <button className="text-white" onClick={() => setActive(null)}>✕</button>
            </div>
            <div className="p-3">
              <img src={active.finalUrl} alt={active.prompt} className="w-full h-auto rounded border" />
              <div className="mt-3 flex flex-wrap gap-2">
                <a className="inline-block bg-emerald-600 text-white px-3 py-1.5 rounded" href={active.finalUrl} download>
                  Download PNG
                </a>
                {active.svgUrl && (
                  <a className="inline-block bg-indigo-600 text-white px-3 py-1.5 rounded" href={active.svgUrl} download>
                    Download SVG
                  </a>
                )}
                {active.vectorPngUrl && (
                  <a className="inline-block bg-blue-600 text-white px-3 py-1.5 rounded" href={active.vectorPngUrl} download>
                    Download Vector PNG
                  </a>
                )}
              </div>
              <div className="mt-2 text-xs text-gray-600">
                Added: {new Date(active.createdAt).toLocaleString()}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
