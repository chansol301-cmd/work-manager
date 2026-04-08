// api/bot.js
// 텔레그램 봇 메시지 수신 → 직원 chat_id 자동 등록
// 봇에게 /start 이름 을 보내면 자동 등록됨
// 예: /start 홍길동

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sendTelegram(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

async function findEmployee(name) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/employees?name=eq.${encodeURIComponent(name)}&select=*`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const rows = await res.json();
  return rows[0] || null;
}

async function updateChatId(empId, chatId) {
  await fetch(`${SUPABASE_URL}/rest/v1/employees?id=eq.${empId}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ telegram_chat_id: String(chatId) }),
  });
}

async function updateApproverChatId(chatId) {
  await fetch(`${SUPABASE_URL}/rest/v1/config?id=eq.main`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ approver_telegram_chat_id: String(chatId) }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const update = req.body;
  const msg = update.message;
  if (!msg) return res.status(200).end();

  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // /start 이름 — 직원 등록
  if (text.startsWith('/start')) {
    const name = text.replace('/start', '').trim();

    if (!name) {
      await sendTelegram(chatId,
        `안녕하세요! 근무 관리 봇입니다.\n\n등록하려면 이름을 포함해서 보내주세요:\n<code>/start 홍길동</code>`
      );
      return res.status(200).end();
    }

    const emp = await findEmployee(name);
    if (!emp) {
      await sendTelegram(chatId,
        `❌ <b>${name}</b> 이름의 직원을 찾을 수 없습니다.\n관리자에게 문의하거나 이름을 정확히 입력해주세요.`
      );
      return res.status(200).end();
    }

    await updateChatId(emp.id, chatId);
    await sendTelegram(chatId,
      `✅ <b>${emp.name}</b>님, 등록됐습니다!\n\n` +
      `이제 신청 승인/반려 결과와 대체휴무 소멸 알림을 이 채팅으로 받을 수 있어요.`
    );
    return res.status(200).end();
  }

  // /approver 비번 — 승인자 등록
  if (text.startsWith('/approver')) {
    const pw = text.replace('/approver', '').trim();
    // config에서 approver_pw 확인
    const cfgRes = await fetch(`${SUPABASE_URL}/rest/v1/config?id=eq.main&select=approver_pw`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    const cfg = (await cfgRes.json())[0];
    if (!cfg || pw !== cfg.approver_pw) {
      await sendTelegram(chatId, `❌ 승인자 비밀번호가 올바르지 않습니다.`);
      return res.status(200).end();
    }
    await updateApproverChatId(chatId);
    await sendTelegram(chatId,
      `✅ 승인자로 등록됐습니다!\n새 신청이 들어오면 이 채팅으로 알림이 옵니다.`
    );
    return res.status(200).end();
  }

  // 기타 메시지
  await sendTelegram(chatId,
    `사용 가능한 명령어:\n` +
    `<code>/start 이름</code> — 직원 등록\n` +
    `<code>/approver 비밀번호</code> — 승인자 등록`
  );
  res.status(200).end();
}
