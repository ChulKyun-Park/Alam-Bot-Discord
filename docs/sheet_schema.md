# 관리 시트 스키마 (sheet_schema.md)

> 대상 스프레드시트 ID: `166o1GSu7FhWpK-yKDPOzN7xOyfgQRewriWU8WqdoxwI`
> 최종 수정: 2026-02-22

---

## 1. 시트 구조 개요

| 항목 | 값 |
|---|---|
| 헤더 상위 행 | **10행** (부모 헤더, 일부 병합) |
| 헤더 하위 행 | **11행** (자식 헤더, 모든 컬럼) |
| 데이터 시작 행 | **12행** 이후 (행 추가 시 아래로 쌓임) |
| 행 식별자 | `row_id` (GAS가 시스템 컬럼으로 자동 추가/관리) |

> **운영 주의**: 새 작업은 아래에 추가되고 과거 데이터는 위로 밀린다. 행 번호/셀 주소를 영구 ID로 사용하면 절대 안 된다. 반드시 `row_id`로 행을 찾아야 한다.

---

## 2. 헤더 파싱 규칙 (10~11행 Flatten)

### 2-1. 기본 규칙

```
colMap 키 = flatten(row10[c], row11[c])
```

| row10[c] 상태 | row11[c] 상태 | 생성 키 | 예시 |
|---|---|---|---|
| 비어 있음 | 값 있음 | `row11[c]` | `언어` |
| 값 있음 (해당 열이 merged section의 시작) | 값 있음 | `row10[c]/row11[c]` | `작업/작업자` |
| 값 있음 (merged section 내 빈 칸) | 값 있음 | `carry_forward/row11[c]` | `작업/시작일` |
| 값 있음 | 비어 있음 | `row10[c]` | (단독 부모) |
| 둘 다 비어 있음 | — | 스킵 | — |

### 2-2. Merged Cell(병합 셀) 처리

`getMergedRanges()`를 사용해 10행의 병합 영역을 파악하고, 해당 열 범위 전체에 부모값을 적용한다.

```javascript
// GAS 내부 buildColMap() 구현 원칙
var mergedRanges = sheet.getRange(10, 1, 1, lastCol).getMergedRanges();
// 각 mergedRange.getColumn()~getLastColumn() 범위에 row10 첫 셀 값을 부모로 설정
```

### 2-3. 키 정규화 규칙

- `trim()` — 앞뒤 공백 제거
- `replace(/\s+/g, " ")` — 내부 연속 공백을 단일 공백으로 치환
- 중복 키 발생 시: GAS Logger에 경고 출력 + 뒤에 오는 컬럼은 `{key}_2`, `{key}_3`으로 suffix

### 2-4. 실제 키 확인 방법

GAS 편집기에서 `logColMap()` 함수를 수동 실행하면 Logger에 전체 colMap이 출력된다.

```
[logColMap] 관리 시트 colMap:
  언어 → 열 2 (C)
  작업/작업자 → 열 5 (F)
  작업/시작일 → 열 6 (G)
  ...
```

---

## 3. 예상 컬럼 구조 (사용자 설명 기준)

> **주의**: 아래는 설명 기반 추정 구조다. 실제 키는 `logColMap()` 실행 결과를 기준으로 한다.

### 업무 컬럼 (원본 시트에 존재)

| 예상 colMap 키 | 설명 | row10 부모 | row11 자식 |
|---|---|---|---|
| `언어` | 언어 코드 (한국어 / 영어 / 일본어 등) | (없음) | 언어 |
| `작업/작업자` | 번역 담당자 실명 | 작업 | 작업자 |
| `작업/시작일` | 작업 시작일 (START 버튼 클릭일) | 작업 | 시작일 |
| `작업/종료일` | 작업 종료일 (DONE 버튼 클릭일) | 작업 | 종료일 |
| `작업/진행상황` | 작업 진행 표시 텍스트 | 작업 | 진행상황 |
| `검수/검수자` | 검수 담당자 실명 | 검수 | 검수자 |
| `검수/시작일` | 검수 시작일 (REVIEW_START 버튼 클릭일) | 검수 | 시작일 |
| `검수/종료일` | 검수 종료일 (REVIEW_DONE 버튼 클릭일) | 검수 | 종료일 |
| `검수/진행상황` | 검수 진행 표시 텍스트 | 검수 | 진행상황 |

### FIELD_CANDIDATES (복수 후보 매핑)

GAS는 아래 후보 목록을 순서대로 시도해 처음 일치하는 키를 사용한다. 실제 키가 예상과 다를 경우 여기에 후보를 추가한다.

