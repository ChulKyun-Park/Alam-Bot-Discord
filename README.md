# Alam-Bot-Discord

번역 작업 배정 알림봇 — Google Sheets(GAS) + Discord.js E2E 완성본

---

## 변경 요약 (2026-02-22)

- **customId 규격 통일**: 모든 버튼/모달 ID를 `action:<row_id>` 형식으로 표준화
- **버튼 4종 완성**: ACCEPT / REJECT(모달 사유) / START / DONE(모달 메모)
- **postToGas 안정화**: AbortController 10초 타임아웃 + 1회 자동 재시도
- **ANNOUNCE_CHANNEL_ID 추가**: DM 전송 시 공지 채널에도 동시 게시 (선택)
- **GAS ensureExtraCols 확장**: doPost/checkNoResponse에서 사용하는 컬럼 전체 안전망 포함
- **GAS 헤더 기반 컬럼 매핑**: xlsx 헤더명과 Code.gs 문자열 전수 검증 완료 (docs/sheet_schema.md)
- **docs 추가**: `docs/sheet_schema.md`, `docs/payloads.md`
- **테스트 스크립트 2종**: `test-webhook.ps1`, `test-gas-callback.ps1`

---

## CK가 마지막에 채워야 할 값 (시크릿 포함)

### Bot `.env` 파일 (Oracle 서버)

```
# 필수 1: Discord Developer Portal → Bot → Reset Token
BOT_TOKEN=실제_봇_토큰

# 필수 2: GAS 배포 URL (아래 GAS 배포 절차 참고)
GAS_WEB_APP_URL=https://script.google.com/macros/s/{DEPLOYMENT_ID}/exec

# 선택: 공지 채널 (비워두면 비활성화)
ANNOUNCE_CHANNEL_ID=1473144299146182891

PORT=3000
```

### GAS Script Properties (GAS 편집기 → 프로젝트 설정 → 스크립트 속성)

| Property 키 | 값 |
|---|---|
| `SPREADSHEET_ID` | 스프레드시트 URL에서 `/d/` 뒤 문자열 |
| `DISCORD_WEBHOOK_URL` | `http://158.180.78.10:3000/webhook` |

> Script Properties는 GAS 내부에서만 참조되며 코드에 노출되지 않습니다.

---

## 시스템 아키텍처

```
[Google Sheets]
   PM이 batch_tasks 행 추가 (status=PENDING_ACK)
          │
          │ scanPendingTasks (5분 트리거)
          ▼
[GAS callBotWebhook]
   POST http://158.180.78.10:3000/webhook
          │
          ▼
[Discord Bot /webhook]
   작업자에게 DM (✅수락 / ❌거절 버튼)
   공지 채널 (ANNOUNCE_CHANNEL_ID) 에도 게시
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
   row_id로 행 검색 → status 업데이트

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
    ├─ [✅ 수락 클릭]  → ACCEPTED  → 봇이 PROGRESS DM 자동 발송 (▶️ 시작 버튼)
    │                      │  [▶️ 시작 클릭]  → IN_PROGRESS → 봇이 DONE DM 자동 발송 (🏁 완료 버튼)
    │                      │                       │  [🏁 완료 클릭 + done_note 모달]  → DONE
    │                      │                       └─────────────────────────────────────────
    │                      └──────────────────────────────────────────────────
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
│   ├── sheet_schema.md       xlsx 탭별 헤더 명세 + Code.gs 컬럼명 검증표
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
   - `DISCORD_WEBHOOK_URL` = `http://158.180.78.10:3000/webhook`
4. **배포 → 새 배포 → 웹앱**:
   - 실행 계정: **나 (Me)**
   - 액세스 권한: **모든 사용자 (Anyone)**
   - 배포 후 실행 URL을 복사 → Oracle 서버 `.env`의 `GAS_WEB_APP_URL` 에 입력
5. GAS 편집기에서 `ensureExtraCols` 함수를 **1회 수동 실행** (batch_tasks에 추가 컬럼 자동 생성)
6. `setupTriggers` 함수를 **1회 수동 실행** → 권한 승인 팝업 → 허용

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
# 기본 (ACK 단계, DM 전송 테스트)
.\test-webhook.ps1

# PROGRESS / DONE 단계 테스트
.\test-webhook.ps1 -Stage PROGRESS
.\test-webhook.ps1 -Stage DONE

# 특정 사용자 ID, row_id 지정
.\test-webhook.ps1 -DiscordUserId "1270201123218784312" -RowId "T-20260222-001"
```

### GAS doPost 테스트 (Bot → GAS 방향)

```powershell
# GAS_WEB_APP_URL을 환경변수로 미리 설정하면 편리합니다
$env:GAS_WEB_APP_URL = "https://script.google.com/macros/s/.../exec"

.\test-gas-callback.ps1 -GasUrl $env:GAS_WEB_APP_URL -Action ACCEPTED
.\test-gas-callback.ps1 -GasUrl $env:GAS_WEB_APP_URL -Action REJECTED
.\test-gas-callback.ps1 -GasUrl $env:GAS_WEB_APP_URL -Action IN_PROGRESS
.\test-gas-callback.ps1 -GasUrl $env:GAS_WEB_APP_URL -Action DONE
```

---

## 검증 체크리스트

GAS 배포 및 Bot 실행 후 아래 순서로 E2E 동작을 검증합니다.

```
[ ] 1. GAS: setupTriggers 수동 실행 → 권한 승인 팝업 허용
        확인: GAS 편집기 → 트리거 탭에서 scanPendingTasks(5분), checkNoResponse(10분) 목록 확인

[ ] 2. GAS: ensureExtraCols 수동 실행
        확인: batch_tasks 1행에 dm_sent_at, done_note, actor_discord_user_id 컬럼 추가됨

[ ] 3. GAS: scanPendingTasks 수동 실행
        전제: batch_tasks에 status=PENDING_ACK, assignee_real_name=directory에 있는 이름 행 존재
        확인: Bot /webhook 200 응답 → Discord DM 도착 → status 가 DM_SENT 로 변경 + deadline_ack 세팅

[ ] 4. Discord: DM에서 ✅ 수락 클릭
        확인: Bot이 GAS_WEB_APP_URL로 ACCEPTED POST → status ACCEPTED 변경 + PROGRESS DM 도착

[ ] 5. Discord: PROGRESS DM에서 ▶️ 시작 클릭
        확인: status IN_PROGRESS 변경 + DONE DM 도착

[ ] 6. Discord: DONE DM에서 🏁 완료 클릭 → done_note 모달 입력 후 제출
        확인: status DONE + done_note 시트 기록

[ ] 7. REJECT 경로: DM에서 ❌ 거절 클릭 → 사유 입력 → 제출
        확인: status REJECTED + reject_reason 시트 기록

[ ] 8. NO_RESPONSE 경로: deadline_ack를 과거 시각으로 수정 후 checkNoResponse 수동 실행
        확인: status NO_RESPONSE + retry_count 증가

[ ] 9. 공지 채널 확인 (ANNOUNCE_CHANNEL_ID 설정 시):
        DM 전송 시 공지 채널(1473144299146182891)에도 배정 embed 게시됨
```

---

## Payload 스키마 참조

자세한 payload 스키마(요청/응답 필드, 예시 JSON)는 [`docs/payloads.md`](docs/payloads.md) 참조.
시트 헤더 전수 검증표는 [`docs/sheet_schema.md`](docs/sheet_schema.md) 참조.
