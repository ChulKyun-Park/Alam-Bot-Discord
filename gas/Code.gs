// ═══════════════════════════════════════════════════════════════════════════
// Alam Translation Bot — Google Apps Script  v3.0
// 파일: gas/Code.gs
//
// Script Properties (GAS 편집기 → 프로젝트 설정 → 스크립트 속성):
//   SPREADSHEET_ID      : 관리 시트 스프레드시트 ID
//   DISCORD_WEBHOOK_URL : Bot 서버의 외부 URL + /webhook
//                         예) http://158.180.78.10:3000/webhook
//
// 헤더 구조: 10행(부모) + 11행(자식) 병합/혼재 다단 헤더
//            → buildColMap()이 런타임에 flatten하여 colMap 구성
// 데이터 시작 행: 12행
// row_id: T-YYYYMMDD-XXXXXXXX (UUID 8자리), 불변, 시트 오른쪽 끝 컬럼, 숨김
// ═══════════════════════════════════════════════════════════════════════════

// ── 설정 상수 ─────────────────────────────────────────────────────────────────
var HEADER_PARENT_ROW  = 10;  // 상위 헤더 행 (부모, 병합)
var HEADER_CHILD_ROW   = 11;  // 하위 헤더 행 (자식, 모든 컬럼 이름)
var DATA_START_ROW     = 12;  // 데이터 시작 행 (12행부터)
var NO_RESPONSE_MIN    = 30;  // 무응답 판단 기준(분)

var SHEET_NAME_BATCH   = "batch_tasks";   // 관리 시트 탭명 (실제 탭명과 다르면 수정)
var SHEET_NAME_DIR     = "directory";     // 작업자 디렉토리 탭

// 색상 팔레트
var COLOR_CONFIRMED    = "#4472C4";  // 파란색 — 작업자/검수자 확정
var COLOR_REJECTED     = "#E06666";  // 빨간색 — 거절
var COLOR_NO_RESPONSE  = "#FFD966";  // 노란색 — 무응답
var COLOR_WHITE        = "#FFFFFF";  // 흰색   — 초기/리셋

// ── 시스템 컬럼 목록 (GAS가 자동 추가) ───────────────────────────────────────
// 아래 컬럼이 시트에 없으면 11행 오른쪽 끝에 자동 생성.
// 이미 존재하면 스킵. row_id는 ensureRowIdCol()에서 별도 처리.
var EXTRA_COLS = [
  "status",
  "dm_sent_at",
  "deadline_ack",
  "last_event_at",
  "retry_count",
  "reject_reason",
  "done_note",
  "actor_discord_user_id",
];

// ── 필드 후보 목록 (FIELD_CANDIDATES) ────────────────────────────────────────
// colMap에서 순서대로 시도해 처음 일치하는 키를 사용.
// 실제 헤더명이 다르면 이 목록에 후보를 추가하면 된다.
var FC = {
  ROW_ID           : ["row_id"],
  LANGUAGE         : ["언어", "Language", "lang"],
  PROJECT          : ["프로젝트", "project", "Project", "작업명"],
  FILE_LINK        : ["파일 링크", "file_link", "Google Drive", "링크"],
  PM_NAME          : ["pm_real_name", "PM", "담당PM", "관리자"],
  TASK_ASSIGNEE    : ["작업/작업자", "작업자", "번역/번역자", "담당자"],
  TASK_START_DATE  : ["작업/시작일", "작업/작업시작일", "작업시작일", "번역/시작일"],
  TASK_END_DATE    : ["작업/종료일", "작업/작업종료일", "작업종료일", "번역/종료일"],
  TASK_STATUS      : ["작업/진행상황", "작업/상태", "진행상황"],
  REVIEW_ASSIGNEE  : ["검수/검수자", "검수자"],
  REVIEW_START_DATE: ["검수/시작일", "검수/검수시작일", "검수시작일"],
  REVIEW_END_DATE  : ["검수/종료일", "검수/검수종료일", "검수종료일"],
  REVIEW_STATUS    : ["검수/진행상황", "검수/상태"],
  // 시스템 컬럼 (EXTRA_COLS와 일치)
  STATUS           : ["status"],
  DM_SENT_AT       : ["dm_sent_at"],
  DEADLINE_ACK     : ["deadline_ack"],
  LAST_EVENT_AT    : ["last_event_at"],
  RETRY_COUNT      : ["retry_count"],
  REJECT_REASON    : ["reject_reason"],
  DONE_NOTE        : ["done_note"],
  ACTOR_DISCORD_ID : ["actor_discord_user_id"],
};

