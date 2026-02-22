# Alam-Bot-Discord

번역 작업 배정 알림봇 — Google Sheets(GAS) + Discord.js E2E 완성본

---

## 변경 요약 (2026-02-22)

- **customId 규격 통일**: 모든 버튼/모달 ID를 `action:<row_id>` 형식으로 표준화
- **버튼 6종 완성**: ACCEPT / REJECT(모달 사유) / START / DONE(모달 메모) / REVIEW_START / REVIEW_DONE
- **검수 플로우 추가**: DONE 후 GAS가 검수자에게 자동 DM → REVIEW_START → REVIEW_DONE
- **postToGas 안정화**: AbortController 10초 타임아웃 + 1회 자동 재시도
- **ANNOUNCE_CHANNEL_ID**: ACK 단계(최초 배정) 시 공지 채널 동시 게시 (선택)
- **GAS 헤더 파싱 전면 재작성**: 관리 시트 10~11행 2단 헤더(병합 셀 포함) → `buildColMap()` + `getMergedRanges()`
- **row_id UUID 기반**: `T-YYYYMMDD-XXXXXXXX` 형식, 불변, 숨김 컬럼으로 관리
- **Asia/Seoul 날짜 자동 기록**: 시작일/종료일 모두 KST 기준
- **언어별 진행상황 텍스트**: 한국어=`작업중/작업 완료`, 기타=`번역중/번역 완료`
- **docs 추가/업데이트**: `sheet_schema.md`, `state_machine.md`, `payloads.md`
- **테스트 스크립트**: `test-webhook.ps1`, `test-gas-callback.ps1` (REVIEW_START/DONE 포함)

---

## CK가 마지막에 채워야 할 값 (시크릿 포함)

### Bot `.env` 파일 (Oracle 서버)

> 아래 키 이름만 기재합니다. **값은 여기에 쓰지 않습니다.**

| 환경변수 키 | 필수 여부 | 설명 |
|---|---|---|
| `BOT_TOKEN` | 필수 | Discord Developer Portal → Bot → Reset Token |
| `GAS_WEB_APP_URL` | 필수 | GAS 배포 후 발급되는 웹앱 실행 URL |
| `ANNOUNCE_CHANNEL_ID` | 선택 | 최초 배정(ACK 단계) 시 게시할 채널 ID. 비우면 비활성화 |
| `PORT` | 선택 | HTTP 서버 포트 (기본 `3000`) |

`.env.example` 파일을 복사해 `.env`로 만든 후 값을 입력하세요.

### GAS Script Properties (GAS 편집기 → 프로젝트 설정 → 스크립트 속성)

| Property 키 | 설명 |
|---|---|
| `SPREADSHEET_ID` | 관리 스프레드시트 URL 중 `/d/` 뒤 식별자 |
| `DISCORD_WEBHOOK_URL` | Bot 서버 외부 접근 URL + `/webhook` |

> Script Properties에는 값을 직접 입력하세요. 코드나 문서에 기재하지 않습니다.

---

## 시스템 아키텍처

```
[Google Sheets]
   PM이 batch_tasks 행 추가 (status=PENDING_ACK)
          │
          │ scanPendingTasks (5분 트리거)
          ▼
[GAS callBotWebhook]
   POST {DISCORD_WEBHOOK_URL}  { stage:"ACK" }
          │
          ▼
[Discord Bot /webhook]
   작업자에게 DM (✅수락 / ❌거절 버튼)
   공지 채널 (ANNOUNCE_CHANNEL_ID) 에도 게시 (ACK 단계만)
          │
   [버튼 클릭 / 모달 제출]
          │
          ▼
[Discord Bot → GAS]
   POST GAS_WEB_APP_URL
   {row_id, action, reject_reason?, done_note?, actor_discord_user_id}
          │
          ▼
[GAS doPost]
   row_id로 행 검색 → status 업데이트 → (DONE 시) 검수자 DM 자동 발송
          │ (DONE 처리 후)
          ▼
[GAS _dispatchReviewDm]
   POST {DISCORD_WEBHOOK_URL}  { stage:"REVIEW", reviewer_discord_user_id }
          │
          ▼
[Discord Bot /webhook]
   검수자에게 DM (🔍검수 시작 / ✅검수 완료 버튼)

[checkNoResponse (10분 트리거)]
   DM_SENT & now > deadline_ack → NO_RESPONSE + retry_count++
```

---

## 상태 흐름

