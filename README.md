# Alam-Bot-Discord

번역 작업 배정 알림봇 — Google Sheets(GAS) + Discord.js E2E 완성본

---

## 탭 구조 요약 (Alam_Bot_Settings.xlsx)

### batch_tasks — 작업 배정 원부

| 컬럼명 | 설명 | PM 입력 | 봇 자동 기록 |
|---|---|---|---|
| `row_id` | 행 고유 키 (비워두면 GAS가 자동 생성) | 선택 | ✅ 자동 생성 |
| `project` | 프로젝트명 | ✅ | |
| `language` | 언어 코드 (KR, EN, CH, JP, ES, ID, TH) | ✅ | |
| `file_link` | 번역 파일 Google Drive 링크 | ✅ | |
| `thread_link` | 스레드 링크 (선택) | ✅ | |
| `assignee_real_name` | 담당자 실명 (directory.real_name과 일치해야 함) | ✅ | |
| `pm_real_name` | PM 실명 | ✅ | |
| `status` | 상태값 (초기값: `PENDING_ACK`) | ✅ 초기 | ✅ 갱신 |
| `deadline_ack` | DM 전송 후 응답 마감 시각 (ISO) | | ✅ |
| `retry_count` | 무응답 횟수 | | ✅ |
| `reject_reason` | 거절 사유 (모달 입력) | | ✅ |
| `created_at` | 행 생성 시각 (PM 입력 권장) | ✅ | |
| `last_event_at` | 마지막 상태 변경 시각 | | ✅ |
| `dm_sent_at` | DM 전송 시각 (**GAS가 자동 추가**) | | ✅ |
| `done_note` | 완료 메모 (**GAS가 자동 추가**) | | ✅ |
| `actor_discord_user_id` | 버튼 클릭자 Discord ID (**GAS가 자동 추가**) | | ✅ |

> `dm_sent_at`, `done_note`, `actor_discord_user_id` 3개 컬럼은 GAS `ensureExtraCols()`가 최초 실행 시 자동으로 헤더를 추가합니다.

**row_id 전략:** 열을 비워두면 GAS가 `T-YYYYMMDD-{행번호}` 형식으로 자동 생성합니다. PM이 직접 입력해도 무방하나 시트 내 고유해야 합니다.

---

### directory — 작업자 디렉토리 (실명 ↔ Discord ID 매핑)

| 컬럼명 | 설명 |
|---|---|
| `language` | 담당 언어 |
| `human_id` | 내부 사용자 코드 (PM01, U001 등) |
| `real_name` | 실명 (`batch_tasks.assignee_real_name`과 동일해야 함) |
| `email` | 이메일 |
| `discord_user_id` | Discord 18자리 숫자 ID |
| `status` | `active` / `inactive` |

---

### routing — 배정 우선순위 및 쿨다운

| 컬럼명 | 설명 |
|---|---|
| `language` | 언어 |
| `human_id` | 사용자 코드 |
| `real_name` | 실명 |
| `weight` | 우선순위 가중치 (낮을수록 우선) |
| `cooldown_minutes` | 연속 배정 대기 시간(분) |
| `active` | 활성 여부 |

---

### availability — 작업자 가용 시간

| 컬럼명 | 설명 |
|---|---|
| `language` | 언어 |
| `human_id` | 사용자 코드 |
| `real_name` | 실명 |
| `timezone` | 시간대 (예: `Asia/Seoul`) |
| `days_of_week` | 가용 요일 (쉼표 구분) |
| `start_time` | 시작 시각 (`HH:MM:SS`) |
| `end_time` | 종료 시각 (`HH:MM:SS`) |
| `active` | 활성 여부 |

---

## 상태 흐름

```
PM이 행 추가
    │
    ▼  (status = PENDING_ACK)
scanPendingTasks (5분)
    │  Discord DM 전송 (✅수락 / ❌거절 버튼)
    ▼  (status = DM_SENT, deadline_ack 설정)
    │
    ├─ [✅ 수락 클릭] ─────────────────────→ ACCEPTED
    │                                            │ 봇이 ▶️시작 버튼 DM 전송
    │                                            ▼ (status = IN_PROGRESS)
    │                                            │ 봇이 🏁완료 버튼 DM 전송
    │                                            ▼ (status = DONE)
    │
    ├─ [❌ 거절 클릭 + 사유 모달] ──────────→ REJECTED
    │
    └─ [무응답 → deadline_ack 초과] ─────→ NO_RESPONSE
           checkNoResponse (10분)           retry_count++
```

---

## 시스템 아키텍처

```
Google Sheets (GAS)
  ├─ scanPendingTasks()  [5분 트리거]
  │     → POST /webhook  (DM 전송 요청)
  │
  └─ doPost()  [GAS 웹앱]
        ← POST GAS_WEB_APP_URL  (버튼 결과 수신, 시트 업데이트)

Discord Bot (Node.js / discord.js)
  ├─ /webhook   GAS → Bot  (DM 발송)
  ├─ /healthz   상태 확인
  └─ InteractionCreate
        accept → GAS doPost + 시작 버튼 DM
        reject → 거절 모달 → GAS doPost
        start  → GAS doPost + 완료 버튼 DM
        done   → 완료 메모 모달 → GAS doPost
```

---

## Interaction customId 규격

모든 버튼과 모달의 customId는 `<action>:<row_id>` 형식을 따릅니다.