// ── Script Properties 헬퍼 ───────────────────────────────────────────────────
function getProp(key) {
  var val = PropertiesService.getScriptProperties().getProperty(key);
  if (!val) throw new Error("Script Property 없음: " + key);
  return val;
}

function getSpreadsheet() {
  return SpreadsheetApp.openById(getProp("SPREADSHEET_ID"));
}

function getSheet(name) {
  var sheet = getSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error("탭을 찾을 수 없습니다: " + name);
  return sheet;
}

// ── 날짜 헬퍼 (Asia/Seoul 보장) ───────────────────────────────────────────────
function todayKST() {
  return Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd");
}
function nowIso() { return new Date().toISOString(); }

// ═══════════════════════════════════════════════════════════════════════════
// 헤더 파싱: buildColMap (10~11행 flatten)
// 반환: { 키: 0-based 컬럼 인덱스, ... }
// ═══════════════════════════════════════════════════════════════════════════
function buildColMap(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return {};

  var rows = sheet.getRange(HEADER_PARENT_ROW, 1, 2, lastCol).getValues();
  var row10 = rows[0];
  var row11 = rows[1];

  // ── 병합 셀 분석: 10행의 어느 열이 어느 부모에 속하는지 파악
  var parentForCol = {};
  try {
    var mergedRanges = sheet.getRange(HEADER_PARENT_ROW, 1, 1, lastCol).getMergedRanges();
    mergedRanges.forEach(function(rng) {
      var startC = rng.getColumn() - 1;           // 0-based
      var endC   = startC + rng.getNumColumns() - 1;
      var val    = String(row10[startC] || "").trim().replace(/\s+/g, " ");
      if (val) {
        for (var c = startC; c <= endC; c++) {
          parentForCol[c] = val;
        }
      }
    });
  } catch (e) {
    Logger.log("[buildColMap] getMergedRanges 실패(무시): " + e.message);
  }

  // 병합 범위에 포함되지 않은 단독 row10 값도 부모로 등록
  for (var c = 0; c < lastCol; c++) {
    if (parentForCol[c] === undefined) {
      var r10 = String(row10[c] || "").trim().replace(/\s+/g, " ");
      if (r10) parentForCol[c] = r10;
    }
  }

  // ── colMap 구성
  var colMap = {};
  var usedKeys = {};

  for (var c = 0; c < lastCol; c++) {
    var r11    = String(row11[c] || "").trim().replace(/\s+/g, " ");
    var parent = parentForCol[c] || "";

    var key;
    if (parent && r11 && parent !== r11) {
      key = parent + "/" + r11;
    } else if (r11) {
      key = r11;
    } else if (parent) {
      key = parent;
    } else {
      continue; // 빈 열 스킵
    }

    // 중복 키 처리
    if (usedKeys[key] !== undefined) {
      Logger.log("[buildColMap] 경고: 중복 키 '" + key + "' at col " + (c + 1) + " — _2 suffix 적용");
      var idx = 2;
      while (usedKeys[key + "_" + idx] !== undefined) idx++;
      key = key + "_" + idx;
    }
    colMap[key] = c;
    usedKeys[key] = true;
  }

  return colMap;
}

// Directory 탭용 colMap (1행 헤더, 표준 구조)
function buildDirColMap(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  headers.forEach(function(h, i) {
    var key = String(h || "").trim();
    if (key) map[key] = i;
  });
  return map;
}

// ── 컬럼 해석 헬퍼 ───────────────────────────────────────────────────────────
// 후보 목록에서 처음 일치하는 colMap 인덱스를 반환. 없으면 -1.
function resolveCol(colMap, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    if (colMap[candidates[i]] !== undefined) return colMap[candidates[i]];
  }
  return -1;
}

