// api/reset.js
// 전체 리셋 — 관리자 비번 확인 + "리셋" 텍스트 확인 필수
// service key 로 실행. RLS 우회.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function loadAdminPw() {
  // secrets 우선, config fallback
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
  const { adminPassword, confirm } = req.body || {};
  if (confirm !== '리셋') return res.status(400).json({ ok: false, reason: 'wrong-confirm' });

  const auth = await loadAdminPw();
  if (!auth.admin_pw || auth.admin_pw !== adminPassword) {
    return res.status(401).json({ ok: false, reason: 'wrong-pw' });
  }

  try {
    // 1) requests / employees / holidays 전부 삭제
    await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/requests?id=neq.__none__`, { method: 'DELETE', headers: HEADERS }),
      fetch(`${SUPABASE_URL}/rest/v1/employees?id=neq.__none__`, { method: 'DELETE', headers: HEADERS }),
      fetch(`${SUPABASE_URL}/rest/v1/holidays?date=neq.__none__`, { method: 'DELETE', headers: HEADERS }),
    ]);
    // 2) config 의 일반 필드 리셋 (schedule 은 그대로 둠)
    await fetch(`${SUPABASE_URL}/rest/v1/config?id=eq.main`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ biz: '', country: '', approver_telegram_chat_id: '' }),
    });
    // 3) 비번 리셋 (secrets 또는 config 어느 쪽이든)
    await fetch(`${SUPABASE_URL}/rest/v1/${auth.source}?id=eq.main`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ admin_pw: '7598', approver_pw: '0000', approver_pw_set: false }),
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
