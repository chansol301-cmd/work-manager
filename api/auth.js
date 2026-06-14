// api/auth.js
// 비번 검증 + 세션 토큰 발급/검증/폐기
// secrets 테이블 우선, config 테이블 fallback (마이그레이션 안전)

import { randomBytes } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

// 토큰 만료: admin 8시간, approver 8시간 (관리자가 긴 작업 중 만료되어 수정 안 먹히는 문제 해결)
const TOKEN_EXPIRY = { admin: 8 * 3600, approver: 8 * 3600 };

// brute-force 따속 + timing attack 보호 — 모든 login 응답에 일정 delay
const LOGIN_DELAY_MS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadSecrets() {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/secrets?id=eq.main&select=*`, { headers: HEADERS });
    if (r.ok) {
      const rows = await r.json();
      if (rows && rows[0]) return { source: 'secrets', ...rows[0] };
    }
  } catch (e) { /* fallback */ }
  const r2 = await fetch(
    `${SUPABASE_URL}/rest/v1/config?id=eq.main&select=admin_pw,approver_pw,approver_pw_set`,
    { headers: HEADERS }
  );
  const rows = await r2.json();
  return { source: 'config', ...(rows[0] || {}) };
}

async function saveSecrets(updates) {
  const cur = await loadSecrets();
  await fetch(`${SUPABASE_URL}/rest/v1/${cur.source}?id=eq.main`, {
    method: 'PATCH', headers: HEADERS, body: JSON.stringify(updates),
  });
}

async function issueToken(role) {
  const token = randomBytes(32).toString('hex');
  const expSec = TOKEN_EXPIRY[role] || 3600;
  const expires_at = new Date(Date.now() + expSec * 1000).toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/sessions`, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'return=minimal' },
    body: JSON.stringify({ token, role, expires_at }),
  });
  return { token, expires_at };
}

export async function verifyToken(authHeader, requiredRole) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/sessions?token=eq.${encodeURIComponent(token)}&select=*`,
    { headers: HEADERS }
  );
  const rows = await r.json();
  if (!rows[0]) return null;
  if (new Date(rows[0].expires_at) < new Date()) {
    await fetch(`${SUPABASE_URL}/rest/v1/sessions?token=eq.${encodeURIComponent(token)}`,
      { method: 'DELETE', headers: HEADERS });
    return null;
  }
  if (requiredRole && rows[0].role !== requiredRole) return null;
  return rows[0];
}

async function deleteToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return;
  const token = authHeader.slice(7);
  await fetch(`${SUPABASE_URL}/rest/v1/sessions?token=eq.${encodeURIComponent(token)}`,
    { method: 'DELETE', headers: HEADERS });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { action, type, password, newPassword } = req.body || {};

  try {
    // ── login ─────────────────────────────────────────────
    if (action === 'login') {
      // 항상 일정 delay (성공/실패 동일) — brute-force 따속 + timing attack 보호
      await sleep(LOGIN_DELAY_MS);
      if (!type || !password) return res.status(400).json({ ok: false });
      const s = await loadSecrets();
      const stored = type === 'admin' ? s.admin_pw : s.approver_pw;
      if (!stored || stored !== password) {
        return res.status(200).json({ ok: false });
      }
      const { token, expires_at } = await issueToken(type);
      const out = { ok: true, token, role: type, expires_at };
      if (type === 'approver') out.approver_pw_set = !!s.approver_pw_set;
      return res.status(200).json(out);
    }

    // ── logout ────────────────────────────────────────────
    if (action === 'logout') {
      await deleteToken(req.headers.authorization);
      return res.status(200).json({ ok: true });
    }

    // ── set-pw (approver token 필요 — 로그인 직후 받은 토큰) ──
    if (action === 'set-pw') {
      const session = await verifyToken(req.headers.authorization, 'approver');
      if (!session) return res.status(401).json({ ok: false, reason: 'no-token' });
      if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ ok: false, reason: 'too-short' });
      }
      if (newPassword === '0000') return res.status(400).json({ ok: false, reason: 'init-pw' });
      await saveSecrets({ approver_pw: newPassword, approver_pw_set: true });
      return res.status(200).json({ ok: true });
    }

    // ── reset-pw (admin token 필요) ───────────────────────
    if (action === 'reset-pw') {
      const session = await verifyToken(req.headers.authorization, 'admin');
      if (!session) return res.status(401).json({ ok: false, reason: 'no-token' });
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