// resolveCol 결과를 캐싱하여 매번 재호출 방지
function buildFieldMap(colMap) {
  var f = {};
  for (var key in FC) {
    f[key] = resolveCol(colMap, FC[key]);
  }
  return f;
}

// ── 셀 읽기/쓰기 (1-based rowIndex, 0-based colIndex) ───────────────────────
function getCell(sheet, rowIndex, colIndex) {
  if (colIndex < 0) return "";
  return sheet.getRange(rowIndex, colIndex + 1).getValue();
}

function setCell(sheet, rowIndex, colIndex, value) {
  if (colIndex < 0) return;
  sheet.getRange(rowIndex, colIndex + 1).setValue(value);
}

function setCellBg(sheet, rowIndex, colIndex, color) {
  if (colIndex < 0) return;
  sheet.getRange(rowIndex, colIndex + 1).setBackground(color);
}

// ── 언어 판별 ────────────────────────────────────────────────────────────────
function isKoreanSource(language) {
  var lang = String(language || "").trim();
  return lang.indexOf("한국어") !== -1 || lang === "KO" || lang === "ko";
}

function getTaskStatusText(language, action) {
  var ko = isKoreanSource(language);
  switch (action) {
    case "ACCEPTED":
    case "START":
    case "IN_PROGRESS": return ko ? "작업중"    : "번역중";
    case "DONE":        return ko ? "작업 완료" : "번역 완료";
    case "REVIEW_START":return "검수중";
    case "REVIEW_DONE": return "검수 완료";
    default:            return "";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 시스템 컬럼 자동 추가 (row 11에 헤더, 데이터 없음)
// ═══════════════════════════════════════════════════════════════════════════
function ensureExtraCols(sheet) {
  var colMap = buildColMap(sheet);
  var lastC  = sheet.getLastColumn();

  EXTRA_COLS.forEach(function(name) {
    if (colMap[name] === undefined) {
      lastC++;
      sheet.getRange(HEADER_CHILD_ROW, lastC).setValue(name);
      Logger.log("[ensureExtraCols] 컬럼 추가: " + name + " (열 " + lastC + ")");
    }
  });
}

// row_id 컬럼 전용 처리 (없으면 추가 + 열 숨김 + 기존 행에 UUID 발급)
function ensureRowIdCol(sheet) {
  var colMap = buildColMap(sheet);

  if (colMap["row_id"] === undefined) {
    var lastC = sheet.getLastColumn() + 1;
    sheet.getRange(HEADER_CHILD_ROW, lastC).setValue("row_id");
    sheet.getRange(HEADER_CHILD_ROW, lastC).setFontWeight("normal").setBackground("#F3F3F3");
    sheet.setColumnWidth(lastC, 160);
    sheet.hideColumns(lastC);
    Logger.log("[ensureRowIdCol] row_id 컬럼 추가 및 숨김: 열 " + lastC);
    // 갱신된 colMap 재빌드
    colMap = buildColMap(sheet);
  }

  var cRowId = colMap["row_id"];
  if (cRowId === undefined) { Logger.log("[ensureRowIdCol] row_id 컬럼 확인 실패"); return; }

  // 기존 데이터 행 중 row_id가 빈 행에 UUID 발급
  var lastRow  = sheet.getLastRow();
  var data     = sheet.getRange(DATA_START_ROW, cRowId + 1, Math.max(lastRow - DATA_START_ROW + 1, 1), 1).getValues();
  var today    = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyyMMdd");
  var filled   = 0;

  data.forEach(function(row, idx) {
    if (String(row[0] || "").trim() === "") {
      var uid = Utilities.getUuid().replace(/-/g, "").slice(0, 8).toUpperCase();
      var rowId = "T-" + today + "-" + uid;
      sheet.getRange(DATA_START_ROW + idx, cRowId + 1).setValue(rowId);
      filled++;
    }
  });
  if (filled > 0) Logger.log("[ensureRowIdCol] row_id 발급: " + filled + "행");
}

// ── UUID 기반 row_id 생성 ─────────────────────────────────────────────────────
function generateRowId() {
  var today = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyyMMdd");
  var uid   = Utilities.getUuid().replace(/-/g, "").slice(0, 8).toUpperCase();
  return "T-" + today + "-" + uid;
}

// ── row_id로 행 검색 (DATA_START_ROW부터) ───────────────────────────────────
function findRowByRowId(sheet, colMap, rowId) {
  var cRowId  = resolveCol(colMap, FC.ROW_ID);
  if (cRowId < 0) return null;

  var lastRow = sheet.getLastRow();
  var count   = Math.max(lastRow - DATA_START_ROW + 1, 0);
  if (count === 0) return null;

  var vals = sheet.getRange(DATA_START_ROW, cRowId + 1, count, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || "").trim() === rowId) {
      return { rowIndex: DATA_START_ROW + i }; // 1-based
    }
  }
  return null;
}

