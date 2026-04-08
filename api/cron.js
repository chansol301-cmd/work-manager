// api/cron.js
// 매일 오전 9시 소멸 임박 알림 + 봇 등록(/start) 처리

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sendTelegram(chatId, text) {
  if (!chatId || !BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

async function getAll() {
  const [empRes, reqRes, cfgRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/employees?select=*`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    }),
    fetch(`${SUPABASE_URL}/rest/v1/requests?select=*&status=eq.approved`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    }),
    fetch(`${SUPABASE_URL}/rest/v1/config?id=eq.main&select=*`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    }),
  ]);
  return {
    employees: await empRes.json(),
    requests: await reqRes.json(),
    config: (await cfgRes.json())[0] || {},
  };
}

function getDiff(expiryDate) {
  return Math.round((new Date(expiryDate) - new Date()) / 864e5);
}

function rf(x) { return Math.round(x * 2) / 2; }

export default async function handler(req, res) {
  // Vercel Cron 또는 수동 호출
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  try {
    const { employees, requests, config } = await getAll();
    const today = new Date().toISOString().slice(0, 10);
    const ALERT_DAYS = [15, 7, 3, 1, 0];

    for (const emp of employees) {
      if (!emp.telegram_chat_id) continue;

      const empReqs = requests.filter(r => r.eid === emp.id && r.type !== 'use');

      // 만료일별 그룹핑
      const groups = {};
      empReqs.filter(r => r.expiry && r.expiry >= today).forEach(r => {
        if (!groups[r.expiry]) groups[r.expiry] = 0;
        groups[r.expiry] += parseFloat(r.daehu || 0);
      });

      for (const [expiry, hours] of Object.entries(groups)) {
        const diff = getDiff(expiry);
        if (!ALERT_DAYS.includes(diff)) continue;

        const h = rf(hours);
        let label = diff === 0 ? '오늘 소멸' : diff === 1 ? '내일 소멸' : `${diff}일 후 소멸`;
        let icon = diff <= 3 ? '🚨' : diff <= 7 ? '⚠️' : '📢';

        const msg =
          `${icon} <b>대체휴무 소멸 임박</b>\n` +
          `👤 ${emp.name} · <b>${label}</b>\n` +
          `📅 소멸일: ${expiry}\n` +
          `💰 소멸 예정: <b>${h}h</b>\n` +
          `\n기한 내 대체휴무를 사용해주세요.`;

        await sendTelegram(emp.telegram_chat_id, msg);
      }
    }

    res.status(200).json({ ok: true, checked: employees.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
