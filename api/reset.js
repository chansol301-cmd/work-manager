// api/reset.js
// 전체 리셋 — admin token + admin 비번 + "리셋" 확인 텍스트 (이중 인증)
// service key 로 RLS 우회

import { verifyToken } from './auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function loadAdminPw() {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/secrets?id=eq.main&select=admin_pw`, { headers: HEADERS });
    if (r.ok) {
      const rows = await r.json();
      if (rows && rows[0]) return { source: 'secrets', admin_pw: rows[0].admin_pw };
    }
  } catch (e) { /* fallback */ }
  const r2 = await fetch(`${SUPABASE_URL}/rest/v1/config?id=eq.main&select=admin_pw`, { headers: HEADERS });
  const rows = await r2.json();
  return { source: 'config', admin_pw: (rows[0] || {}).admin_pw };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // 1차 — admin token (sessionStorage)
  const session = await verifyToken(req.headers.authorization, 'admin');
  if (!session) return res.status(401).json({ ok: false, reason: 'no-admin-token' });

  const { adminPassword, confirm } = req.body || {};
  if (confirm !== '리셋') return res.status(400).json({ ok: false, reason: 'wrong-confirm' });

  // 2차 — admin 비번 한 번 더 (이중 인증)
  const auth = await loadAdminPw();
  if (!auth.admin_pw || auth.admin_pw !== adminPassword) {
    return res.status(401).json({ ok: false, reason: 'wrong-pw' });
  }

  try {
    await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/requests?id=neq.__none__`, { method: 'DELETE', headers: HEADERS }),
      fetch(`${SUPABASE_URL}/rest/v1/employees?id=neq.__none__`, { method: 'DELETE', headers: HEADERS }),
      fetch(`${SUPABASE_URL}/rest/v1/holidays?date=neq.__none__`, { method: 'DELETE', headers: HEADERS }),
    ]);
    await fetch(`${SUPABASE_URL}/rest/v1/config?id=eq.main`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ biz: '', country: '', approver_telegram_chat_id: '' }),
    });
    await fetch(`${SUPABASE_URL}/rest/v1/${auth.source}?id=eq.main`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ admin_pw: '7598', approver_pw: '0000', approver_pw_set: false }),
    });
    // 리셋 후 모든 세션 무효화
    await fetch(`${SUPABASE_URL}/rest/v1/sessions?token=neq.__none__`, { method: 'DELETE', headers: HEADERS });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
