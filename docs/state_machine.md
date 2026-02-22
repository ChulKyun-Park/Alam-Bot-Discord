# 상태 머신 (state_machine.md)

> 봇 action → 시트 업데이트 규칙 전체 정의
> Asia/Seoul 기준 날짜 기록 (`Utilities.formatDate(..., "Asia/Seoul", "yyyy-MM-dd")`)

---

## 1. 상태 전이 다이어그램

```
                    PM이 행 추가
                         │  status = PENDING_ACK
                         ▼
              ┌──────────────────────┐
              │  PENDING_ACK         │  dm_sent_at 비어있음
              └──────────────────────┘
                         │  scanPendingTasks (5분) → DM 전송 성공
                         │  status=DM_SENT, dm_sent_at=now, deadline_ack=now+30m
                         ▼
              ┌──────────────────────┐
              │  DM_SENT             │
              └──────────────────────┘
         ┌────┴─────────────────────────────────────┐
         │                                          │
  [✅ ACCEPT 버튼]                          [❌ REJECT 버튼+모달]
  status=ACCEPTED                           status=REJECTED
  작업자 셀=파란색                            작업자 셀=빨간색
  작업/진행상황=작업중/번역중                  reject_reason 기록
         │
  [▶️ START 버튼]
  status=IN_PROGRESS
  작업/시작일=오늘
  작업/진행상황=작업중/번역중
         │
  [🏁 DONE 버튼+메모]
  status=DONE
  작업/종료일=오늘
  작업/진행상황=작업 완료/번역 완료
  done_note 기록
  → 검수자에게 자동 DM (REVIEW 단계)
         │
  [🔍 REVIEW_START 버튼]
  status=REVIEW_IN_PROGRESS
  검수/시작일=오늘
  검수자 셀=파란색
  검수/진행상황=검수중
         │
  [✅ REVIEW_DONE 버튼]
  status=REVIEW_DONE
  검수/종료일=오늘
  검수/진행상황=검수 완료

         │ (DM_SENT 상태에서 30분 경과)
  [checkNoResponse 10분 트리거]
  status=NO_RESPONSE
  작업자 셀=노란색
  retry_count++
```

---

## 2. Action별 업데이트 상세 표

### ACCEPTED (수락)

| 업데이트 대상 | 값 |
|---|---|
| `status` | `ACCEPTED` |
| `작업/진행상황` | `작업중` (한국어) / `번역중` (다국어) |
| 작업자 셀 배경색 | `#4472C4` (파란색) |
| `actor_discord_user_id` | 클릭자 Discord ID |
| `last_event_at` | 현재 ISO 타임스탬프 |

### REJECTED (거절)

| 업데이트 대상 | 값 |
|---|---|
| `status` | `REJECTED` |
| `reject_reason` | 모달 입력값 |
| 작업자 셀 배경색 | `#E06666` (빨간색) |
| `actor_discord_user_id` | 클릭자 Discord ID |
| `last_event_at` | 현재 ISO 타임스탬프 |

### IN_PROGRESS (START 버튼)

| 업데이트 대상 | 값 |
|---|---|
| `status` | `IN_PROGRESS` |
| `작업/시작일` | 오늘 날짜 (Asia/Seoul, `yyyy-MM-dd`) |
| `작업/진행상황` | `작업중` (한국어) / `번역중` (다국어) |
| `actor_discord_user_id` | 클릭자 Discord ID |
| `last_event_at` | 현재 ISO 타임스탬프 |

### DONE (완료)

| 업데이트 대상 | 값 |
|---|---|
| `status` | `DONE` |
| `작업/종료일` | 오늘 날짜 (Asia/Seoul, `yyyy-MM-dd`) |
| `작업/진행상황` | `작업 완료` (한국어) / `번역 완료` (다국어) |
| `done_note` | 모달 입력값 (선택) |
| `actor_discord_user_id` | 클릭자 Discord ID |
| `last_event_at` | 현재 ISO 타임스탬프 |
| (사이드 이펙트) | 검수자 discord_user_id 조회 → Bot `/webhook` REVIEW DM 자동 발송 |

