// api/cron.js
// 매일 정해진 시각 호출 → 진짜 남은 대체휴무 (FIFO 차감 후) 의 만료 임박 알림
// index.html getBal() / webhook.js calcBalance 와 동일한 FIFO 로직 사용

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function rf(x) { return Math.round(x * 2) / 2; }

async function sendTelegram(chatId, text) {
  if (!chatId || !BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

// FIFO 잔여 계산 — 모든 적립 buckets 에서 발생일순 사용을 만료 빠른 순으로 차감
// → 오늘 시점 살아있고 잔여 > 0 인 buckets 만 반환
function calcBalance(requests) {
  const today = new Date().toISOString().slice(0, 10);
  const approved = requests.filter(r => r.status === 'approved');

  const earnedAll = approved
    .filter(r => r.type !== 'use')
    .sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999'));
  const usedAll = approved
    .filter(r => r.type === 'use')
    .sort((a, b) => a.date.localeCompare(b.date));

  const bucketMap = {};
  earnedAll.forEach(r => {
    const key = r.expiry || '9999';
    if (!bucketMap[key]) bucketMap[key] = { expiry: key, total: 0, remain: 0 };
    bucketMap[key].total += parseFloat(r.daehu || 0);
    bucketMap[key].remain += parseFloat(r.daehu || 0);
  });
  const allBuckets = Object.values(bucketMap)
    .map(b => ({ ...b, total: rf(b.total), remain: rf(b.remain) }))
    .sort((a, b) => a.expiry.localeCompare(b.expiry));

  for (const u of usedAll) {
    let left = parseFloat(u.hours || 0);
    for (const b of allBuckets) {
      if (left <= 0) break;
      const d = Math.min(b.remain, left);
      b.remain = rf(b.remain - d);
      left = rf(left - d);
    }
  }

  const activeBuckets = allBuckets.filter(b => b.expiry >= today && b.remain > 0);
  const balByExpiry = activeBuckets.map(b => ({
    expiry: b.expiry,
    remain: b.remain,
    diff: Math.round((new Date(b.expiry) - new Date()) / 864e5),
  }));

  return { balByExpiry };
}

async function getAll() {
  const [empRes, reqRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/employees?select=*`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    }),
    // 모든 status 가져오기 — calcBalance 가 approved 만 필터함 (use 차감용으로 전체 필요)
    fetch(`${SUPABASE_URL}/rest/v1/requests?select=*`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    }),
  ]);
  return {
    employees: await empRes.json(),
    requests: await reqRes.json(),
  };
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  try {
    const { employees, requests } = await getAll();
    const ALERT_DAYS = [15, 7, 3, 1, 0];
    let sent = 0;

    for (const emp of employees) {
      if (!emp.telegram_chat_id) continue;
      const empReqs = requests.filter(r => r.eid === emp.id);
      const { balByExpiry } = calcBalance(empReqs);

      for (const b of balByExpiry) {
        if (!ALERT_DAYS.includes(b.diff)) continue;
        const label = b.diff === 0 ? '오늘 소멸' : b.diff === 1 ? '내일 소멸' : `${b.diff}일 후 소멸`;
        const icon = b.diff <= 3 ? '🚨' : b.diff <= 7 ? '⚠️' : '📢';

        const msg =
          `${icon} <b>대체휴무 소멸 임박</b>\n` +
          `👤 ${emp.name} · <b>${label}</b>\n` +
          `📅 소멸일: ${b.expiry}\n` +
          `💰 잔여: <b>${b.remain}h</b>\n` +
          `\n기한 내 사용해주세요.\n(사용 신청은 만료 빠른 적립부터 자동 차감됩니다)`;

        await sendTelegram(emp.telegram_chat_id, msg);
        sent++;
      }
    }

    res.status(200).json({ ok: true, employees: employees.length, alerts_sent: sent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
