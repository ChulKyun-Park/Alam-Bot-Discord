// ═══════════════════════════════════════════════════════════════════════════
// Alam Translation Bot — Google Apps Script
// 파일: Code.gs
//
// Script Properties (GAS 편집기 → 프로젝트 설정 → 스크립트 속성에서 설정):
//   SPREADSHEET_ID       : 166o1GSu7FhWpK-yKDPOzN7xOyfgQRewriWU8WqdoxwI
//   DISCORD_WEBHOOK_URL  : http://158.180.78.10:3000/webhook
//
// 상태값: PENDING_ACK → DM_SENT → ACCEPTED / REJECTED / NO_RESPONSE
//         ACCEPTED → IN_PROGRESS → DONE
// ═══════════════════════════════════════════════════════════════════════════

// ── Script Properties 로드 ───────────────────────────────────────────────────
function getProp(key) {
  const val = PropertiesService.getScriptProperties().getProperty(key);
  if (!val) throw new Error("Script Property 없음: " + key);
  return val;
}

// ── 상수 ─────────────────────────────────────────────────────────────────────
const SHEET = {
  BATCH    : "batch_tasks",
  DIRECTORY: "directory",
  ROUTING  : "routing",
  AVAIL    : "availability",
};

// batch_tasks 안전망 컬럼 목록
// - xlsx batch_tasks에 이미 있는 컬럼: deadline_ack, last_event_at, retry_count, reject_reason
//   → ensureExtraCols가 이미 존재하면 스킵하므로 중복 등록해도 무방
// - xlsx에 없어서 GAS가 새로 추가해야 하는 컬럼: dm_sent_at, done_note, actor_discord_user_id
const EXTRA_COLS = [
  "dm_sent_at",            // scanPendingTasks가 기록
  "done_note",             // doPost(DONE) 시 기록
  "actor_discord_user_id", // doPost 시 버튼 클릭자 ID 기록
  // 아래는 xlsx에 이미 존재하지만, 신규 시트 생성 시 누락될 수 있으므로 안전망으로 포함
  "deadline_ack",          // scanPendingTasks가 기록 (now + NO_RESPONSE_MINUTES)
  "last_event_at",         // 모든 상태 변경 시 갱신
  "retry_count",           // checkNoResponse가 증가
  "reject_reason",         // doPost(REJECTED) 시 기록
];

// NO_RESPONSE 판단 기준 (분)
const NO_RESPONSE_MINUTES = 30;

// ── 스프레드시트 헬퍼 ────────────────────────────────────────────────────────
function getSpreadsheet() {
  return SpreadsheetApp.openById(getProp("SPREADSHEET_ID"));
}

function getSheet(name) {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error("시트를 찾을 수 없습니다: " + name);
  return sheet;
}

/**
 * 헤더 행(1행)을 읽어 { 컬럼명: 0-based 인덱스 } 맵을 반환.
 * 열 번호 하드코딩 금지 — 헤더명으로만 접근.
 */
function getColMap(sheet) {
  const lastCol  = sheet.getLastColumn();
  const headers  = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map      = {};
  headers.forEach(function(h, i) {
    const key = String(h).trim();
    if (key) map[key] = i;
  });
  return map;
}

/**
 * 컬럼명 → 0-based 인덱스 반환. 없으면 예외.
 */
function col(map, name) {
  if (map[name] === undefined) throw new Error('컬럼 없음: "' + name + '"');
  return map[name];
}

/**
 * batch_tasks에 EXTRA_COLS 중 없는 컬럼을 자동 추가.
 * 처음 실행 시 1회만 필요.
 */
function ensureExtraCols() {
  var sheet  = getSheet(SHEET.BATCH);
  var colMap = getColMap(sheet);
  var lastC  = sheet.getLastColumn();

  EXTRA_COLS.forEach(function(name) {
    if (colMap[name] === undefined) {
      lastC++;
      sheet.getRange(1, lastC).setValue(name);
      Logger.log("컬럼 추가: " + name + " (열 " + lastC + ")");
    }
  });
}

