# API Payload 스키마

번역 배정 알림봇의 두 방향 통신 payload를 정의합니다.

---

## 방향 1: GAS → Bot (`POST /webhook`)

GAS의 `callBotWebhook()` 또는 `scanPendingTasks()`가 Discord Bot의 `/webhook` 엔드포인트를 호출하여 DM 전송을 요청합니다.

### 엔드포인트

```
POST http://158.180.78.10:3000/webhook
Content-Type: application/json
```

### Request Body

```jsonc
{
  "row_id"             : "T-20260222-001",    // batch_tasks.row_id (필수)
  "discord_user_id"    : "1465904281168117861", // directory.discord_user_id (필수, 18자리)
  "assignee_real_name" : "홍길동",              // batch_tasks.assignee_real_name
  "project"            : "라이선스 SUNDAY #65", // batch_tasks.project
  "language"           : "한국어",              // batch_tasks.language
  "file_link"          : "https://drive.google.com/file/d/...", // batch_tasks.file_link
  "pm_real_name"       : "이수민",              // batch_tasks.pm_real_name
  "stage"              : "ACK"                 // "ACK" | "PROGRESS" | "DONE"
}
```

### `stage` 값과 표시 버튼

| stage | 표시 버튼 | 설명 |
|---|---|---|
| `"ACK"` | ✅ 수락 / ❌ 거절 | 최초 배정 시 |
| `"PROGRESS"` | ▶️ 시작 | 수락 후 작업 시작 안내 |
| `"DONE"` | 🏁 완료 | 시작 후 완료 처리 안내 |

### Response

```jsonc
// 성공
{ "ok": true }

// 실패
{ "ok": false, "error": "오류 메시지" }
```

### 오류 코드

| HTTP | 의미 |
|---|---|
| 200 | 성공 |
| 400 | `row_id` 또는 `discord_user_id` 누락 |
| 500 | Discord API 오류 (DM 전송 실패) |

---

## 방향 2: Bot → GAS (`POST GAS_WEB_APP_URL`)

Discord Bot이 버튼 클릭 또는 모달 제출 결과를 GAS `doPost()` 로 전송합니다.

### 엔드포인트

```
POST https://script.google.com/macros/s/{DEPLOYMENT_ID}/exec
Content-Type: application/json
```

### Request Body (공통 필드)

```jsonc
{
  "row_id"               : "T-20260222-001",    // 필수: batch_tasks.row_id
  "action"               : "ACCEPTED",           // 필수: 아래 action 목록 참조
  "actor_discord_user_id": "1270201123218784312" // 필수: 버튼 클릭자 Discord ID
}
```

### action별 추가 필드

| action | 추가 필드 | 설명 |
|---|---|---|
| `"ACCEPTED"` | *(없음)* | 수락 버튼 클릭 |
| `"REJECTED"` | `"reject_reason": "사유 텍스트"` | 거절 모달 제출 |
| `"IN_PROGRESS"` | *(없음)* | 시작 버튼 클릭 |
| `"DONE"` | `"done_note": "메모 또는 링크"` | 완료 모달 제출 (선택 필드) |

### 예시: ACCEPTED

```json
{
  "row_id"               : "T-20260222-001",
  "action"               : "ACCEPTED",
  "actor_discord_user_id": "1270201123218784312"
}
```

### 예시: REJECTED

```json
{
  "row_id"               : "T-20260222-001",
  "action"               : "REJECTED",
  "reject_reason"        : "다른 프로젝트 마감이 겹쳐 불가합니다",
  "actor_discord_user_id": "1270201123218784312"
}
```

### 예시: DONE

```json
{
  "row_id"               : "T-20260222-001",
  "action"               : "DONE",
  "done_note"            : "번역 완료. QA 검토 요청드립니다: https://drive.google.com/...",
  "actor_discord_user_id": "1270201123218784312"
}
```

### Response (GAS doPost)

```jsonc
// 성공
{ "ok": true, "row_id": "T-20260222-001", "action": "ACCEPTED" }

// 실패
{ "ok": false, "error": "오류 메시지" }
```

---

## customId 규격 (Discord 버튼/모달)

모든 버튼과 모달의 `customId`는 `<action>:<row_id>` 형식입니다.

| customId 예시 | 종류 | 연결 action |
|---|---|---|
| `accept:T-20260222-001` | 버튼 | `ACCEPTED` |
| `reject:T-20260222-001` | 버튼 → 모달 트리거 | — |
| `start:T-20260222-001` | 버튼 | `IN_PROGRESS` |
| `done:T-20260222-001` | 버튼 → 모달 트리거 | — |
| `rejectModal:T-20260222-001` | 모달 | `REJECTED` |
| `doneModal:T-20260222-001` | 모달 | `DONE` |

---

## 봇 자동 DM 흐름

버튼 클릭 시 봇이 자동으로 다음 단계 DM을 전송합니다. GAS를 거치지 않고 봇 내부에서 처리합니다.

```
수락(accept) 클릭
  → GAS: ACCEPTED
  → Bot: 동일 사용자에게 PROGRESS DM (▶️ 시작 버튼 포함)

시작(start) 클릭
  → GAS: IN_PROGRESS
  → Bot: 동일 사용자에게 DONE DM (🏁 완료 버튼 포함)
```
