# 시트 스키마 (Alam_Bot_Settings.xlsx 기준)

> 추출 일시: 2026-02-22
> 원본 파일: `Alam_Bot_Settings.xlsx`
> GAS Code.gs의 모든 컬럼명 문자열은 이 문서의 **Header 문자열**과 정확히 일치해야 합니다.

---

## 1. batch_tasks

작업 배정 원부. PM이 행을 추가하고, 봇과 GAS가 상태를 갱신합니다.

| # | Header 문자열 | 타입 | 입력 주체 | 설명 |
|---|---|---|---|---|
| A | `row_id` | string | PM 입력 or GAS 자동 | 행 고유 키. 비어 있으면 GAS가 `T-YYYYMMDD-NNN` 형식으로 자동 생성 |
| B | `project` | string | PM | 프로젝트명 (예: 라이선스 SUNDAY #65) |
| C | `language` | string | PM | 언어 코드 (예: KR, EN, CH, JP, ES, ID, TH) |
| D | `file_link` | string | PM | 번역 파일 Google Drive URL |
| E | `thread_link` | string | PM (선택) | 연관 스레드/이슈 링크 |
| F | `assignee_real_name` | string | PM | 담당자 실명 — `directory.real_name`과 정확히 일치해야 함 |
| G | `pm_real_name` | string | PM | PM 실명 |
| H | `status` | string | PM(초기값) / GAS | 상태값 (아래 상태 머신 참고) |
| I | `deadline_ack` | ISO string | GAS | DM 전송 시 설정하는 응답 마감 시각 (`now + 30분`) |
| J | `retry_count` | integer | GAS | NO_RESPONSE 발생 횟수 (초기: 0) |
| K | `reject_reason` | string | GAS | REJECT 모달에서 입력한 사유 |
| L | `created_at` | ISO string | PM | 행 생성 시각 (PM이 수동 입력 권장) |
| M | `last_event_at` | ISO string | GAS | 마지막 상태 변경 시각 (GAS가 매 상태 변경 시 갱신) |

### GAS가 자동 추가하는 컬럼 (ensureExtraCols)

신규 시트에 없을 경우 GAS가 최초 실행 시 헤더를 자동 생성합니다.

| Header 문자열 | 설명 |
|---|---|
| `dm_sent_at` | DM 전송 시각 (scanPendingTasks 기록) |
| `done_note` | 완료 메모 또는 파일 링크 (DONE 모달 입력) |
| `actor_discord_user_id` | 버튼을 클릭한 Discord 사용자 ID (18자리) |

### 상태 머신

```
PENDING_ACK
    │  scanPendingTasks → DM 전송 성공
    ▼
DM_SENT
    ├─ [ACCEPT 클릭]   → ACCEPTED
    │                        │  START 클릭
    │                        ▼
    │                   IN_PROGRESS
    │                        │  DONE 클릭
    │                        ▼
    │                      DONE
    ├─ [REJECT 클릭]   → REJECTED
    └─ [30분 경과]     → NO_RESPONSE  (retry_count++)
```

---

## 2. directory

작업자 디렉토리. `real_name` ↔ `discord_user_id` 매핑의 기준 탭입니다.

| # | Header 문자열 | 타입 | 설명 |
|---|---|---|---|
| A | `language` | string | 담당 언어 코드 |
| B | `human_id` | string | 내부 사용자 코드 (PM01, U001 등) |
| C | `real_name` | string | **매핑 키** — `batch_tasks.assignee_real_name`과 일치해야 함 |
| D | `email` | string | 이메일 |
| E | `discord_user_id` | string (18자리) | Discord 사용자 ID |
| F | `status` | string | `active` 또는 `inactive`. GAS는 `active`만 사용 |

**GAS 매핑 로직:** `directory.real_name → directory.discord_user_id` (status=active 필터)

### 등록 작업자 목록 (2026-02-22 기준)

| human_id | real_name | language | discord_user_id | status |
|---|---|---|---|---|
| PM01 | 유지원 | EN | 1422761729640632454 | active |
| PM02 | 허승희 | KR | 1465904281168117861 | active |
| PM03 | 김소원 | KR | 1383958340375412796 | active |
| U001 | 박륜규 | EN | 1465920892700850000 | active |
| U002 | 박혜성 | EN | 1245661465806110759 | active |
| U003 | 이동숙 | CH | 1102532843613208626 | active |
| U004 | 전연 | CH | 1164387491575513150 | active |
| U005 | 백상미 | JP | 812369909279490111 | active |
| U006 | 히토미 | JP | 1279329960586383412 | active |
| U007 | 문선영 | ES | 1101326741416448070 | active |
| U008 | 이민희 | ES | 1250983673390432267 | active |
| U009 | 이선미 | ES | 1346349293631574096 | active |
| U010 | 니다 | ID | 1239524671293227028 | active |
| U011 | 클라리사 | ID | 1347034507534008372 | active |
| U012 | 프랑나파 | TH | 1281593226003746911 | active |
| U013 | 사와락 | TH | 1271696178508988429 | active |

---

## 3. routing

언어별 배정 우선순위 및 쿨다운 설정.

| # | Header 문자열 | 타입 | 설명 |
|---|---|---|---|
| A | `language` | string | 언어 코드 |
| B | `human_id` | string | 사용자 코드 |
| C | `real_name` | string | 실명 |
| D | `weight` | integer | 배정 우선순위 (낮을수록 우선) |
| E | `cooldown_minutes` | integer | 연속 배정 대기 시간(분) |
| F | `active` | boolean | 활성 여부 |

---

## 4. availability

작업자별 가용 시간대.

| # | Header 문자열 | 타입 | 설명 |
|---|---|---|---|
| A | `language` | string | 언어 코드 |
| B | `human_id` | string | 사용자 코드 |
| C | `real_name` | string | 실명 |
| D | `timezone` | string | 시간대 (예: `Asia/Seoul`) |
| E | `days_of_week` | string | 가용 요일 (쉼표 구분, 예: `Mon, Tue, Wed`) |
| F | `start_time` | time string | 시작 시각 (`HH:MM:SS`) |
| G | `end_time` | time string | 종료 시각 (`HH:MM:SS`) |
| H | `active` | boolean | 활성 여부 |

---

## Code.gs 컬럼명 일치 검증

아래는 Code.gs에서 사용하는 컬럼명과 xlsx 실제 헤더의 대조표입니다.

| Code.gs에서 사용하는 문자열 | xlsx 실제 헤더 | 일치 여부 |
|---|---|---|
| `"row_id"` | `row_id` | ✅ |
| `"project"` | `project` | ✅ |
| `"language"` | `language` | ✅ |
| `"file_link"` | `file_link` | ✅ |
| `"thread_link"` | `thread_link` | ✅ |
| `"assignee_real_name"` | `assignee_real_name` | ✅ |
| `"pm_real_name"` | `pm_real_name` | ✅ |
| `"status"` | `status` | ✅ |
| `"deadline_ack"` | `deadline_ack` | ✅ |
| `"retry_count"` | `retry_count` | ✅ |
| `"reject_reason"` | `reject_reason` | ✅ |
| `"created_at"` | `created_at` | ✅ |
| `"last_event_at"` | `last_event_at` | ✅ |
| `"dm_sent_at"` | *(GAS 자동 추가)* | ✅ |
| `"done_note"` | *(GAS 자동 추가)* | ✅ |
| `"actor_discord_user_id"` | *(GAS 자동 추가)* | ✅ |
| directory: `"real_name"` | `real_name` | ✅ |
| directory: `"discord_user_id"` | `discord_user_id` | ✅ |
| directory: `"status"` | `status` | ✅ |