```
PENDING_ACK
    │  scanPendingTasks → DM 전송 성공 + dm_sent_at, deadline_ack 기록
    ▼
DM_SENT
    ├─ [✅ 수락 클릭]  → ACCEPTED  → PROGRESS DM 자동 발송 (▶️ 시작 버튼)
    │      │  [▶️ 시작 클릭]  → IN_PROGRESS → DONE DM 자동 발송 (🏁 완료 버튼)
    │      │       │  [🏁 완료 클릭 + done_note 모달]  → DONE
    │      │       │       │  GAS가 검수자에게 REVIEW DM 자동 발송
    │      │       │       ▼
    │      │       │  [🔍 검수 시작 클릭]  → REVIEW_IN_PROGRESS
    │      │       │       │  [✅ 검수 완료 클릭]  → REVIEW_DONE
    │      │       └───────────────────────────────────────────────
    │      └──────────────────────────────────────────────────────
    ├─ [❌ 거절 클릭 + reject_reason 모달]  → REJECTED
    └─ [30분 무응답 → deadline_ack 경과]  → NO_RESPONSE (retry_count++)
```

---

## 파일 구조

```
Alam-Bot-Discord/
├── index.js                  Discord Bot + Express 서버
├── gas/
│   └── Code.gs               Google Apps Script 전체 코드
├── docs/
│   ├── sheet_schema.md       관리 시트 10~11행 헤더 명세 + FIELD_CANDIDATES
│   ├── state_machine.md      상태 전이 다이어그램 + Action별 업데이트 표
│   └── payloads.md           GAS ↔ Bot API payload 스키마
├── .env.example              환경변수 템플릿 (시크릿 제외)
├── .env                      실제 환경변수 (gitignore됨)
├── test-webhook.ps1          GAS → Bot /webhook 테스트 (PowerShell)
├── test-gas-callback.ps1     Bot → GAS doPost 테스트 (PowerShell)
├── package.json
└── README.md
```

---

## GAS 배포 절차

