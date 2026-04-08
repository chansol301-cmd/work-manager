// api/webhook.js
// Supabase Database Webhook → 텔레그램 알림 발송

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

async function sendTelegram(chatId, text) {
  if (!chatId || !BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }),
  });
}

async function getEmployees() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/employees?select=*`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  return res.json();
}

async function getConfig() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/config?id=eq.main&select=*`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  const rows = await res.json();
  return rows[0] || {};
}

async function getRequests(eid) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/requests?eid=eq.${eid}&select=*`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    }
  );
  return res.json();
}

function calcBalance(requests) {
  const today = new Date().toISOString().slice(0, 10);
  const approved = requests.filter(r => r.status === 'approved');
  const active = approved
    .filter(r => r.type !== 'use' && r.expiry && r.expiry >= today)
    .reduce((a, r) => a + parseFloat(r.daehu || 0), 0);
  const used = approved
    .filter(r => r.type === 'use')
    .reduce((a, r) => a + parseFloat(r.hours || 0), 0);
  const pendingEarned = requests
    .filter(r => r.status === 'pending' && r.type !== 'use' && (!r.expiry || r.expiry >= today))
    .reduce((a, r) => a + parseFloat(r.daehu || 0), 0);
  const pendingUsed = requests
    .filter(r => r.status === 'pending' && r.type === 'use')
    .reduce((a, r) => a + parseFloat(r.hours || 0), 0);
  const bal = Math.max(0, active - used + pendingEarned - pendingUsed);
  return Math.round(bal * 2) / 2;
}

const TYPE_LABEL = { ext: '연장근무', hol: '휴일근무', use: '대체휴무 사용' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // 웹훅 시크릿 검증
  const secret = req.headers['x-webhook-secret'];
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { type, record, old_record } = req.body;

  try {
    const [employees, config] = await Promise.all([getEmployees(), getConfig()]);
    const empMap = Object.fromEntries(employees.map(e => [e.id, e]));
    const approverChatId = config.approver_telegram_chat_id;

    // ── 신규 신청 (INSERT) ──────────────────────────────────
    if (type === 'INSERT' && record.status === 'pending') {
      const emp = empMap[record.eid];
      const timeStr = record.start_time && record.end_time
        ? `${record.start_time}~${record.end_time}`
        : `${record.hours}h`;
      const daehuStr = record.type !== 'use'
        ? `\n➕ 대체휴무 적립 예정: <b>${record.daehu}h</b>`
        : `\n➖ 차감 예정: <b>${record.hours}h</b>`;

      const msg =
        `📋 <b>새 신청이 들어왔습니다</b>\n` +
        `👤 ${emp?.name || '?'} | 📅 ${record.date}\n` +
        `🕐 ${TYPE_LABEL[record.type]} · ${timeStr}` +
        daehuStr +
        (record.reason ? `\n💬 사유: ${record.reason}` : '');

      await sendTelegram(approverChatId, msg);
    }

    // ── 상태 변경 (UPDATE) ──────────────────────────────────
    if (type === 'UPDATE' && old_record && record.status !== old_record.status) {
      const emp = empMap[record.eid];
      const empChatId = emp?.telegram_chat_id;
      const timeStr = record.start_time && record.end_time
        ? `${record.start_time}~${record.end_time}`
        : `${record.hours}h`;

      // 승인됨
      if (record.status === 'approved') {
        const allReqs = await getRequests(record.eid);
        const bal = calcBalance(allReqs);

        let msg = '';
        if (record.type === 'use') {
          msg =
            `✅ <b>대체휴무 사용 승인됨</b>\n` +
            `👤 ${emp?.name || '?'} | 📅 ${record.date} ${timeStr}\n` +
            `➖ <b>${record.hours}h</b> 차감\n` +
            `💰 잔여 대체휴무: <b>${bal}h</b>` +
            (record.comment ? `\n💬 ${record.comment}` : '');
        } else {
          msg =
            `✅ <b>${TYPE_LABEL[record.type]} 승인됨</b>\n` +
            `👤 ${emp?.name || '?'} | 📅 ${record.date} ${timeStr}\n` +
            `➕ <b>${record.daehu}h</b> 적립\n` +
            `💰 잔여 대체휴무: <b>${bal}h</b>` +
            (record.comment ? `\n💬 ${record.comment}` : '');
        }
        await sendTelegram(empChatId, msg);
      }

      // 반려됨
      if (record.status === 'rejected') {
        const msg =
          `❌ <b>${TYPE_LABEL[record.type]} 반려됨</b>\n` +
          `👤 ${emp?.name || '?'} | 📅 ${record.date} ${timeStr}\n` +
          (record.comment ? `💬 반려 사유: ${record.comment}\n` : '') +
          `\n앱에서 재신청하거나 승인자에게 문의하세요.`;
        await sendTelegram(empChatId, msg);
      }

      // 취소됨 (본인이 회수)
      if (record.status === 'cancelled') {
        const allReqs = await getRequests(record.eid);
        const bal = calcBalance(allReqs);
        const msg =
          `🔄 <b>신청이 취소됐습니다</b>\n` +
          `👤 ${emp?.name || '?'} | 📅 ${record.date}\n` +
          `📌 ${TYPE_LABEL[record.type]} · ${timeStr}\n` +
          `💰 잔여 대체휴무: <b>${bal}h</b> (변동 없음)`;
        // 본인 + 승인자 모두에게
        await sendTelegram(empChatId, msg);
        await sendTelegram(approverChatId,
          `🔄 <b>신청 취소</b>\n👤 ${emp?.name || '?'}님이 ${TYPE_LABEL[record.type]} 신청을 취소했습니다. (${record.date})`
        );
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
