# 보안 마이그레이션 (2026-05-11)

기존 `config` 테이블에 평문으로 저장돼 있던 비번 (`admin_pw`, `approver_pw`) 을 별도 `secrets` 테이블로 분리해 클라이언트 (publishable key) 가 못 읽게 합니다.

`api/auth.js` 와 `api/reset.js` 가 **secrets 우선 + config fallback** 으로 동작하므로:
- 마이그레이션 SQL 실행 **전후 모두 정상 동작** (무중단)
- 시간 두고 천천히 실행해도 안전

---

## Supabase 콘솔 → SQL Editor 에서 실행

```sql
-- 1) secrets 테이블 생성
create table if not exists secrets (
  id text primary key default 'main',
  admin_pw text not null default '7598',
  approver_pw text not null default '0000',
  approver_pw_set boolean not null default false,
  updated_at timestamptz default now()
);

-- 2) 기존 config 의 비번을 secrets 로 복사
insert into secrets (id, admin_pw, approver_pw, approver_pw_set)
select 'main', admin_pw, approver_pw, coalesce(approver_pw_set, false)
from config where id='main'
on conflict (id) do update set
  admin_pw        = excluded.admin_pw,
  approver_pw     = excluded.approver_pw,
  approver_pw_set = excluded.approver_pw_set;

-- 3) RLS 활성화 — anon 가 secrets 못 읽음
alter table secrets enable row level security;
-- 정책 없음 → 모든 anon access 거부. service_role 은 RLS 우회.
```

---

## 검증

### A. secrets 에 데이터 들어갔는지 (SQL Editor)

```sql
select id, length(admin_pw) as adm_len, length(approver_pw) as apr_len, approver_pw_set from secrets;
```

`adm_len` 과 `apr_len` 이 0 보다 크고, 기존 비번과 일치하는 길이로 나오면 OK.

### B. anon 가 secrets 못 읽는지 (브라우저 콘솔에서)

`work-manager-xi.vercel.app` 열고 F12 → Console 에서:

```js
const r = await fetch(SUPABASE_URL + '/rest/v1/secrets?select=*', { headers: { apikey: SUPABASE_KEY }});
console.log(r.status, await r.text());
```

→ `[]` 빈 배열 또는 RLS 거부 에러가 반환되어야 함. `admin_pw` 값이 보이면 RLS 가 적용 안 된 것.

### C. 로그인 정상 동작

- 관리자 로그인 (기존 비번)
- 승인자 로그인 (기존 비번)
- 승인자 비번 변경
- 승인자 비번 초기화

모두 정상이면 마이그레이션 성공.

---

## (선택) 충분히 안정 확인 후 — config 의 비번 컬럼 삭제

`api/auth.js` 의 fallback 로직이 더 이상 필요 없다고 판단되면:

```sql
alter table config drop column if exists admin_pw;
alter table config drop column if exists approver_pw;
alter table config drop column if exists approver_pw_set;
```

⚠️ **비가역**. `secrets` 의 데이터가 정상이고 fallback 발동한 적이 한참 없을 때 별건으로 진행 권장.

---

# 환경변수 설정 (필수)

다음 환경변수가 모두 설정돼야 정상 동작합니다. **하나라도 비어있으면 해당 endpoint 가 500 응답.**

| 환경변수 | 어디서 사용 | 설정 안 하면 |
|---|---|---|
| `SUPABASE_URL` | 모든 `api/*` | 모든 알림/로그인 동작 X |
| `SUPABASE_SERVICE_KEY` | 모든 `api/*` | 모든 알림/로그인 동작 X |
| `TELEGRAM_BOT_TOKEN` | bot/cron/webhook | 텔레그램 알림 안 감 |
| `WEBHOOK_SECRET` | webhook | webhook 500 응답 (이전엔 누구나 호출 가능했음 — 이제 차단됨) |
| `CRON_SECRET` | cron | cron 500 응답 (이전엔 빈 secret 가 통과 가능했음 — 이제 차단됨) |
| `TELEGRAM_WEBHOOK_SECRET` | bot | bot endpoint 500 응답 (이전엔 인증 X 였음 — 이제 차단됨) ⚠️ **신규** |

## Vercel 환경변수 등록

