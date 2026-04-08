# 근무 관리 앱 배포 가이드

## 3단계: Supabase DB 테이블 만들기

1. supabase.com → work-manager 프로젝트 클릭
2. 왼쪽 메뉴 **SQL Editor** 클릭
3. **New query** 클릭
4. `schema.sql` 파일 내용 전체 복사 → 붙여넣기
5. **Run** 버튼 클릭
6. "Success" 메시지 확인

---

## 4단계: GitHub에 파일 올리기

1. github.com → work-manager 저장소 접속
2. **Add file** → **Upload files** 클릭
3. `index.html`, `schema.sql`, `README.md` 3개 파일 드래그앤드롭
4. 아래 **Commit changes** 버튼 클릭

---

## 5단계: Vercel 배포

1. vercel.com 접속 → **Add New Project** 클릭
2. **Import Git Repository** → work-manager 선택
3. 설정 그대로 두고 **Deploy** 클릭
4. 1~2분 기다리면 완료
5. 화면에 나오는 URL (예: work-manager-xxx.vercel.app) 접속

---

## 완료!

팀원들에게 URL 공유하면 모든 기기에서 접속 가능합니다.

- 관리자 초기 비밀번호: **7598**
- 승인자 초기 비밀번호: **0000** (첫 로그인 시 변경 필요)
