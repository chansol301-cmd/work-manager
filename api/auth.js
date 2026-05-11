// api/auth.js
// 비번 검증/변경/리셋 — 클라이언트가 비번을 직접 다루지 않도록 서버사이드로 분리
//
// 동작 방식:
//   1) secrets 테이블이 존재하면 그쪽을 우선 사용 (마이그레이션 후)
//   2) 없으면 config 테이블 fallback (마이그레이션 전 호환)
// → push 후 사용자가 시간 두고 마이그레이션 SQL 실행해도 무중단

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function loadSecrets() {
  // secrets 테이블 시도
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/secrets?id=eq.main&select=*`, { headers: HEADERS });
    if (r.ok) {
      const rows = await r.json();
      if (rows && rows[0]) return { source: 'secrets', ...rows[0] };
    }
  } catch (e) { /* fallback */ }
  // config fallback
  const r2 = await fetch(
    `${SUPABASE_URL}/rest/v1/config?id=eq.main&select=admin_pw,approver_pw,approver_pw_set`,
    { headers: HEADERS }
  );
  const rows = await r2.json();
  return { source: 'config', ...(rows[0] || {}) };
}

async function saveSecrets(updates) {
  const cur = await loadSecrets();
  const target = cur.source; // 'secrets' or 'config'
  await fetch(`${SUPABASE_URL}/rest/v1/${target}?id=eq.main`, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify(updates),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { action, type, password, newPassword } = req.body || {};

  try {
    // ── login ─────────────────────────────────────────
    if (action === 'login') {
      const s = await loadSecrets();
      const stored = type === 'admin' ? s.admin_pw : s.approver_pw;
      if (!stored) return res.status(200).json({ ok: false, reason: 'no-pw' });
      const ok = stored === password;
      const out = { ok };
      if (ok && type === 'approver') out.approver_pw_set = !!s.approver_pw_set;
      return res.status(200).json(out);
    }

    // ── set-pw (관리자 비번 변경 or 승인자 비번 변경) ─────
    if (action === 'set-pw') {
      if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ ok: false, reason: 'too-short' });
      }
      if (type === 'approver' && newPassword === '0000') {
        return res.status(400).json({ ok: false, reason: 'init-pw' });
      }
      const updates = type === 'admin'
        ? { admin_pw: newPassword }
        : { approver_pw: newPassword, approver_pw_set: true };
      await saveSecrets(updates);
      return res.status(200).json({ ok: true });
    }

    // ── reset-pw (관리자가 승인자 비번을 0000 으로 초기화) ──
    if (action === 'reset-pw') {
      if (type !== 'approver') return res.status(400).json({ ok: false });
      await saveSecrets({ approver_pw: '0000', approver_pw_set: false });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, reason: 'unknown-action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
