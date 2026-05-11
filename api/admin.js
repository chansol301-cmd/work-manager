// api/admin.js
// 관리자 전용 write 작업 — admin 토큰 검증 후 service key 로 DB 조작
// RLS 활성화된 employees / holidays / config / requests(delete) 모두 여기서

import { verifyToken } from './auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function db(method, path, body) {
  const opts = { method, headers: { ...HEADERS, Prefer: 'return=representation' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`DB error ${r.status}: ${text}`);
  }
  if (method === 'DELETE') return { ok: true };
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const session = await verifyToken(req.headers.authorization, 'admin');
  if (!session) return res.status(401).json({ ok: false, reason: 'no-admin-token' });

  const { action, payload } = req.body || {};

  try {
    switch (action) {
      // ── employees ─────────────────────────────────────
      case 'addEmployee': {
        const { name, role } = payload || {};
        if (!name) return res.status(400).json({ ok: false, reason: 'name-required' });
        const data = await db('POST', 'employees', { name, role: role || '팀원' });
        return res.status(200).json({ ok: true, data: data[0] });
      }
      case 'updateEmployee': {
        const { id, updates } = payload || {};
        if (!id || !updates) return res.status(400).json({ ok: false });
        await db('PATCH', `employees?id=eq.${encodeURIComponent(id)}`, updates);
        return res.status(200).json({ ok: true });
      }
      case 'deleteEmployee': {
        const { id } = payload || {};
        if (!id) return res.status(400).json({ ok: false });
        await db('DELETE', `employees?id=eq.${encodeURIComponent(id)}`);
        return res.status(200).json({ ok: true });
      }

      // ── holidays ──────────────────────────────────────
      case 'upsertHoliday': {
        const { date, name } = payload || {};
        if (!date || !name) return res.status(400).json({ ok: false });
        await db('POST', 'holidays', { date, name });
        return res.status(200).json({ ok: true });
      }
      case 'updateHoliday': {
        const { origDate, newDate, newName } = payload || {};
        if (!origDate) return res.status(400).json({ ok: false });
        if (newDate && newDate !== origDate) {
          await db('DELETE', `holidays?date=eq.${encodeURIComponent(origDate)}`);
          await db('POST', 'holidays', { date: newDate, name: newName });
        } else {
          await db('PATCH', `holidays?date=eq.${encodeURIComponent(origDate)}`, { name: newName });
        }
        return res.status(200).json({ ok: true });
      }
      case 'deleteHoliday': {
        const { date } = payload || {};
        if (!date) return res.status(400).json({ ok: false });
        await db('DELETE', `holidays?date=eq.${encodeURIComponent(date)}`);
        return res.status(200).json({ ok: true });
      }

      // ── config ────────────────────────────────────────
      case 'saveConfig': {
        const updates = payload || {};
        // 비번 컬럼은 절대 받지 않음
        delete updates.admin_pw;
        delete updates.approver_pw;
        delete updates.approver_pw_set;
        await db('PATCH', 'config?id=eq.main', updates);
        return res.status(200).json({ ok: true });
      }

      // ── requests (admin: delete + update for diagnostic fix) ──
      case 'deleteRequest': {
        const { id } = payload || {};
        if (!id) return res.status(400).json({ ok: false });
        await db('DELETE', `requests?id=eq.${encodeURIComponent(id)}`);
        return res.status(200).json({ ok: true });
      }
      case 'updateRequest': {
        const { id, updates } = payload || {};
        if (!id || !updates) return res.status(400).json({ ok: false });
        await db('PATCH', `requests?id=eq.${encodeURIComponent(id)}`, updates);
        return res.status(200).json({ ok: true });
      }

      // ── restore (전체 백업 복원) ───────────────────────
      case 'restoreBackup': {
        const data = payload || {};
        // 모두 비우기
        await Promise.all([
          db('DELETE', 'requests?id=neq.__none__'),
          db('DELETE', 'employees?id=neq.__none__'),
          db('DELETE', 'holidays?date=neq.__none__'),
        ]);
        // 다시 채우기 (config 는 일반 필드만, 비번 X)
        if (Array.isArray(data.employees) && data.employees.length) {
          await db('POST', 'employees',
            data.employees.map(e => ({ id: e.id, name: e.name, role: e.role, created_at: e.created_at })));
        }
        if (Array.isArray(data.holidays) && data.holidays.length) {
          await db('POST', 'holidays', data.holidays);
        }
        if (Array.isArray(data.requests) && data.requests.length) {
          for (let i = 0; i < data.requests.length; i += 50) {
            const chunk = data.requests.slice(i, i + 50).map(r => ({
              id: r.id, eid: r.eid, type: r.type, date: r.date,
              start_time: r.start_time, end_time: r.end_time,
              hours: r.hours, daehu: r.daehu, reason: r.reason,
              status: r.status, comment: r.comment, expiry: r.expiry,
              is_leave: r.is_leave, created_at: r.created_at,
            }));
            await db('POST', 'requests', chunk);
          }
        }
        if (data.config) {
          const c = data.config;
          await db('PATCH', 'config?id=eq.main', {
            biz: c.biz || '', country: c.country || '',
            lunch_start: c.lunch?.s || '12:00', lunch_end: c.lunch?.e || '13:00',
            schedule: c.schedule,
          });
        }
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ ok: false, reason: 'unknown-action' });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
