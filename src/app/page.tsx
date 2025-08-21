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
  const px = (n: number) => Math.round(n * dpi);

  async function generate() {
    if (!prompt) return;
    setStatus('working');
    setProofUrl(undefined);
    setFinalUrl(undefined);

    try {
      const res = await fetch('/api/dtf/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, widthIn: Number(widthIn), heightIn: Number(heightIn) }),
      });

      const text = await res.text();
      let data: { proofUrl?: string; finalUrl?: string; error?: string } = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text?.slice(0, 300) || 'Non-JSON response' }; }

      if (!res.ok) {
        alert(data.error || `HTTP ${res.status}: ${text?.slice(0, 200)}`);
        setStatus('error');
        return;
      }

      if (!data.proofUrl || !data.finalUrl) {
        alert('Generation failed: missing URLs in response.');
        setStatus('error');
        return;
      }

      setProofUrl(data.proofUrl);
      setFinalUrl(data.finalUrl);
      setStatus('done');
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Network error';
      alert(message);
      setStatus('error');
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6 text-black">
<h1 className="text-2xl font-semibold text-white">
 Unreal Custom Designs DTF Image Generator (Print-Ready)
</h1>


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

      {proofUrl && (
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
  );
}