Vercel 대시보드 → 프로젝트 → **Settings → Environment Variables** 에서 위 변수 모두 등록.

## TELEGRAM_WEBHOOK_SECRET 설정 (신규)

1. 임의의 강한 secret 문자열 생성 (예: `openssl rand -hex 32` 또는 임의의 영숫자 32자)
2. Vercel 환경변수에 `TELEGRAM_WEBHOOK_SECRET` 으로 등록
3. **Telegram setWebhook 다시 호출** — 같은 secret 을 `secret_token` 파라미터로 전달:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://work-manager-xi.vercel.app/api/bot",
    "secret_token": "<위에서 생성한 secret>"
  }'
```

이렇게 하면 텔레그램이 매 요청에 `X-Telegram-Bot-Api-Secret-Token` 헤더로 secret 을 보내고, `bot.js` 가 그걸 검증합니다. 외부에서 가짜 메시지 못 보냄.

## 검증

설정 후 — 텔레그램 봇에 `/start 이름` 보내서 정상 응답 오면 OK. 응답 없으면 Vercel Logs 에서 500 에러 확인.

---

# RLS + 토큰 인증 마이그레이션 (4차)

이번 변경으로 **모든 write 가 서버 API 통과** 후 service key 로 DB 조작합니다. RLS 활성화 + sessions 테이블 추가 필요.

## 새 환경변수 (없으면 동작 X)

| 변수 | 용도 |
|---|---|
| `SESSION_SECRET` | (예약 — 현재는 사용 X. 추후 JWT 전환 시) |

(현재 토큰은 DB 의 sessions 테이블에 저장 — 별도 secret 불필요)

## Supabase SQL Editor 에서 실행

```sql
-- 1) sessions 테이블 생성
create table if not exists sessions (
  token text primary key,
  role text not null check (role in ('admin','approver')),
  created_at timestamptz default now(),
  expires_at timestamptz not null
);
alter table sessions enable row level security;
-- 정책 없음 → anon 거부, service_role 만 접근

-- 2) RLS 활성화 + 정책
-- requests: select 허용, insert(pending), update(pending→cancelled) 만 허용
alter table requests enable row level security;
drop policy if exists "req_select_anon" on requests;
drop policy if exists "req_insert_pending" on requests;
drop policy if exists "req_cancel_only" on requests;
create policy "req_select_anon"   on requests for select to anon using (true);
create policy "req_insert_pending" on requests for insert to anon with check (status = 'pending');
create policy "req_cancel_only"   on requests for update to anon
  using (status = 'pending') with check (status = 'cancelled');

-- employees / holidays / config: select 만 anon
alter table employees enable row level security;
drop policy if exists "emp_select_anon" on employees;
create policy "emp_select_anon" on employees for select to anon using (true);

alter table holidays enable row level security;
drop policy if exists "hol_select_anon" on holidays;
create policy "hol_select_anon" on holidays for select to anon using (true);

alter table config enable row level security;
drop policy if exists "cfg_select_anon" on config;
create policy "cfg_select_anon" on config for select to anon using (true);
```

## ⚠️ 영향 — 적용 즉시

- 직원의 신청 등록 / 본인 신청 취소: **계속 동작** (anon 정책 통과)
- 승인/반려 / 직원 관리 / 공휴일 관리 / 설정 변경 / 백업 복원 / 리셋: **로그인 필요** (token 발급)
- 로그인 안 한 anon 가 publishable key 로 직접 write 시도: **403 거부**

## 검증

브라우저 콘솔에서 (로그인 안 한 상태):
```js
const r = await fetch(SUPABASE_URL+'/rest/v1/employees', {
  method:'POST', headers:{apikey:SUPABASE_KEY,'Content-Type':'application/json'},
  body: JSON.stringify({name:'테스트'})
});
console.log(r.status);  // 403 또는 401 이어야 함
```

200 이 나오면 RLS 가 적용 안 된 상태.

## 만료된 세션 정리 (선택)

토큰 만료 시 자동 정리되지만 (verifyToken 호출 시), 누적 방지 위해 주기적 cleanup 가능:
```sql
delete from sessions where expires_at < now();
```

cron 으로 자동화하려면 Supabase 의 `pg_cron` 또는 Vercel cron 추가.
