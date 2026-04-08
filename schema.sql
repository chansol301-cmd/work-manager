-- 1. 설정 테이블
create table if not exists config (
  id text primary key default 'main',
  biz text default '',
  country text default '',
  lunch_start text default '12:00',
  lunch_end text default '13:00',
  admin_pw text default '7598',
  approver_pw text default '0000',
  approver_pw_set boolean default false,
  schedule jsonb default '{"mon":{"s":"09:00","e":"18:00"},"tue":{"s":"09:00","e":"18:00"},"wed":{"s":"09:00","e":"18:00"},"thu":{"s":"09:00","e":"18:00"},"fri":{"s":"09:00","e":"18:00"},"sat":{"s":"","e":""},"sun":{"s":"","e":""}}'::jsonb,
  updated_at timestamptz default now()
);

-- 기본 설정 행 삽입
insert into config (id) values ('main') on conflict (id) do nothing;

-- 2. 직원 테이블
create table if not exists employees (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  role text default '팀원',
  created_at timestamptz default now()
);

-- 3. 공휴일 테이블
create table if not exists holidays (
  date text primary key,
  name text not null
);

-- 기본 공휴일
insert into holidays (date, name) values
  ('2026-03-01', '삼일절'),
  ('2026-05-05', '어린이날'),
  ('2026-06-06', '현충일')
on conflict (date) do nothing;

-- 4. 근무 신청 테이블
create table if not exists requests (
  id text primary key default gen_random_uuid()::text,
  eid text not null references employees(id) on delete cascade,
  type text not null check (type in ('ext','hol','use')),
  date text not null,
  start_time text default '',
  end_time text default '',
  hours numeric default 0,
  daehu numeric default 0,
  reason text default '',
  status text default 'pending' check (status in ('pending','approved','rejected')),
  comment text default '',
  expiry text,
  is_leave boolean default false,
  created_at timestamptz default now()
);

-- RLS 비활성화 (소규모 내부 사용 — 필요시 나중에 활성화)
alter table config disable row level security;
alter table employees disable row level security;
alter table holidays disable row level security;
alter table requests disable row level security;