/**
 * 셀 값 쓰기 (1-based rowIndex, 0-based colIndex 사용).
 */
function setCell(sheet, rowIndex, colIndex, value) {
  sheet.getRange(rowIndex, colIndex + 1).setValue(value);
}

function now() { return new Date(); }
function iso()  { return now().toISOString(); }

// ── directory 매핑 헬퍼 ──────────────────────────────────────────────────────
/**
 * directory 탭 전체를 읽어 real_name → discord_user_id 맵을 반환.
 * 조건: directory.status == "active" 인 행만 포함.
 * 매핑 키 = directory.real_name = batch_tasks.assignee_real_name
 */
function buildDirectoryMaps() {
  var sheet  = getSheet(SHEET.DIRECTORY);
  var colMap = getColMap(sheet);
  var cName  = col(colMap, "real_name");
  var cUid   = col(colMap, "discord_user_id");
  var cStat  = col(colMap, "status");

  var data   = sheet.getDataRange().getValues();
  var nameToUid = {};

  for (var i = 1; i < data.length; i++) {
    var row  = data[i];
    var name = String(row[cName]).trim();
    var uid  = String(row[cUid]).trim();
    var stat = String(row[cStat]).trim().toLowerCase();
    if (name && uid && stat === "active") {
      nameToUid[name] = uid;
    }
  }
  return nameToUid;
}

// ── row_id 생성 전략 ─────────────────────────────────────────────────────────
/**
 * 비어 있는 row_id를 자동 생성.
 * 형식: T-YYYYMMDD-{행 번호 3자리}
 * 예)  T-20260222-002
 */
function generateRowId(sheetRowIndex) {
  var d   = now();
  var ymd = Utilities.formatDate(d, "Asia/Seoul", "yyyyMMdd");
  var seq = String(sheetRowIndex - 1).padStart(3, "0");
  return "T-" + ymd + "-" + seq;
}

// ── Discord Bot /webhook 호출 ────────────────────────────────────────────────
/**
 * Discord Bot의 /webhook 엔드포인트로 DM 전송 요청을 보냄.
 * @param {Object} payload  - { row_id, discord_user_id, assignee_real_name,
 *                              project, language, file_link, pm_real_name, stage }
 */
