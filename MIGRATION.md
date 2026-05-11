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