### REVIEW_START (검수 시작)

| 업데이트 대상 | 값 |
|---|---|
| `status` | `REVIEW_IN_PROGRESS` |
| `검수/시작일` | 오늘 날짜 (Asia/Seoul) |
| `검수/진행상황` | `검수중` |
| 검수자 셀 배경색 | `#4472C4` (파란색) |
| `actor_discord_user_id` | 클릭자 Discord ID |
| `last_event_at` | 현재 ISO 타임스탬프 |

### REVIEW_DONE (검수 완료)

| 업데이트 대상 | 값 |
|---|---|
| `status` | `REVIEW_DONE` |
| `검수/종료일` | 오늘 날짜 (Asia/Seoul) |
| `검수/진행상황` | `검수 완료` |
| `actor_discord_user_id` | 클릭자 Discord ID |
| `last_event_at` | 현재 ISO 타임스탬프 |

### NO_RESPONSE (자동, 30분 무응답)

| 업데이트 대상 | 값 |
|---|---|
| `status` | `NO_RESPONSE` |
| 작업자 셀 배경색 | `#FFD966` (노란색) |
| `retry_count` | 기존값 + 1 |
| `last_event_at` | 현재 ISO 타임스탬프 |

---

## 3. 전체 상태 코드 목록

| status 코드 | 의미 |
|---|---|
| `PENDING_ACK` | PM이 행 추가, DM 미전송 |
| `DM_SENT` | DM 전송 완료, 응답 대기 중 |
| `ACCEPTED` | 작업자 수락 |
| `REJECTED` | 작업자 거절 |
| `IN_PROGRESS` | 작업 시작 |
| `DONE` | 작업 완료 |
| `REVIEW_IN_PROGRESS` | 검수 시작 |
| `REVIEW_DONE` | 검수 완료 |
| `NO_RESPONSE` | 30분 내 무응답 |

---

## 4. Discord customId 규격

| customId | 발생 위치 | 처리 action |
|---|---|---|
| `accept:<row_id>` | 작업자 DM | `ACCEPTED` |
| `reject:<row_id>` | 작업자 DM | → reject 모달 → `REJECTED` |
| `start:<row_id>` | 작업자 DM (PROGRESS) | `IN_PROGRESS` |
| `done:<row_id>` | 작업자 DM (DONE) | → done 모달 → `DONE` |
| `review_start:<row_id>` | 검수자 DM | `REVIEW_START` |
| `review_done:<row_id>` | 검수자 DM | `REVIEW_DONE` |
| `rejectModal:<row_id>` | 모달 | `REJECTED` |
| `doneModal:<row_id>` | 모달 | `DONE` |

---

## 5. Bot → GAS Payload 표준 (전체)

```json
{
  "row_id"               : "T-20260222-A3F5B2C1",
  "action"               : "ACCEPTED | REJECTED | IN_PROGRESS | DONE | REVIEW_START | REVIEW_DONE",
  "reject_reason"        : "거절 사유 (REJECTED만)",
  "done_note"            : "완료 메모/링크 (DONE만, 선택)",
  "actor_discord_user_id": "1270201123218784312"
}
```

---

## 6. 진행상황 표시 텍스트 결정 로직

```javascript
function getTaskStatusText(language, action) {
  var isKorean = language.indexOf("한국어") !== -1 || language === "KO";
  switch (action) {
    case "ACCEPTED":
    case "IN_PROGRESS": return isKorean ? "작업중"    : "번역중";
    case "DONE":        return isKorean ? "작업 완료" : "번역 완료";
    case "REVIEW_START": return "검수중";
    case "REVIEW_DONE":  return "검수 완료";
    default:             return "";
  }
}
```
