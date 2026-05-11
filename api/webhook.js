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

// FIFO 잔여 계산 — index.html getBal() 과 동일 로직 (승인 기준, pending 은 정보 전용)
// 모든 적립 buckets 에서 발생일순 사용 신청을 만료 빠른 순으로 차감 → 오늘 시점 살아있는 잔여
function calcBalance(requests) {
  const today = new Date().toISOString().slice(0, 10);
  const approved = requests.filter(r => r.status === 'approved');
  const pending = requests.filter(r => r.status === 'pending');

  const earnedAll = approved
    .filter(r => r.type !== 'use')
    .sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999'));
  const usedAll = approved
    .filter(r => r.type === 'use')
    .sort((a, b) => a.date.localeCompare(b.date));

  // 만료일별 buckets (만료된 것 포함 — 그래야 과거 사용을 만료된 적립부터 차감 가능)
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
  const bal = rf(activeBuckets.reduce((a, b) => a + b.remain, 0));

  const balByExpiry = activeBuckets.map(b => ({
    expiry: b.expiry,
    remain: b.remain,
    diff: Math.round((new Date(b.expiry) - new Date()) / 864e5),
  }));

  // pending 은 정보 전용 (잔여에는 합산하지 않음)
  const pendingEarned = rf(pending
    .filter(r => r.type !== 'use' && (!r.expiry || r.expiry >= today))
    .reduce((a, r) => a + parseFloat(r.daehu || 0), 0));
  const pendingUsed = rf(pending
    .filter(r => r.type === 'use')
    .reduce((a, r) => a + parseFloat(r.hours || 0), 0));

  return { bal, balByExpiry, pendingEarned, pendingUsed };
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

  // WEBHOOK_SECRET 미설정 시에도 거부 (이전엔 && 라서 우회 가능)
  if (!WEBHOOK_SECRET) {
    console.error('WEBHOOK_SECRET env var not configured');
    return res.status(500).json({ error: 'Server misconfigured: WEBHOOK_SECRET not set' });
  }
  const secret = req.headers['x-webhook-secret'];
  if (secret !== WEBHOOK_SECRET) {
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
        ? ` (미승인 ${pendingEarned > 0 ? '+' + pendingEarned + 'h' : ''}${pendingUsed > 0 ? ' -' + pendingUsed + 'h' : ''} 대기)` : '';

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
          ? ` (미승인 ${pendingEarned > 0 ? '+' + pendingEarned + 'h' : ''}${pendingUsed > 0 ? ' -' + pendingUsed + 'h' : ''} 대기)` : '';

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