1. [script.google.com](https://script.google.com) → 새 프로젝트 생성
2. `gas/Code.gs` 전체 내용을 붙여넣고 저장
3. **프로젝트 설정 → 스크립트 속성** 에 두 개 등록:
   - `SPREADSHEET_ID` = 스프레드시트 URL 중 `/d/` 뒤 식별자
   - `DISCORD_WEBHOOK_URL` = Bot 서버의 외부 접근 URL + `/webhook` (값은 직접 입력)
4. **배포 → 새 배포 → 웹앱**:
   - 실행 계정: **나 (Me)**
   - 액세스 권한: **모든 사용자 (Anyone)**
   - 배포 후 실행 URL을 복사 → Oracle 서버 `.env`의 `GAS_WEB_APP_URL` 에 입력
5. GAS 편집기에서 `initSheet` 함수를 **1회 수동 실행**:
   - `ensureExtraCols` + `ensureRowIdCol` 자동 실행 (시스템 컬럼 자동 생성)
   - 기존 데이터 행에 row_id 자동 부여
6. `setupTriggers` 함수를 **1회 수동 실행** → 권한 승인 팝업 → 허용
7. `logColMap` 함수를 수동 실행 → Logger에서 실제 colMap 키 확인 (디버깅용)

> **주의**: 관리 시트 헤더는 **10~11행** 기준입니다. 데이터는 **12행**부터 시작합니다.
> 헤더가 예상과 다르게 파싱될 경우 `logColMap()` 실행 결과를 확인 후
> `gas/Code.gs`의 `FIELD_CANDIDATES` 객체에 후보 키를 추가하세요.

---

## Oracle 서버 pm2 배포 절차

### 사전 요건

```bash
node -v          # 18 이상 확인
npm install -g pm2
```

### 최초 배포

```bash
git clone https://github.com/YOUR_ORG/Alam-Bot-Discord.git
cd Alam-Bot-Discord
npm install
cp .env.example .env
nano .env            # BOT_TOKEN, GAS_WEB_APP_URL 입력

pm2 start index.js --name alam-bot
pm2 save
pm2 startup          # 출력된 sudo 명령어 복사·실행 (재부팅 자동 시작)
```

### 업데이트 배포

```bash
git pull origin main
npm install          # package.json 변경 시만
pm2 reload alam-bot
```

### pm2 주요 명령어

```bash
pm2 list                    # 프로세스 목록
pm2 logs alam-bot           # 실시간 로그
pm2 logs alam-bot --lines 200
pm2 monit                   # CPU/메모리 모니터
pm2 stop alam-bot
pm2 delete alam-bot
```

### Oracle Cloud 방화벽

```bash
# Oracle Security List + OS iptables 모두 개방 필요
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save
```

---

## 로컬 테스트 방법

### /webhook 테스트 (GAS → Bot 방향)

```powershell
# 기본 (ACK 단계, 작업자 DM 전송 테스트)
.\test-webhook.ps1

# PROGRESS / DONE 단계 테스트
.\test-webhook.ps1 -Stage PROGRESS
.\test-webhook.ps1 -Stage DONE

# REVIEW 단계 테스트 (검수자 DM)
.\test-webhook.ps1 -Stage REVIEW

# 특정 사용자 ID, row_id 지정
.\test-webhook.ps1 -DiscordUserId "1270201123218784312" -RowId "T-20260222-001"
```

### GAS doPost 테스트 (Bot → GAS 방향)

```powershell
# GAS_WEB_APP_URL을 환경변수로 미리 설정하면 편리합니다
$env:GAS_WEB_APP_URL = "https://script.google.com/macros/s/.../exec"

# 작업자 플로우
.\test-gas-callback.ps1 -GasUrl $env:GAS_WEB_APP_URL -Action ACCEPTED
.\test-gas-callback.ps1 -GasUrl $env:GAS_WEB_APP_URL -Action REJECTED
.\test-gas-callback.ps1 -GasUrl $env:GAS_WEB_APP_URL -Action IN_PROGRESS
.\test-gas-callback.ps1 -GasUrl $env:GAS_WEB_APP_URL -Action DONE

# 검수자 플로우
.\test-gas-callback.ps1 -GasUrl $env:GAS_WEB_APP_URL -Action REVIEW_START
.\test-gas-callback.ps1 -GasUrl $env:GAS_WEB_APP_URL -Action REVIEW_DONE
```

---

## 검증 체크리스트

GAS 배포 및 Bot 실행 후 아래 순서로 E2E 동작을 검증합니다.

```
[ ] 1. GAS: setupTriggers 수동 실행 → 권한 승인 팝업 허용
        확인: GAS 트리거 탭에서 scanPendingTasks(5분), checkNoResponse(10분) 목록 확인

[ ] 2. GAS: initSheet 수동 실행
        확인: batch_tasks 11행에 row_id, status, dm_sent_at 등 시스템 컬럼 추가됨

[ ] 3. GAS: logColMap 수동 실행
        확인: Logger에서 실제 colMap 키 목록 출력 → 예상 키와 비교

[ ] 4. GAS: scanPendingTasks 수동 실행
        전제: batch_tasks에 status=PENDING_ACK, assignee_real_name=directory에 있는 이름 행 존재
        확인: Bot /webhook 200 응답 → 작업자 Discord DM 도착 → status DM_SENT + deadline_ack 기록

[ ] 5. Discord: DM에서 ✅ 수락 클릭
        확인: GAS ACCEPTED 기록 + PROGRESS DM(▶️ 시작 버튼) 도착

[ ] 6. Discord: PROGRESS DM에서 ▶️ 시작 클릭
        확인: GAS IN_PROGRESS 기록 + DONE DM(🏁 완료 버튼) 도착

[ ] 7. Discord: DONE DM에서 🏁 완료 클릭 → done_note 모달 입력 후 제출
        확인: GAS DONE 기록 + done_note 시트 기록 + 검수자 REVIEW DM 자동 발송

[ ] 8. Discord: 검수자 REVIEW DM에서 🔍 검수 시작 클릭
        확인: GAS REVIEW_IN_PROGRESS 기록 + 검수자 셀 파란색

[ ] 9. Discord: 검수자 DM에서 ✅ 검수 완료 클릭
        확인: GAS REVIEW_DONE 기록 + 검수/종료일 기록

[ ] 10. REJECT 경로: DM에서 ❌ 거절 클릭 → 사유 입력 → 제출
        확인: GAS REJECTED 기록 + reject_reason 기록 + 작업자 셀 빨간색

[ ] 11. NO_RESPONSE 경로: deadline_ack를 과거 시각으로 수정 후 checkNoResponse 수동 실행
        확인: GAS NO_RESPONSE 기록 + retry_count 증가 + 작업자 셀 노란색

[ ] 12. 공지 채널 확인 (ANNOUNCE_CHANNEL_ID 설정 시):
        ACK 단계 DM 전송 시 공지 채널(1473144299146182891)에 배정 embed 게시됨
```

---

## Payload 스키마 참조

GAS → Bot `/webhook` 페이로드 및 Bot → GAS `doPost` 페이로드의 상세 필드와 예시 JSON은 [`docs/payloads.md`](docs/payloads.md)를 참조하세요.

시트 헤더 파싱 규칙 및 FIELD_CANDIDATES 전체 목록은 [`docs/sheet_schema.md`](docs/sheet_schema.md)를 참조하세요.

상태 전이 다이어그램 및 Action별 시트 업데이트 상세 표는 [`docs/state_machine.md`](docs/state_machine.md)를 참조하세요.
