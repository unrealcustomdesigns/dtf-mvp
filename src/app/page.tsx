'use client';

import { useState } from 'react';

type Status = 'idle' | 'working' | 'done' | 'error';

export default function Home() {
  const [prompt, setPrompt] = useState('');
  const [widthIn, setWidthIn] = useState<number>(11);
  const [heightIn, setHeightIn] = useState<number>(11);
  const [status, setStatus] = useState<Status>('idle');
  const [proofUrl, setProofUrl] = useState<string>();
  const [finalUrl, setFinalUrl] = useState<string>();

  const dpi = 300;
  const bleedIn = 0.125;
  const px = (n: number) => Math.round(n * dpi);
  const pxWithBleed = (n: number) => Math.round((n + 2 * bleedIn) * dpi);

  async function generate() {
    if (!prompt) return;
    setStatus('working');
    setProofUrl(undefined);
    setFinalUrl(undefined);

    try {
      const res = await fetch('/api/dtf/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          widthIn: Number(widthIn),
          heightIn: Number(heightIn),
        }),
      });

      const json = await res.json();
      if (res.ok) {
        setProofUrl(json.proofUrl);
        setFinalUrl(json.finalUrl);
        setStatus('done');
      } else {
        alert(json.error || 'Something went wrong');
        setStatus('error');
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Network error';
      alert(message);
      setStatus('error');
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold">DTF Image Generator (Print-Ready)</h1>

      <label className="block">
        <span className="text-sm font-medium">Prompt</span>
        <textarea
          className="mt-1 w-full border rounded p-2"
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
            className="mt-1 w-full border rounded p-2"
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
            className="mt-1 w-full border rounded p-2"
            value={heightIn}
            onChange={(e) => setHeightIn(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="text-xs text-gray-600">
        <div>
          <strong>DPI:</strong> 300 &nbsp; <strong>Bleed:</strong> 0.125&quot;
        </div>
        <div className="mt-1">
          Trim: {px(widthIn)} × {px(heightIn)} px &nbsp;|&nbsp; Final (with bleed): {pxWithBleed(widthIn)} × {pxWithBleed(heightIn)} px
        </div>
      </div>

      <button
        className="bg-black text-white rounded px-4 py-2"
        onClick={generate}
        disabled={!prompt || status === 'working'}
      >
        {status === 'working' ? 'Generating…' : 'Generate'}
      </button>

      {proofUrl && (
        <div className="border rounded p-3">
          <div className="text-sm mb-2">Proof (trim=red, safe=green)</div>
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
  );
}
