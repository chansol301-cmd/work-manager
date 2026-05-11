// api/approve.js
// 승인자 전용 — 신청 승인/반려 + 처리한 신청 정리(delete)
// approver 토큰 검증 후 service key 로 DB 조작

import { verifyToken } from './auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const session = await verifyToken(req.headers.authorization, 'approver');
  if (!session) return res.status(401).json({ ok: false, reason: 'no-approver-token' });

  const body = req.body || {};
  const action = body.action;

  try {
    // ── status update (default) — 승인/반려 ──
    if (!action || action === 'updateStatus') {
      const { id, status, comment } = body;
      if (!id || !['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ ok: false, reason: 'bad-input' });
      }
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/requests?id=eq.${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: { ...HEADERS, Prefer: 'return=minimal' },
          body: JSON.stringify({ status, comment: comment || '' }),
        }
      );
      if (!r.ok) {
        const text = await r.text();
        return res.status(500).json({ ok: false, error: text });
      }
      return res.status(200).json({ ok: true });
    }

    // ── delete — 승인자가 처리한 신청 정리 ──
    if (action === 'delete') {
      const { id } = body;
      if (!id) return res.status(400).json({ ok: false });
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/requests?id=eq.${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: HEADERS }
      );
      if (!r.ok) {
        const text = await r.text();
        return res.status(500).json({ ok: false, error: text });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, reason: 'unknown-action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
