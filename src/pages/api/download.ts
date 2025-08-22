import type { NextApiRequest, NextApiResponse } from 'next';

/** Allow only Vercel Blob (adjust if you serve from additional hosts) */
function isAllowed(url: URL) {
  const host = url.hostname.toLowerCase();
  return host.endsWith('.blob.vercel-storage.com');
}

function sanitizeName(name: string) {
  return name.replace(/[\\\/"<>\:\|\*\?]/g, '').slice(0, 120) || 'file';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const urlParam = (req.query.url as string) || '';
  const nameParam = (req.query.name as string) || '';
  if (!urlParam) {
    res.status(400).json({ error: 'Missing url' });
    return;
  }

  let remote: URL;
  try {
    remote = new URL(urlParam);
  } catch {
    res.status(400).json({ error: 'Invalid url' });
    return;
  }

  if (!isAllowed(remote)) {
    res.status(400).json({ error: 'Host not allowed' });
    return;
  }

  const filename = sanitizeName(nameParam || remote.pathname.split('/').pop() || 'file');

  const upstream = await fetch(remote.toString(), {
    headers: { Accept: 'image/*,application/octet-stream' },
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    res.status(upstream.status).send(text || 'Failed to fetch file');
    return;
  }

  const ab = await upstream.arrayBuffer();
  const buf = Buffer.from(ab);
  const ct = upstream.headers.get('content-type') || 'application/octet-stream';

  res.setHeader('Content-Type', ct);
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(buf);
}