function callBotWebhook(payload) {
  var url     = getProp("DISCORD_WEBHOOK_URL");
  var options = {
    method         : "POST",
    contentType    : "application/json",
    payload        : JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  var res  = UrlFetchApp.fetch(url, options);
  var code = res.getResponseCode();
  var text = res.getContentText();
  Logger.log("[callBotWebhook] " + code + " " + text.slice(0, 200));
  return { code: code, text: text };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. scanPendingTasks
//    - 5분마다 실행 (setupTriggers로 등록)
//    - batch_tasks에서 status=PENDING_ACK 행을 찾아 Discord DM 전송 요청
// ═══════════════════════════════════════════════════════════════════════════
function scanPendingTasks() {
  ensureExtraCols();

  var sheet    = getSheet(SHEET.BATCH);
  var colMap   = getColMap(sheet);
  var nameToUid = buildDirectoryMaps();
  var data     = sheet.getDataRange().getValues();

  var cRowId    = col(colMap, "row_id");
  var cProject  = col(colMap, "project");
  var cLang     = col(colMap, "language");
  var cFile     = col(colMap, "file_link");
  var cAssignee = col(colMap, "assignee_real_name");
  var cPm       = col(colMap, "pm_real_name");
  var cStatus   = col(colMap, "status");
  var cDeadline = col(colMap, "deadline_ack");
  var cLastEvt  = col(colMap, "last_event_at");
  var cDmSent   = col(colMap, "dm_sent_at");

  for (var i = 1; i < data.length; i++) {
    var row    = data[i];
    var status = String(row[cStatus]).trim();
    if (status !== "PENDING_ACK") continue;

    var assigneeName = String(row[cAssignee]).trim();
    if (!assigneeName) {
      Logger.log("[scan] assignee_real_name 비어있음: 행 " + (i + 1));
      continue;
    }

    // row_id 자동 생성 (빈 경우)
    var rowId = String(row[cRowId]).trim();
    if (!rowId) {
      rowId = generateRowId(i + 1);
      setCell(sheet, i + 1, cRowId, rowId);
    }

    // directory 매핑으로 discord_user_id 확인
    var discordUid = nameToUid[assigneeName] || "";
    if (!discordUid) {
      Logger.log("[scan] discord_user_id 없음: " + assigneeName);
      continue;
    }

    var payload = {
      row_id             : rowId,
      discord_user_id    : discordUid,
      assignee_real_name : assigneeName,
      project            : String(row[cProject]),
      language           : String(row[cLang]),
      file_link          : String(row[cFile]),
      pm_real_name       : String(row[cPm]),
      stage              : "ACK",
    };

    var result = callBotWebhook(payload);
    if (result.code === 200) {
      var sentAt   = iso();
      var deadline = new Date(now().getTime() + NO_RESPONSE_MINUTES * 60 * 1000);

      setCell(sheet, i + 1, cStatus,   "DM_SENT");
      setCell(sheet, i + 1, cDmSent,   sentAt);
      setCell(sheet, i + 1, cDeadline, deadline.toISOString());
      setCell(sheet, i + 1, cLastEvt,  sentAt);
      Logger.log("[scan] DM 전송 성공: row_id=" + rowId);
    } else {
      Logger.log("[scan] DM 전송 실패: row_id=" + rowId + " code=" + result.code);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. checkNoResponse
//    - 10분마다 실행
//    - DM_SENT 상태에서 deadline_ack를 초과한 행을 NO_RESPONSE 처리
// ═══════════════════════════════════════════════════════════════════════════
function checkNoResponse() {
  var sheet  = getSheet(SHEET.BATCH);
  var colMap = getColMap(sheet);
  var data   = sheet.getDataRange().getValues();

  var cRowId    = col(colMap, "row_id");
  var cStatus   = col(colMap, "status");
  var cDeadline = col(colMap, "deadline_ack");
  var cRetry    = col(colMap, "retry_count");
  var cLastEvt  = col(colMap, "last_event_at");
  var currentTs = now();

  for (var i = 1; i < data.length; i++) {
    var row    = data[i];
    var status = String(row[cStatus]).trim();
    if (status !== "DM_SENT") continue;

    var deadlineRaw = row[cDeadline];
    if (!deadlineRaw) continue;

    var deadline = new Date(deadlineRaw);
    if (isNaN(deadline.getTime())) continue;

    if (currentTs > deadline) {
      var retryCount = Number(row[cRetry]) || 0;
      setCell(sheet, i + 1, cStatus,  "NO_RESPONSE");
      setCell(sheet, i + 1, cRetry,   retryCount + 1);
      setCell(sheet, i + 1, cLastEvt, iso());
      Logger.log("[checkNoResponse] NO_RESPONSE: row_id=" + String(row[cRowId]));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. doPost — Discord Bot → GAS 콜백 수신
//    Bot이 버튼/모달 결과를 POST로 전송
//
//    수신 payload 스키마:
//    {
//      "row_id"               : "T-20260222-002",
//      "action"               : "ACCEPTED" | "REJECTED" | "IN_PROGRESS" | "DONE",
//      "reject_reason"        : "...",   // REJECTED 시
//      "done_note"            : "...",   // DONE 시
//      "actor_discord_user_id": "1234567890123456789"
//    }
// ═══════════════════════════════════════════════════════════════════════════
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var rowId  = String(data.row_id  || "").trim();
    var action = String(data.action  || "").trim();

    if (!rowId || !action) {
      return jsonResp({ ok: false, error: "row_id 또는 action 누락" });
    }

    ensureExtraCols();

    var sheet  = getSheet(SHEET.BATCH);
    var colMap = getColMap(sheet);
    var found  = findRow(sheet, colMap, rowId);

    if (!found) {
      return jsonResp({ ok: false, error: "row_id 없음: " + rowId });
    }

    var rowIndex       = found.rowIndex; // 1-based
    var cStatus        = col(colMap, "status");
    var cLastEvt       = col(colMap, "last_event_at");
    var cRejectReason  = col(colMap, "reject_reason");
    var cDoneNote      = col(colMap, "done_note");
    var cActorUid      = col(colMap, "actor_discord_user_id");
    var ts             = iso();
    var actorUid       = String(data.actor_discord_user_id || "");

    switch (action) {
      case "ACCEPTED":
        setCell(sheet, rowIndex, cStatus,   "ACCEPTED");
        setCell(sheet, rowIndex, cActorUid, actorUid);
        setCell(sheet, rowIndex, cLastEvt,  ts);
        break;

      case "REJECTED":
        setCell(sheet, rowIndex, cStatus,        "REJECTED");
        setCell(sheet, rowIndex, cRejectReason,  String(data.reject_reason || ""));
        setCell(sheet, rowIndex, cActorUid,      actorUid);
        setCell(sheet, rowIndex, cLastEvt,       ts);
        break;

      case "IN_PROGRESS":
        setCell(sheet, rowIndex, cStatus,   "IN_PROGRESS");
        setCell(sheet, rowIndex, cActorUid, actorUid);
        setCell(sheet, rowIndex, cLastEvt,  ts);
        break;

      case "DONE":
        setCell(sheet, rowIndex, cStatus,   "DONE");
        setCell(sheet, rowIndex, cDoneNote, String(data.done_note || ""));
        setCell(sheet, rowIndex, cActorUid, actorUid);
        setCell(sheet, rowIndex, cLastEvt,  ts);
        break;

      default:
        return jsonResp({ ok: false, error: "알 수 없는 action: " + action });
    }

    Logger.log("[doPost] row_id=" + rowId + " action=" + action + " actor=" + actorUid);
    return jsonResp({ ok: true, row_id: rowId, action: action });

  } catch (err) {
    Logger.log("[doPost] 오류: " + err.message);
    return jsonResp({ ok: false, error: err.message });
  }
}

// ── row_id로 행 검색 ──────────────────────────────────────────────────────────
function findRow(sheet, colMap, rowId) {
  var cRowId = col(colMap, "row_id");
  var data   = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][cRowId]).trim() === rowId) {
      return { rowIndex: i + 1, rowData: data[i] }; // rowIndex: 1-based
    }
  }
  return null;
}

// ── JSON 응답 헬퍼 ───────────────────────────────────────────────────────────
function jsonResp(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. setupTriggers — 최초 1회 실행으로 시간 기반 트리거 등록
//    GAS 편집기에서 직접 실행: 함수 선택 → "setupTriggers" → ▶ 실행
// ═══════════════════════════════════════════════════════════════════════════
function setupTriggers() {
  // 중복 등록 방지: 기존 트리거 삭제
  var existing = ScriptApp.getProjectTriggers();
  var targets  = ["scanPendingTasks", "checkNoResponse"];

  existing.forEach(function(t) {
    if (targets.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
    }
  });

  // scanPendingTasks: 5분마다
  ScriptApp.newTrigger("scanPendingTasks")
    .timeBased()
    .everyMinutes(5)
    .create();

  // checkNoResponse: 10분마다
  ScriptApp.newTrigger("checkNoResponse")
    .timeBased()
    .everyMinutes(10)
    .create();

  Logger.log("트리거 등록 완료: scanPendingTasks(5분), checkNoResponse(10분)");
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. [선택] doGet — 브라우저에서 간단 상태 확인용
//    배포 URL을 GET으로 열면 현재 PENDING_ACK 건수를 반환
// ═══════════════════════════════════════════════════════════════════════════
function doGet() {
  try {
    var sheet   = getSheet(SHEET.BATCH);
    var colMap  = getColMap(sheet);
    var data    = sheet.getDataRange().getValues();
    var cStatus = col(colMap, "status");
    var pending = 0;

    for (var i = 1; i < data.length; i++) {
      if (String(data[i][cStatus]).trim() === "PENDING_ACK") pending++;
    }

    return jsonResp({ ok: true, pending_ack: pending, ts: iso() });
  } catch (err) {
    return jsonResp({ ok: false, error: err.message });
  }
}
