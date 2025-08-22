import type { NextApiRequest, NextApiResponse } from 'next';
import { setStatus } from '@/lib/gallery';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query.token;
  if (token !== process.env.ADMIN_API_TOKEN) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { id, action } = req.body as { id?: string; action?: 'approve'|'hide' };
  if (!id || !action) { res.status(400).json({ error: 'id and action required' }); return; }

  await setStatus(id, action === 'approve' ? 'approved' : 'hidden');
  res.status(200).json({ ok: true });
}
