// api/webhook.js
// Supabase Database Webhook → 텔레그램 알림 발송

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

function rf(x) { return Math.round(x * 2) / 2; }

async function sendTelegram(chatId, text) {
  if (!chatId || !BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

async function getEmployees() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/employees?select=*`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  return res.json();
}

async function getConfig() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/config?id=eq.main&select=*`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  const rows = await res.json();
  return rows[0] || {};
}

async function getRequests(eid) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/requests?eid=eq.${eid}&select=*`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  return res.json();
}

// FIFO 잔여 계산 — 만료일 빠른 것부터 차감
function calcBalance(requests) {
  const today = new Date().toISOString().slice(0, 10);
  const approved = requests.filter(r => r.status === 'approved');
  const pending = requests.filter(r => r.status === 'pending');

  // 만료일별 버킷 (만료 안 된 것만)
  const buckets = approved
    .filter(r => r.type !== 'use' && r.expiry && r.expiry >= today)
    .map(r => ({ expiry: r.expiry, remain: parseFloat(r.daehu || 0) }))
    .sort((a, b) => a.expiry.localeCompare(b.expiry));

  // 사용량을 만료일 빠른 버킷부터 FIFO 차감
  const usedList = approved
    .filter(r => r.type === 'use')
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const u of usedList) {
    let left = parseFloat(u.hours || 0);
    for (const b of buckets) {
      if (left <= 0) break;
      const deduct = Math.min(b.remain, left);
      b.remain = rf(b.remain - deduct);
      left = rf(left - deduct);
    }
  }

  const confirmed = rf(buckets.reduce((a, b) => a + b.remain, 0));

  // pending 포함 잔여
  const pendingEarned = rf(pending
    .filter(r => r.type !== 'use' && (!r.expiry || r.expiry >= today))
    .reduce((a, r) => a + parseFloat(r.daehu || 0), 0));
  const pendingUsed = rf(pending
    .filter(r => r.type === 'use')
    .reduce((a, r) => a + parseFloat(r.hours || 0), 0));

  const bal = rf(Math.max(0, confirmed + pendingEarned - pendingUsed));

  // 만료일별 잔여 목록
  const balByExpiry = buckets
    .filter(b => b.remain > 0)
    .map(b => {
      const diff = Math.round((new Date(b.expiry) - new Date()) / 864e5);
      return { expiry: b.expiry, remain: b.remain, diff };
    });

  return { bal, confirmed, pendingEarned, pendingUsed, balByExpiry };
}

// 만료일별 잔여 텍스트 생성
function formatBalByExpiry(balByExpiry) {
  if (!balByExpiry || balByExpiry.length === 0) return '잔여 없음';
  return balByExpiry.map(b => {
    const label = b.diff <= 0 ? '오늘 소멸' : b.diff === 1 ? '내일 소멸' : `${b.diff}일 후 소멸`;
    return `  • ${b.expiry} 만료: ${b.remain}h (${label})`;
  }).join('\n');
}

const TYPE_LABEL = { ext: '연장근무', hol: '휴일근무', use: '대체휴무 사용' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const secret = req.headers['x-webhook-secret'];
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { type, record, old_record } = req.body;

  try {
    const [employees, config] = await Promise.all([getEmployees(), getConfig()]);
    const empMap = Object.fromEntries(employees.map(e => [e.id, e]));
    const approverChatId = config.approver_telegram_chat_id;

    // ── 신규 신청 (INSERT) ──────────────────────────────
    if (type === 'INSERT' && record.status === 'pending') {
      const emp = empMap[record.eid];
      const timeStr = record.start_time && record.end_time
        ? `${record.start_time}~${record.end_time}` : `${record.hours}h`;
      const daehuStr = record.type !== 'use'
        ? `\n➕ 대체휴무 적립 예정: <b>${record.daehu}h</b>`
        : `\n➖ 차감 예정: <b>${record.hours}h</b>`;

      const allReqs = await getRequests(record.eid);
      const { bal, pendingEarned, pendingUsed, balByExpiry } = calcBalance(allReqs);
      const pendingStr = (pendingEarned > 0 || pendingUsed > 0)
        ? ` (미승인 ${pendingEarned > 0 ? '+' + pendingEarned + 'h' : ''}${pendingUsed > 0 ? ' -' + pendingUsed + 'h' : ''} 포함)` : '';

      const msg =
        `📋 <b>새 신청이 들어왔습니다</b>\n` +
        `👤 ${emp?.name || '?'} | 📅 ${record.date}\n` +
        `🕐 ${TYPE_LABEL[record.type]} · ${timeStr}` +
        daehuStr +
        (record.reason ? `\n💬 사유: ${record.reason}` : '') +
        `\n\n💰 현재 잔여: <b>${bal}h</b>${pendingStr}\n` +
        formatBalByExpiry(balByExpiry);

      await sendTelegram(approverChatId, msg);
    }

    // ── 상태 변경 (UPDATE) ──────────────────────────────
    if (type === 'UPDATE' && old_record && record.status !== old_record.status) {
      const emp = empMap[record.eid];
      const empChatId = emp?.telegram_chat_id;
      const timeStr = record.start_time && record.end_time
        ? `${record.start_time}~${record.end_time}` : `${record.hours}h`;

      // 승인됨
      if (record.status === 'approved') {
        const allReqs = await getRequests(record.eid);
        const { bal, pendingEarned, pendingUsed, balByExpiry } = calcBalance(allReqs);
        const pendingStr = (pendingEarned > 0 || pendingUsed > 0)
          ? ` (미승인 ${pendingEarned > 0 ? '+' + pendingEarned + 'h' : ''}${pendingUsed > 0 ? ' -' + pendingUsed + 'h' : ''} 포함)` : '';

        let msg = '';
        if (record.type === 'use') {
          msg =
            `✅ <b>대체휴무 사용 승인됨</b>\n` +
            `👤 ${emp?.name || '?'} | 📅 ${record.date} ${timeStr}\n` +
            `➖ <b>${record.hours}h</b> 차감\n` +
            (record.comment ? `💬 ${record.comment}\n` : '') +
            `\n💰 잔여: <b>${bal}h</b>${pendingStr}\n` +
            formatBalByExpiry(balByExpiry);
        } else {
          msg =
            `✅ <b>${TYPE_LABEL[record.type]} 승인됨</b>\n` +
            `👤 ${emp?.name || '?'} | 📅 ${record.date} ${timeStr}\n` +
            `➕ <b>${record.daehu}h</b> 적립\n` +
            (record.comment ? `💬 ${record.comment}\n` : '') +
            `\n💰 잔여: <b>${bal}h</b>${pendingStr}\n` +
            formatBalByExpiry(balByExpiry);
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
        const { bal, balByExpiry } = calcBalance(allReqs);

        const empMsg =
          `🔄 <b>신청이 취소됐습니다</b>\n` +
          `👤 ${emp?.name || '?'} | 📅 ${record.date}\n` +
          `📌 ${TYPE_LABEL[record.type]} · ${timeStr}\n` +
          `\n💰 잔여: <b>${bal}h</b>\n` +
          formatBalByExpiry(balByExpiry);

        const aprMsg =
          `🔄 <b>신청 취소</b>\n` +
          `👤 ${emp?.name || '?'}님이 ${TYPE_LABEL[record.type]} 신청을 취소했습니다.\n` +
          `📅 ${record.date} · ${timeStr}`;

        await sendTelegram(empChatId, empMsg);
        await sendTelegram(approverChatId, aprMsg);
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