// ── Directory 매핑: real_name → discord_user_id ───────────────────────────────
function buildDirectoryMap() {
  var sheet  = getSheet(SHEET_NAME_DIR);
  var colMap = buildDirColMap(sheet);
  var cName  = colMap["real_name"];
  var cUid   = colMap["discord_user_id"];
  var cStat  = colMap["status"];

  if (cName === undefined || cUid === undefined) {
    throw new Error("directory 탭에 real_name/discord_user_id 컬럼이 없습니다");
  }

  var data   = sheet.getDataRange().getValues();
  var map    = {};
  for (var i = 1; i < data.length; i++) {
    var row  = data[i];
    var name = String(row[cName] || "").trim();
    var uid  = String(row[cUid]  || "").trim();
    var stat = cStat !== undefined ? String(row[cStat] || "").trim().toLowerCase() : "active";
    if (name && uid && stat === "active") map[name] = uid;
  }
  return map;
}

// ── Discord Bot /webhook 호출 ────────────────────────────────────────────────
function callBotWebhook(payload) {
  var url = getProp("DISCORD_WEBHOOK_URL");
  var res = UrlFetchApp.fetch(url, {
    method            : "POST",
    contentType       : "application/json",
    payload           : JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  Logger.log("[callBotWebhook] " + code + " | " + text.slice(0, 200));
  return { code: code, text: text };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. scanPendingTasks — 5분 트리거
//    조건: status=PENDING_ACK AND dm_sent_at 비어있음
//    (행 번호 기반이 아닌 조건 기반 — 행 삽입/정렬에 무관)
// ═══════════════════════════════════════════════════════════════════════════
function scanPendingTasks() {
  ensureExtraCols(getSheet(SHEET_NAME_BATCH));
  ensureRowIdCol(getSheet(SHEET_NAME_BATCH));

  var sheet    = getSheet(SHEET_NAME_BATCH);
  var colMap   = buildColMap(sheet);
  var dirMap   = buildDirectoryMap();
  var lastRow  = sheet.getLastRow();
  var count    = Math.max(lastRow - DATA_START_ROW + 1, 0);
  if (count === 0) return;

  // 필요한 컬럼 인덱스 해석
  var f = buildFieldMap(colMap);

  // 전체 데이터를 한 번에 읽기 (효율)
  var data = sheet.getRange(DATA_START_ROW, 1, count, sheet.getLastColumn()).getValues();

  data.forEach(function(row, idx) {
    var sheetRow = DATA_START_ROW + idx;
    var status   = String(row[f.STATUS]     || "").trim();
    var dmSentAt = String(row[f.DM_SENT_AT] || "").trim();

    // 조건: PENDING_ACK이면서 DM 미전송
    if (status !== "PENDING_ACK" || dmSentAt !== "") return;

    var rowId = String(row[f.ROW_ID] || "").trim();
    if (!rowId) {
      rowId = generateRowId();
      setCell(sheet, sheetRow, f.ROW_ID, rowId);
    }

    var assigneeName = String(row[f.TASK_ASSIGNEE] || "").trim();
    if (!assigneeName) {
      Logger.log("[scan] 작업자 없음: 행 " + sheetRow);
      return;
    }

    var discordUid = dirMap[assigneeName] || "";
    if (!discordUid) {
      Logger.log("[scan] discord_user_id 없음: " + assigneeName);
      return;
    }

    var payload = {
      row_id             : rowId,
      discord_user_id    : discordUid,
      assignee_real_name : assigneeName,
      project            : String(row[f.PROJECT]   || ""),
      language           : String(row[f.LANGUAGE]  || ""),
      file_link          : String(row[f.FILE_LINK] || ""),
      pm_real_name       : String(row[f.PM_NAME]   || ""),
      stage              : "ACK",
    };

    var result = callBotWebhook(payload);
    if (result.code === 200) {
      var now      = new Date();
      var deadline = new Date(now.getTime() + NO_RESPONSE_MIN * 60 * 1000);
      setCell(sheet, sheetRow, f.STATUS,      "DM_SENT");
      setCell(sheet, sheetRow, f.DM_SENT_AT,  now.toISOString());
      setCell(sheet, sheetRow, f.DEADLINE_ACK, deadline.toISOString());
      setCell(sheet, sheetRow, f.LAST_EVENT_AT, now.toISOString());
      Logger.log("[scan] DM 전송 성공: row_id=" + rowId);
    } else {
      Logger.log("[scan] DM 전송 실패: row_id=" + rowId + " code=" + result.code);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. checkNoResponse — 10분 트리거
//    DM_SENT 상태에서 deadline_ack 초과 시 NO_RESPONSE 처리
// ═══════════════════════════════════════════════════════════════════════════
function checkNoResponse() {
  var sheet   = getSheet(SHEET_NAME_BATCH);
  var colMap  = buildColMap(sheet);
  var lastRow = sheet.getLastRow();
  var count   = Math.max(lastRow - DATA_START_ROW + 1, 0);
  if (count === 0) return;

  var f    = buildFieldMap(colMap);
  var data = sheet.getRange(DATA_START_ROW, 1, count, sheet.getLastColumn()).getValues();
  var now  = new Date();

  data.forEach(function(row, idx) {
    var sheetRow = DATA_START_ROW + idx;
    var status   = String(row[f.STATUS] || "").trim();
    if (status !== "DM_SENT") return;

    var deadlineRaw = row[f.DEADLINE_ACK];
    if (!deadlineRaw) return;

    var deadline = new Date(deadlineRaw);
    if (isNaN(deadline.getTime()) || now <= deadline) return;

    var retryCount = Number(row[f.RETRY_COUNT] || 0);
    setCell(sheet, sheetRow, f.STATUS,        "NO_RESPONSE");
    setCell(sheet, sheetRow, f.RETRY_COUNT,   retryCount + 1);
    setCell(sheet, sheetRow, f.LAST_EVENT_AT, now.toISOString());

    // 작업자 셀 노란색
    setCellBg(sheet, sheetRow, f.TASK_ASSIGNEE, COLOR_NO_RESPONSE);

    Logger.log("[checkNoResponse] NO_RESPONSE: 행 " + sheetRow + " row_id=" + String(row[f.ROW_ID]));
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. doPost — Discord Bot → GAS 콜백
//
//    수신 payload:
//    { row_id, action, reject_reason?, done_note?, actor_discord_user_id }
//
//    action 목록:
//    ACCEPTED | REJECTED | START | DONE | REVIEW_START | REVIEW_DONE
//    (하위호환: IN_PROGRESS → START alias로 처리)
// ═══════════════════════════════════════════════════════════════════════════
function doPost(e) {
  try {
    var data   = JSON.parse(e.postData.contents);
    var rowId  = String(data.row_id  || "").trim();
    var action = String(data.action  || "").trim();
    var actor  = String(data.actor_discord_user_id || "");

    if (!rowId || !action) return jsonResp({ ok: false, error: "row_id 또는 action 누락" });

    var sheet  = getSheet(SHEET_NAME_BATCH);
    var colMap = buildColMap(sheet);
    var f      = buildFieldMap(colMap);
    var found  = findRowByRowId(sheet, colMap, rowId);

    if (!found) return jsonResp({ ok: false, error: "row_id 없음: " + rowId });

    var ri       = found.rowIndex; // 1-based 행 번호
    var fullData = sheet.getRange(ri, 1, 1, sheet.getLastColumn()).getValues()[0];
    var language = String(fullData[f.LANGUAGE] || "");
    var today    = todayKST();
    var tsNow    = nowIso();

    switch (action) {
      // ── 수락 ────────────────────────────────────────────────────────────
      case "ACCEPTED":
        setCell  (sheet, ri, f.STATUS,        "ACCEPTED");
        setCell  (sheet, ri, f.TASK_STATUS,   getTaskStatusText(language, "ACCEPTED"));
        setCellBg(sheet, ri, f.TASK_ASSIGNEE, COLOR_CONFIRMED);
        setCell  (sheet, ri, f.ACTOR_DISCORD_ID, actor);
        setCell  (sheet, ri, f.LAST_EVENT_AT, tsNow);
        break;

      // ── 거절 ────────────────────────────────────────────────────────────
      case "REJECTED":
        setCell  (sheet, ri, f.STATUS,        "REJECTED");
        setCell  (sheet, ri, f.REJECT_REASON, String(data.reject_reason || ""));
        setCellBg(sheet, ri, f.TASK_ASSIGNEE, COLOR_REJECTED);
        setCell  (sheet, ri, f.ACTOR_DISCORD_ID, actor);
        setCell  (sheet, ri, f.LAST_EVENT_AT, tsNow);
        break;

      // ── 작업 시작 ────────────────────────────────────────────────────────
      case "START":
      case "IN_PROGRESS": // 하위호환 alias
        setCell(sheet, ri, f.STATUS,          "IN_PROGRESS");
        setCell(sheet, ri, f.TASK_START_DATE, today);
        setCell(sheet, ri, f.TASK_STATUS,     getTaskStatusText(language, "IN_PROGRESS"));
        setCell(sheet, ri, f.ACTOR_DISCORD_ID, actor);
        setCell(sheet, ri, f.LAST_EVENT_AT,   tsNow);
        break;

      // ── 작업 완료 ────────────────────────────────────────────────────────
      case "DONE":
        setCell(sheet, ri, f.STATUS,         "DONE");
        setCell(sheet, ri, f.TASK_END_DATE,  today);
        setCell(sheet, ri, f.TASK_STATUS,    getTaskStatusText(language, "DONE"));
        setCell(sheet, ri, f.DONE_NOTE,      String(data.done_note || ""));
        setCell(sheet, ri, f.ACTOR_DISCORD_ID, actor);
        setCell(sheet, ri, f.LAST_EVENT_AT,  tsNow);
        // 검수자 DM 자동 발송
        _dispatchReviewDm(sheet, ri, fullData, f, rowId, language);
        break;

      // ── 검수 시작 ────────────────────────────────────────────────────────
      case "REVIEW_START":
        setCell  (sheet, ri, f.STATUS,             "REVIEW_IN_PROGRESS");
        setCell  (sheet, ri, f.REVIEW_START_DATE,  today);
        setCell  (sheet, ri, f.REVIEW_STATUS,      getTaskStatusText(language, "REVIEW_START"));
        setCellBg(sheet, ri, f.REVIEW_ASSIGNEE,    COLOR_CONFIRMED);
        setCell  (sheet, ri, f.ACTOR_DISCORD_ID,   actor);
        setCell  (sheet, ri, f.LAST_EVENT_AT,      tsNow);
        break;

      // ── 검수 완료 ────────────────────────────────────────────────────────
      case "REVIEW_DONE":
        setCell(sheet, ri, f.STATUS,            "REVIEW_DONE");
        setCell(sheet, ri, f.REVIEW_END_DATE,   today);
        setCell(sheet, ri, f.REVIEW_STATUS,     getTaskStatusText(language, "REVIEW_DONE"));
        setCell(sheet, ri, f.ACTOR_DISCORD_ID,  actor);
        setCell(sheet, ri, f.LAST_EVENT_AT,     tsNow);
        break;

      default:
        return jsonResp({ ok: false, error: "알 수 없는 action: " + action });
    }

    Logger.log("[doPost] OK row_id=" + rowId + " action=" + action + " actor=" + actor);
    return jsonResp({ ok: true, row_id: rowId, action: action });

  } catch (err) {
    Logger.log("[doPost] 오류: " + err.message + "\n" + err.stack);
    return jsonResp({ ok: false, error: err.message });
  }
}

// DONE 처리 후 검수자에게 자동 DM 발송 (내부 함수)
function _dispatchReviewDm(sheet, ri, rowData, f, rowId, language) {
  try {
    var reviewerName = String(rowData[f.REVIEW_ASSIGNEE] || "").trim();
    if (!reviewerName) { Logger.log("[review DM] 검수자 없음: row_id=" + rowId); return; }

    var dirMap = buildDirectoryMap();
    var uid    = dirMap[reviewerName] || "";
    if (!uid) { Logger.log("[review DM] discord_user_id 없음: " + reviewerName); return; }

    var payload = {
      row_id             : rowId,
      discord_user_id    : uid,
      assignee_real_name : reviewerName,
      project            : String(rowData[f.PROJECT]   || ""),
      language           : language,
      file_link          : String(rowData[f.FILE_LINK] || ""),
      pm_real_name       : String(rowData[f.PM_NAME]   || ""),
      stage              : "REVIEW",
    };

    var result = callBotWebhook(payload);
    if (result.code === 200) {
      Logger.log("[review DM] 전송 성공 → " + reviewerName + " (" + uid + ")");
    } else {
      Logger.log("[review DM] 전송 실패 code=" + result.code);
    }
  } catch (err) {
    Logger.log("[review DM] 오류: " + err.message);
  }
}

// ── JSON 응답 헬퍼 ───────────────────────────────────────────────────────────
function jsonResp(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── doGet (간단 상태 확인) ───────────────────────────────────────────────────
function doGet() {
  try {
    var sheet  = getSheet(SHEET_NAME_BATCH);
    var colMap = buildColMap(sheet);
    var f      = buildFieldMap(colMap);
    var last   = sheet.getLastRow();
    var count  = Math.max(last - DATA_START_ROW + 1, 0);
    var data   = count > 0 ? sheet.getRange(DATA_START_ROW, 1, count, sheet.getLastColumn()).getValues() : [];
    var pending = data.filter(function(r) { return String(r[f.STATUS] || "").trim() === "PENDING_ACK"; }).length;
    return jsonResp({ ok: true, pending_ack: pending, ts: nowIso() });
  } catch (err) {
    return jsonResp({ ok: false, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. setupTriggers — 최초 1회 수동 실행
// ═══════════════════════════════════════════════════════════════════════════
function setupTriggers() {
  var targets = ["scanPendingTasks", "checkNoResponse"];
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (targets.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("scanPendingTasks").timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger("checkNoResponse").timeBased().everyMinutes(10).create();
  Logger.log("트리거 등록 완료: scanPendingTasks(5분), checkNoResponse(10분)");
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. 초기화 유틸 (수동 1회 실행)
// ═══════════════════════════════════════════════════════════════════════════

// 시스템 컬럼 + row_id 일괄 초기화
function initSheet() {
  var sheet = getSheet(SHEET_NAME_BATCH);
  ensureExtraCols(sheet);
  ensureRowIdCol(sheet);
  Logger.log("[initSheet] 완료");
}

// 실제 생성된 colMap을 Logger에 출력 — 헤더 파싱 검증용
function logColMap() {
  var sheet  = getSheet(SHEET_NAME_BATCH);
  var colMap = buildColMap(sheet);
  Logger.log("[logColMap] 관리 시트 colMap (총 " + Object.keys(colMap).length + "개):");
  Object.keys(colMap).sort().forEach(function(k) {
    var colLetter = columnToLetter(colMap[k] + 1);
    Logger.log("  " + k + " → 열 " + (colMap[k] + 1) + " (" + colLetter + ")");
  });
  Logger.log("\n[logColMap] FIELD 매핑 결과:");
  var f = buildFieldMap(colMap);
  Object.keys(f).forEach(function(k) {
    var idx = f[k];
    Logger.log("  " + k + " → " + (idx >= 0 ? "열 " + (idx + 1) + " (" + columnToLetter(idx + 1) + ")" : "❌ 미발견"));
  });
}

// 열 번호(1-based) → 엑셀 알파벳 변환
function columnToLetter(col) {
  var letter = "";
  while (col > 0) {
    var mod = (col - 1) % 26;
    letter  = String.fromCharCode(65 + mod) + letter;
    col     = Math.floor((col - 1) / 26);
  }
  return letter;
}