| customId 예시 | 설명 |
|---|---|
| `accept:T-20260222-001` | 수락 버튼 |
| `reject:T-20260222-001` | 거절 버튼 |
| `start:T-20260222-001` | 시작 버튼 |
| `done:T-20260222-001` | 완료 버튼 |
| `rejectModal:T-20260222-001` | 거절 사유 모달 |
| `doneModal:T-20260222-001` | 완료 메모 모달 |

---

## Payload 스키마

### GAS → Bot  (`POST /webhook`)

```json
{
  "row_id"             : "T-20260222-001",
  "discord_user_id"    : "1465904281168117861",
  "assignee_real_name" : "홍길동",
  "project"            : "라이선스 SUNDAY #65",
  "language"           : "한국어",
  "file_link"          : "https://drive.google.com/file/d/...",
  "pm_real_name"       : "이수민",
  "stage"              : "ACK"
}
```

`stage` 값: `"ACK"` (수락/거절) | `"PROGRESS"` (시작) | `"DONE"` (완료)

### Bot → GAS  (`POST GAS_WEB_APP_URL`)

```json
{
  "row_id"               : "T-20260222-001",
  "action"               : "ACCEPTED",
  "reject_reason"        : "일정 충돌",
  "done_note"            : "번역 완료, QA 필요",
  "actor_discord_user_id": "1465904281168117861"
}
```

`action` 값: `ACCEPTED` | `REJECTED` | `IN_PROGRESS` | `DONE`

---

## CK가 마지막에 채워야 할 시크릿 3가지

### 1. `BOT_TOKEN` — Discord Bot 토큰 (`.env` 파일)

```
BOT_TOKEN=실제토큰값
```

발급 경로: [Discord Developer Portal](https://discord.com/developers/applications) → 앱 선택 → **Bot** → **Reset Token**

### 2. `GAS_WEB_APP_URL` — GAS doPost 엔드포인트 (`.env` 파일)

```
GAS_WEB_APP_URL=https://script.google.com/macros/s/{DEPLOYMENT_ID}/exec
```

발급 경로: GAS 편집기 → **배포** → **새 배포** → 종류: **웹앱** → 실행 계정: **나** → 액세스: **모든 사용자** → 배포 → URL 복사

### 3. `DISCORD_WEBHOOK_URL` — Bot의 /webhook 엔드포인트 (GAS Script Properties)

```
DISCORD_WEBHOOK_URL=https://your-oracle-server.com:3000/webhook
```

설정 경로: GAS 편집기 → **프로젝트 설정** → **스크립트 속성** → 속성 추가

> 이 값은 Oracle 서버의 공인 IP 또는 도메인 + 포트입니다. `SPREADSHEET_ID`도 함께 등록하세요.

---

## GAS 배포 절차

1. [Google Apps Script](https://script.google.com)에서 새 프로젝트 생성
2. `gas/Code.gs` 전체 내용을 붙여넣고 저장
3. **프로젝트 설정** → **스크립트 속성** 에 두 개 등록:
   - `SPREADSHEET_ID` = 스프레드시트 URL에서 `/d/` 뒤 문자열
   - `DISCORD_WEBHOOK_URL` = `https://your-server.com:3000/webhook`
4. **배포** → **새 배포** → 웹앱 → 실행: 나, 액세스: 모든 사용자 → 배포 → URL 복사 → `.env`의 `GAS_WEB_APP_URL`에 입력
5. GAS 편집기에서 `ensureExtraCols` 함수를 1회 실행 (batch_tasks에 추가 컬럼 자동 생성)
6. `setupTriggers` 함수를 1회 실행 (5분/10분 트리거 등록)

---

## Oracle 서버 pm2 배포 절차

### 사전 요건

```bash
# Node.js 18 이상 확인
node -v

# pm2 전역 설치
npm install -g pm2
```

### 최초 배포

```bash
# 1. 레포 클론
git clone https://github.com/YOUR_ORG/Alam-Bot-Discord.git
cd Alam-Bot-Discord

# 2. 의존성 설치
npm install

# 3. 환경변수 파일 생성
cp .env.example .env
nano .env          # BOT_TOKEN, GAS_WEB_APP_URL, PORT 입력

# 4. pm2로 실행 (재부팅 후에도 자동 시작)
pm2 start index.js --name alam-bot
pm2 save
pm2 startup        # 출력된 sudo 명령어 복사·실행
```

### 업데이트 배포

```bash
git pull origin main
npm install        # 패키지 변경 시만
pm2 reload alam-bot
```

### 주요 pm2 명령어

```bash
pm2 list                   # 프로세스 목록
pm2 logs alam-bot          # 실시간 로그
pm2 logs alam-bot --lines 100   # 최근 100줄
pm2 monit                  # CPU/메모리 모니터
pm2 stop alam-bot          # 중지
pm2 delete alam-bot        # 삭제
```

### 방화벽 (Oracle Cloud)

```bash
# Oracle Security List + OS iptables 모두 열어야 합니다
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save
```

---

## 로컬 테스트

```powershell
# PowerShell에서 실행 (Node 서버가 3000포트에서 실행 중이어야 함)
.\test-webhook.ps1

# stage를 바꿔서 테스트
.\test-webhook.ps1 -Stage PROGRESS
.\test-webhook.ps1 -Stage DONE
```

---

## 파일 구조

```
Alam-Bot-Discord/
├── index.js              Discord Bot + Express 서버
├── gas/
│   └── Code.gs           Google Apps Script 전체 코드
├── .env.example          환경변수 템플릿 (시크릿 제외)
├── .env                  실제 환경변수 (gitignore됨)
├── test-webhook.ps1      /webhook 로컬 테스트 스크립트
├── package.json
└── README.md
```
