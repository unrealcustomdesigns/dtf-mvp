'use client';

import { useState } from 'react';

type Status = 'idle' | 'working' | 'done' | 'error';
type Option = { proofUrl: string; finalUrl: string };

export default function Home() {
  const [prompt, setPrompt] = useState('');
  const [widthIn, setWidthIn] = useState<number>(11);
  const [heightIn, setHeightIn] = useState<number>(11);
  const [status, setStatus] = useState<Status>('idle');

  // Single-result (back-compat)
  const [proofUrl, setProofUrl] = useState<string>();
  const [finalUrl, setFinalUrl] = useState<string>();

  // Multi-result (3 options)
  const [options, setOptions] = useState<Option[]>([]);
  const [selected, setSelected] = useState<number | null>(null);

  const dpi = 300;
  const px = (n: number) => Math.round(n * dpi);

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
        body: JSON.stringify({ prompt, widthIn: Number(widthIn), heightIn: Number(heightIn) }),
      });

      const text = await res.text();
      let data: any = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { error: text?.slice(0, 300) || 'Non-JSON response' };
      }

      if (!res.ok) {
        alert(data.error || `HTTP ${res.status}: ${text?.slice(0, 200)}`);
        setStatus('error');
        return;
      }

      // New multi-option response: { options: [{proofUrl, finalUrl}, ...] }
      if (Array.isArray(data.options) && data.options.length > 0) {
        setOptions(data.options as Option[]);
        setSelected(0);
        setStatus('done');
        return;
      }

      // Back-compat single response
      if (data.proofUrl && data.finalUrl) {
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
      {/* Title on dark page background */}
      <div className="max-w-3xl mx-auto mb-4">
        <h1 className="text-2xl font-semibold text-white">
          Unreal Custom Designs DTF Image Generator (Print-Ready)
        </h1>
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

        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-medium">Width (inches)</span>
            <input
              type="number"
              min={1}
              step="0.5"
              className="mt-1 w-full border rounded p-2 text-black placeholder-black"
              value={widthIn}
              onChange={(e) => setWidthIn(Number(e.target.value))}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Height (inches)</span>
            <input
              type="number"
              min={1}
              step="0.5"
              className="mt-1 w-full border rounded p-2 text-black placeholder-black"
              value={heightIn}
              onChange={(e) => setHeightIn(Number(e.target.value))}
            />
          </label>
        </div>

        <div className="text-xs">
          <div><strong>DPI:</strong> 300 (pixels shown are trim size; no bleed)</div>
          <div className="mt-1">Trim: {px(widthIn)} × {px(heightIn)} px</div>
        </div>

        <button
          className="bg-black text-white rounded px-4 py-2"
          onClick={generate}
          disabled={!prompt || status === 'working'}
        >
          {status === 'working' ? 'Generating…' : 'Generate'}
        </button>

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
              <div className="pt-2">
                <a
                  className="inline-block bg-emerald-600 text-white px-4 py-2 rounded"
                  href={options[selected].finalUrl}
                  download
                >
                  Download Selected PNG
                </a>
              </div>
            )}
          </div>
        )}

        {/* Single-image fallback (old response shape) */}
        {options.length === 0 && proofUrl && (
          <div className="border rounded p-3">
            <div className="text-sm mb-2">Proof</div>
            <img src={proofUrl} alt="DTF proof" className="max-w-full border rounded" />
            {finalUrl && (
              <a
                className="inline-block mt-3 bg-emerald-600 text-white px-4 py-2 rounded"
                href={finalUrl}
                download
              >
                Download Print-Ready PNG
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
