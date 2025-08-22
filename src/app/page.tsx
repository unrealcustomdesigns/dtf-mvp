'use client';

import { useState } from 'react';
import Link from 'next/link';

type Status = 'idle' | 'working' | 'done' | 'error';
type Option = {
  proofUrl: string;
  finalUrl: string;
  svgUrl?: string;
  vectorPngUrl?: string;
};

type ApiMulti = { options: Option[]; error?: string };
type ApiSingle = { proofUrl?: string; finalUrl?: string; error?: string };
type ApiResponse = ApiMulti | ApiSingle | { error?: string };

const FIXED_IN = 11;
const FIXED_DPI = 300;
const FIXED_PX = FIXED_IN * FIXED_DPI; // 3300

// Build a same-origin download link through /api/download (mobile-safe)
const dl = (u: string | undefined, name: string) =>
  u ? `/api/download?url=${encodeURIComponent(u)}&name=${encodeURIComponent(name)}` : '#';

export default function Home() {
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<Status>('idle');

  const [proofUrl, setProofUrl] = useState<string>();
  const [finalUrl, setFinalUrl] = useState<string>();
  const [options, setOptions] = useState<Option[]>([]);
  const [selected, setSelected] = useState<number | null>(null);

  async function generate() {
    if (!prompt) return;
    setStatus('working');
    setProofUrl(undefined);
    setFinalUrl(undefined);
    setOptions([]);
    setSelected(null);

    try {
      const res = await fetch('/api/dtf/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });

      const text = await res.text();
      let data: ApiResponse = {};
      try { data = text ? (JSON.parse(text) as ApiResponse) : {}; }
      catch { data = { error: text?.slice(0, 300) || 'Non-JSON response' }; }

      if (!res.ok) {
        const errMsg = 'error' in data && data.error ? data.error : `HTTP ${res.status}: ${text?.slice(0, 200)}`;
        alert(errMsg);
        setStatus('error');
        return;
      }

      if ('options' in data && Array.isArray(data.options) && data.options.length > 0) {
        setOptions(data.options);
        setSelected(0);
        setStatus('done');
        return;
      }

      if ('proofUrl' in data && 'finalUrl' in data && data.proofUrl && data.finalUrl) {
        setProofUrl(data.proofUrl);
        setFinalUrl(data.finalUrl);
        setStatus('done');
        return;
      }

      alert('Generation failed: missing URLs in response.');
      setStatus('error');
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Network error';
      alert(message);
      setStatus('error');
    }
  }

  return (
    <div className="min-h-screen py-8 px-4">
      {/* Header: title + View Gallery button */}
      <div className="max-w-3xl mx-auto mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-white">
          Unreal Custom Designs DTF Image Generator (Print-Ready)
        </h1>
        <Link
          href="/gallery"
          className="inline-flex items-center gap-2 rounded-md bg-white/10 hover:bg-white/20 text-white px-3 py-1.5 text-sm"
        >
          View Gallery →
        </Link>
      </div>

      {/* White card content */}
      <div className="max-w-3xl mx-auto bg-white rounded-xl shadow-sm p-6 space-y-6 text-black">
        <label className="block">
          <span className="text-sm font-medium">Prompt</span>
          <textarea
            className="mt-1 w-full border rounded p-2 text-black placeholder-black"
            rows={4}
            placeholder="Vector-style bulldog mascot, bold outlines, no text, transparent background"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>

        {/* Fixed size info */}
        <div className="text-xs">
          <div><strong>Fixed size:</strong> {FIXED_IN}″ × {FIXED_IN}″</div>
          <div className="mt-1">Pixels @300 DPI: {FIXED_PX} × {FIXED_PX}</div>
        </div>

        <button
          className="bg-black text-white rounded px-4 py-2"
          onClick={generate}
          disabled={!prompt || status === 'working'}
        >
          {status === 'working' ? 'Generating…' : 'Generate'}
        </button>

        {/* Disclaimer */}
        <div className="text-xs text-gray-700 bg-yellow-50 border border-yellow-200 rounded-md p-3 leading-relaxed">
          <strong>Note:</strong> For best results, download the <strong>SVG</strong> and import it into the gang sheet builder.
          SVGs scale to any size without losing quality. Our <strong>PNG</strong> output is model-limited to roughly
          <strong> 8–9″</strong> on the long side; enlarging beyond that will soften edges slightly.
          For most T-shirt production the difference is minimal, and results should still look great.
        </div>

        {/* Multi-option gallery */}
        {options.length > 0 && (
          <div className="border rounded p-3 space-y-3">
            <div className="text-sm font-medium mb-1">Pick one:</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {options.map((opt, i) => (
                <button
                  key={i}
                  onClick={() => setSelected(i)}
                  className={`rounded border overflow-hidden focus:outline-none ${
                    selected === i ? 'ring-2 ring-emerald-500' : ''
                  }`}
                  title={`Option ${i + 1}`}
                >
                  <img src={opt.proofUrl} alt={`Option ${i + 1}`} className="w-full h-auto" />
                </button>
              ))}
            </div>

            {selected !== null && (
              <div className="pt-2 flex flex-wrap items-center gap-2">
                <a className="inline-block bg-emerald-600 text-white px-4 py-2 rounded"
                   href={dl(options[selected].finalUrl, 'dtf.png')}>
                  Download Selected PNG
                </a>
                {options[selected].svgUrl && (
                  <a className="inline-block bg-indigo-600 text-white px-4 py-2 rounded"
                     href={dl(options[selected].svgUrl, 'dtf.svg')}>
                    Download SVG
                  </a>
                )}
                {options[selected].vectorPngUrl && (
                  <a className="inline-block bg-blue-600 text-white px-4 py-2 rounded"
                     href={dl(options[selected].vectorPngUrl, 'dtf-vector.png')}>
                    Download Vector PNG
                  </a>
                )}
              </div>
            )}
          </div>
        )}

        {/* Single-image fallback (legacy) */}
        {options.length === 0 && proofUrl && (
          <div className="border rounded p-3">
            <div className="text-sm mb-2">Proof</div>
            <img src={proofUrl} alt="DTF proof" className="max-w-full border rounded" />
            {finalUrl && (
              <a className="inline-block mt-3 bg-emerald-600 text-white px-4 py-2 rounded"
                 href={dl(finalUrl, 'dtf.png')}>
                Download Print-Ready PNG
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