| FIELD 상수 | 후보 키 목록 (우선순위 순) |
|---|---|
| `TASK_ASSIGNEE` | `작업/작업자`, `작업자`, `번역/번역자`, `담당자` |
| `TASK_START_DATE` | `작업/시작일`, `작업/작업시작일`, `작업시작일`, `번역/시작일` |
| `TASK_END_DATE` | `작업/종료일`, `작업/작업종료일`, `작업종료일`, `번역/종료일` |
| `TASK_STATUS` | `작업/진행상황`, `작업/상태`, `진행상황` |
| `REVIEW_ASSIGNEE` | `검수/검수자`, `검수자` |
| `REVIEW_START_DATE` | `검수/시작일`, `검수/검수시작일`, `검수시작일` |
| `REVIEW_END_DATE` | `검수/종료일`, `검수/검수종료일`, `검수종료일` |
| `REVIEW_STATUS` | `검수/진행상황`, `검수/상태` |
| `LANGUAGE` | `언어`, `Language`, `lang` |
| `PROJECT` | `프로젝트`, `project`, `Project`, `작업명` |
| `FILE_LINK` | `파일 링크`, `file_link`, `Google Drive`, `링크` |
| `PM_NAME` | `pm_real_name`, `PM`, `담당PM`, `관리자` |

---

## 4. 시스템 컬럼 (GAS가 자동 추가)

GAS `ensureExtraCols()` 실행 시 아래 컬럼이 없으면 시트 **오른쪽 끝**에 자동 추가된다. 추가 위치는 **11행**(자식 헤더 행)이며, 10행은 비워 둔다.

| 컬럼명 | 설명 | 자동 추가 여부 |
|---|---|---|
| `row_id` | 행 고유 식별자 (UUID 기반, 불변) | ✅ `ensureRowIdCol()` |
| `status` | 내부 봇 상태코드 | ✅ |
| `dm_sent_at` | DM 전송 시각 (ISO) | ✅ |
| `deadline_ack` | 응답 마감 시각 (ISO, now+30분) | ✅ |
| `last_event_at` | 마지막 상태 변경 시각 (ISO) | ✅ |
| `retry_count` | NO_RESPONSE 발생 횟수 | ✅ |
| `reject_reason` | 거절 사유 (모달 입력) | ✅ |
| `done_note` | 완료 메모 (모달 입력) | ✅ |
| `actor_discord_user_id` | 버튼 클릭자 Discord ID | ✅ |

**row_id 특성:**
- 형식: `T-YYYYMMDD-XXXXXXXX` (예: `T-20260222-A3F5B2C1`)
- 생성: `Utilities.getUuid()` 앞 8자 (대문자) + 날짜 접두사
- 불변: 한 번 생성된 후 절대 덮어쓰지 않음
- 숨김: `ensureRowIdCol()` 실행 후 GAS가 자동 열 숨김 처리

---

## 5. Directory 탭 헤더 (행 1 기준, 표준)

| 컬럼명 | 설명 |
|---|---|
| `language` | 담당 언어 코드 |
| `human_id` | 내부 사용자 코드 |
| `real_name` | 실명 (관리 시트 작업자/검수자 이름과 일치해야 함) |
| `email` | 이메일 |
| `discord_user_id` | Discord 18자리 ID |
| `status` | `active` / `inactive` |

---

## 6. 색상 규칙

| 이벤트 | 대상 셀 | 색상 | RGB |
|---|---|---|---|
| ACCEPTED | 작업자 셀 | 파란색 | `#4472C4` |
| REVIEW_START | 검수자 셀 | 파란색 | `#4472C4` |
| REJECTED | 작업자 셀 | 빨간색 | `#E06666` |
| NO_RESPONSE | 작업자 셀 | 노란색 | `#FFD966` |
| (초기/미확정) | 작업자/검수자 셀 | 흰색 | `#FFFFFF` |

**구현 방식**: GAS `setCellBg()` 직접 호출 (조건부 서식이 아닌 직접 setBackground).
- **유지보수 리스크**: GAS가 열을 삽입/이동하면 배경색이 의도치 않은 셀에 남을 수 있다. 색상 재설정이 필요하면 `resetBackground()` 함수를 수동 실행하거나, 미래에 조건부 서식으로 마이그레이션 권장.

---

## 7. 언어별 진행상황 표시 텍스트

| 내부 action | 언어=한국어 (원문 작업) | 언어=한국어 外 (번역) |
|---|---|---|
| ACCEPTED / START | `작업중` | `번역중` |
| DONE | `작업 완료` | `번역 완료` |
| REVIEW_START | `검수중` | `검수중` |
| REVIEW_DONE | `검수 완료` | `검수 완료` |

판별 로직: `언어.includes("한국어") || 언어 === "KO"` → 원문, 그 외 → 번역
