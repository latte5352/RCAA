// Python C_Audit.py의 규칙 검사 로직을 그대로 옮긴 것 (openpyxl/Excel 부분은 제외 - 서버리스라
// Excel을 중간 매개체로 안 쓰고, 계산 결과를 바로 record 객체 배열로 들고 있다가 화면에 그린다).
//
// record 하나 = 트래커(산출물) 하나. B_Audit_Data_Creation.py가 반환하던 딕셔너리와 같은
// 정보를 담되, 필드명은 camelCase로, 값은 Excel 텍스트 셀이 아니라 원래 타입(number/boolean)
// 그대로 갖는다:
//   trackerName, trackerType, itemCount, fileName, firstEdit, lastEdit, status, currentVersion,
//   prId, versioning, verDesc, reviewReportItemCount, reviewReportStatus,
//   reviewReportUploaded(true|false|"해당없음"), waitingBeforeApproval, reviewReportLastUpload,
//   owner, createDateCurrent(boolean), targetVersion, versionCheckFailReason,
//   isEventBased(boolean), testResultClosedDate, itemFetchIncomplete(boolean)
//
// runAudit()이 각 record에 다음을 채워 넣는다: saveRule/versionRule/docHistoryRule/statusRule
// (1=OK, 2=NG, null=해당 규칙 검사 대상 아님), comment(codebeamer로 보낼 간결한 사유),
// detailComment(사람이 보기 위한 상세 사유 배열).

import { stripProcessTag, stripTrailingQualifier, nameEndsWith, matchConfiguredSuffix, isDateBasedTracker } from "./wikiTable.js";
import { parseDateOnly, formatDateOnly, businessDaysBetween } from "./businessDays.js";
import { STATUS_RULE_MANUAL_CHECK_TRACKERS } from "./config.js";

const TRAILING_QUALIFIER_RE = /(\s*\([^)]*\))+$/;
// 문자로만 이뤄진 짧은 진짜 확장자(zip/docx/pdf 등)로 끝날 때만 파일 확장자로 인식한다 -
// checkSaveRule 참고(PA 항목 제목이 "1. Foo"처럼 번호를 매긴 경우 오탐 방지).
const TRAILING_EXTENSION_RE = /\.[A-Za-z]{1,5}$/;

const EMPTY_FILE_VALUES = new Set(["", "0", "미업로드"]);
const EMPTY_DATE_VALUES = new Set(["", "미업로드"]);
const VERSION_DEADLINE_DAYS = 10; // 2.1) 버전 규칙 준수: 첫 Edit 이후 Working Day 10일 이내 Version Up
const UPLOAD_TRUE_STATUSES = new Set(["Approved", "Internal Baselined", "Gate Baselined", "Waiting for Approval"]);
// UPLOAD_TRUE_STATUSES 중 "Waiting for Approval"은 아직 승인 전이라 반려되면 다시 수정될 수
// 있지만, 이 세 상태는 이미 승인/베이스라인까지 끝난 상태라 그 이후로는 버전업이나 PR 조치
// 기술을 더 따질 필요가 없다(checkVersionRule/checkDocHistoryRule 참고).
const FINALIZED_STATUSES = new Set(["Approved", "Internal Baselined", "Gate Baselined"]);
const UPLOAD_FALSE_STATUSES = new Set(["In Review", "Open"]);
const EVENTBASED_TERMINAL_STATUSES = new Set(["Released", "Read Only"]);
const PR_IN_DESC_RE = /\bPR[^\d]*?(\d+)/gi; // 하이픈 유무와 무관하게 PR 뒤 첫 숫자를 PR 번호로 인식

export const DEFAULT_PERIODIC_CADENCE = "biweekly";
export const DEFAULT_PERIODIC_ANCHOR = 0; // weekly/biweekly: 요일(0=월~6=일), monthly: 일자(1~31)

function hasFile(fileName) {
  return !EMPTY_FILE_VALUES.has((fileName || "").toLowerCase());
}

function normalizeForNamingCheck(text) {
  return (text || "").replace(/[_\s]+/g, " ").trim().toLowerCase();
}

/** 값이 비어있거나("", "미업로드") 날짜 형식이 아니면 null, 아니면 원본 ISO 문자열 그대로 반환. */
function parseDatetimeIso(value) {
  if (!value) return null;
  if (EMPTY_DATE_VALUES.has(value.toLowerCase())) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  return value;
}

function todayAsUtcDate() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function clampDay(year, month1based, day) {
  const lastDay = new Date(Date.UTC(year, month1based, 0)).getUTCDate();
  return new Date(Date.UTC(year, month1based - 1, Math.min(day, lastDay)));
}

/** 마지막 Create Date 이후, 선택한 주기(요일/일자)가 처음으로 돌아오는 마감일을 계산한다. */
export function computeNextPeriodicDue(lastCreateDateIso, cadence, anchor) {
  const last = parseDateOnly(lastCreateDateIso);
  const jsAnchorDay = (anchor + 1) % 7; // Python weekday(0=월..6=일) -> JS getUTCDay(0=일..6=토)

  if (cadence === "weekly" || cadence === "biweekly") {
    const addDays = cadence === "weekly" ? 1 : 14;
    const d = new Date(last.getTime());
    d.setUTCDate(d.getUTCDate() + addDays);
    while (d.getUTCDay() !== jsAnchorDay) {
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return d;
  }

  if (cadence === "monthly") {
    let year = last.getUTCFullYear();
    let month = last.getUTCMonth() + 1; // 1-based로 다룸
    let candidate = clampDay(year, month, anchor);
    if (candidate <= last) {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
      candidate = clampDay(year, month, anchor);
    }
    return candidate;
  }

  throw new Error(`알 수 없는 주기 종류: ${cadence}`);
}

// ── 저장 규칙 검사 ──────────────────────────────────────────────────────────
// 파일이 첨부되는 트래커(Document 타입)면 실제 파일명을, 파일 첨부 없이 워크아이템 자체가
// 산출물인 트래커(그 외 타입)면 대표 워크아이템(PA) 이름을 트래커명과 비교한다 - 뭐가 됐든
// 워크아이템이 실제로 등록됐으면 이름이 맞는지는 확인해야 한다는 원칙에 따른 것. 아무 것도
// 등록 안 된 경우(itemCount 0, 파일도 없음)만 진짜로 검사 대상이 아니다(null).
export function checkSaveRule(record) {
  const trackerType = record.trackerType;
  const trackerName = record.trackerName;
  const itemCount = record.itemCount || 0;
  const fileName = record.fileName || "";
  const fileExists = hasFile(fileName);
  const paItemName = record.paItemName || "";

  if (itemCount === 0 && !fileExists) return null;
  if (!fileExists && !paItemName) return null; // 비교할 이름 자체가 없는 예외적인 경우

  const reasons = [];
  const detailReasons = [];

  if (trackerType === "Document" && itemCount >= 2) {
    const reason = `파일 ${itemCount}개 등재됨`;
    reasons.push(reason);
    detailReasons.push(reason);
  }

  const pureName = stripProcessTag(trackerName);
  // 파일명이든(예: "...zip") PA 항목 자체 제목이든(업로드한 파일명을 그대로 제목에 옮겨 적어서
  // 확장자가 딸려 들어간 경우), 비교 전에 진짜 파일 확장자만 떼고 비교한다. 그냥 "마지막
  // 점(.) 뒤"를 다 떼면, PA 항목 제목이 "1. Software Qualification Test Specification"처럼
  // 번호를 매긴 경우 "1." 뒤를 통째로 확장자로 오인해서 실제 항목명이 '1'만 남는 오탐이
  // 생긴다 - 그래서 문자로만 이뤄진 짧은 진짜 확장자(zip/docx/pdf 등)로 끝날 때만 뗀다.
  const rawRegisteredName = fileExists ? fileName : paItemName;
  const extMatch = TRAILING_EXTENSION_RE.exec(rawRegisteredName);
  const registeredName = extMatch ? rawRegisteredName.slice(0, extMatch.index) : rawRegisteredName;
  const registeredLabel = fileExists ? "실제 파일명" : "실제 항목명";
  // 등록된 이름 앞에도 트래커명과 같은 프로세스 태그(예: "[SWE.4]")가 그대로 붙어있을 수 있다 -
  // 트래커명과 똑같이 붙은 거라면 문제없는 것으로 보고, 비교 전에 똑같이 떼고 비교한다.
  const registeredNameForCompare = stripProcessTag(registeredName);

  // Test Result/Review Result 트래커는 실행(회차)마다 이름 뒤에 회차 구분용 문구가 붙을 수
  // 있어서(예: "Test Result_Run2"), 뒤에 뭐가 더 붙어있는 건 허용한다 - 다만 트래커명에
  // 해당하는 앞부분은 정확히 일치해야 한다.
  const namingOk = isDateBasedTracker(trackerName)
    ? normalizeForNamingCheck(registeredNameForCompare).startsWith(normalizeForNamingCheck(pureName))
    : normalizeForNamingCheck(pureName) === normalizeForNamingCheck(registeredNameForCompare);

  if (!namingOk) {
    reasons.push(`File Naming Rule 불일치 (${registeredLabel}: '${registeredName}')`);
    detailReasons.push(`File Naming Rule 불일치 (트래커명: '${pureName}', ${registeredLabel}: '${registeredName}')`);
  }

  return { ok: reasons.length === 0, reasons, detailReasons };
}

// ── 버전 규칙 검사 ──────────────────────────────────────────────────────────
// 마지막 Edit 이후 아직 버전업이 안 된 채로 Working Day 10일이 지났는지, "오늘" 기준으로
// 판단한다(주기적/이벤트성 Create Date 검사와 같은 방식) - 예전에 한 번 지연됐더라도 그 뒤에
// 버전업이 끝났으면 이미 해결된 과거 일이므로, 감사를 다시 돌릴 때마다 그 옛날 지연을 계속
// NG로 잡을 필요는 없다는 확인에 따른 것. 마지막 Edit 시점에 이미 그 이후로 버전업이 됐으면
// (versioningIso가 lastEditIso와 같거나 그 이후) 지연 없음으로 본다. 이미 승인/베이스라인까지
// 끝난 상태(FINALIZED_STATUSES)면, 마지막 히스토리 항목이 실제 내용 수정이 아니라 승인/
// 베이스라인 전환 자체일 수 있어서(그 이후로 버전업이 없는 게 당연함) 아예 검사하지 않는다.
export function checkVersionRule(record) {
  if (record.isEventBased) return null;
  if (isDateBasedTracker(record.trackerName)) return null;
  if (FINALIZED_STATUSES.has(record.status)) return null; // 이미 승인/베이스라인 끝남 - 이후 버전업 지연 안 따짐

  const lastEditIso = parseDatetimeIso(record.lastEdit);
  if (!lastEditIso) return null;

  const versioningIso = parseDatetimeIso(record.versioning);
  if (versioningIso && versioningIso >= lastEditIso) {
    return { ok: true, reasons: [], detailReasons: [] };
  }

  const reasons = [];
  const todayIso = formatDateOnly(todayAsUtcDate());
  const businessDays = businessDaysBetween(lastEditIso, todayIso);
  if (businessDays > VERSION_DEADLINE_DAYS) {
    const lastEditDate = formatDateOnly(parseDateOnly(lastEditIso));
    reasons.push(
      `버저닝 지연 (마지막 Edit ${lastEditDate} 이후 아직 버전업 안 됨, ` +
        `오늘까지 영업일 ${businessDays}일 경과, 기준 ${VERSION_DEADLINE_DAYS}일 초과)`
    );
  }

  return { ok: reasons.length === 0, reasons, detailReasons: reasons };
}

// ── 주기적 활동 산출물 Create Date 검사 ─────────────────────────────────────
// PERIODIC_TRACKERS 목록과 비교할 때 공백/언더스코어 차이는 무시한다(예: "Schedule Plan"과
// "Schedule_Plan"을 같은 이름으로 봄) - 단 괄호 안 내용(예: "(실행본)")은 그대로 남기고
// 비교하므로, 괄호 안 단어가 다르면 여전히 다른 산출물로 취급된다. 또한 앞에 차종 코드가
// 붙어도(예: "NQ6 Schedule Plan(실행본)") 매칭되도록 완전 일치 대신 접미사로 비교한다
// (matchConfiguredSuffix) - 다른 하드웨어/상태 규칙 예외 트래커들과 동일한 방식.
function stripWhitespaceAndUnderscore(name) {
  return (name || "").replace(/[\s_]+/g, "");
}

export function checkPeriodicCreateDate(record, cadence, anchor, periodicTrackers) {
  const pureName = stripWhitespaceAndUnderscore(stripProcessTag(record.trackerName));
  const normalizedPeriodicNames = [...periodicTrackers].map(stripWhitespaceAndUnderscore);
  const isPeriodic = matchConfiguredSuffix(pureName, normalizedPeriodicNames) !== null;
  if (!isPeriodic) return null;

  const firstEditIso = parseDatetimeIso(record.firstEdit);
  if (!firstEditIso) return null; // 활동 자체가 없으면(아직 시작 안 한 산출물) 스킵

  const versioningIso = parseDatetimeIso(record.versioning);
  if (!versioningIso) {
    const reasons = ["활동은 있으나 Create Date 미수행"];
    return { ok: false, reasons, detailReasons: reasons };
  }

  const dueDate = computeNextPeriodicDue(versioningIso, cadence, anchor);
  const today = todayAsUtcDate();

  if (today >= dueDate) {
    const versioningDate = formatDateOnly(parseDateOnly(versioningIso));
    const reasons = [`주기적 활동 Create Date 지연 (마지막 Create Date ${versioningDate}, 다음 마감 ${formatDateOnly(dueDate)} 초과)`];
    return { ok: false, reasons, detailReasons: reasons };
  }

  return { ok: true, reasons: [], detailReasons: [] };
}

// ── 이벤트성 산출물 Create Date 검사 ────────────────────────────────────────
export function checkEventbasedCreateDate(record) {
  if (!record.isEventBased) return null;

  const status = record.status;
  if (!EVENTBASED_TERMINAL_STATUSES.has(status)) return null;

  if (!record.createDateCurrent) {
    const reasons = [`상태 '${status}'이나 마지막 수정 이후 Create Date 미수행`];
    return { ok: false, reasons, detailReasons: reasons };
  }

  return { ok: true, reasons: [], detailReasons: [] };
}

// ── 문서 이력 기술 규칙 검사 ────────────────────────────────────────────────
export function checkDocHistoryRule(record) {
  if (record.isEventBased) return null;
  if (isDateBasedTracker(record.trackerName)) return null;

  const itemCount = record.itemCount || 0;
  if (itemCount === 0) return null; // 아직 아무것도 등록 안 됨(파일 미업로드) - 시작 전이라 검사 대상 아님

  const status = record.status;
  if (FINALIZED_STATUSES.has(status)) {
    // 이미 승인/베이스라인 끝났어도, "마지막으로 확인해서 문제없었던 지점" 이후 새로 생긴
    // 버전들에 PR 기재가 빠진 게 없으면 OK로 처리한다(collector.js의
    // findDocHistoryManualCheckReason이 미리 계산해둔 결과). 빠진 게 있으면 PR이 꼭
    // 필요없는 경우일 수도 있어 자동으로 NG를 매기지 않고 N/A로 남긴 채, runAudit이 별도
    // "직접 확인 필요" 목록에 올린다 - 고쳐지기 전까지는 체크포인트가 전진하지 않아 계속
    // 안내된다.
    return record.docHistoryManualCheckReason ? null : { ok: true, reasons: [], detailReasons: [] };
  }

  // 개발 중이라 다시 Open된 경우, 이번에 손댄 내용을 아직 새 버전(baseline)으로 안 올렸으면
  // 지금 codebeamer에 있는 버전 이력 Description은 예전 버전 것이라 이번 작업 중인 PR이
  // 당연히 안 적혀있을 수밖에 없다 - 새 버전을 올린 뒤에야 그 설명에 PR이 제대로 적혔는지
  // 확인하는 게 맞다(checkVersionRule의 "versioningIso가 lastEditIso 이후인지" 판단과 동일).
  const lastEditIso = parseDatetimeIso(record.lastEdit);
  const versioningIso = parseDatetimeIso(record.versioning);
  if (lastEditIso && (!versioningIso || versioningIso < lastEditIso)) return null;

  // 한 번도 승인/베이스라인까지 간 적 없는 문서(첫 승인 전 초기 버전들)는 아직 PR을 기술해야
  // 할 대상은 아니지만("처음 승인되기 전까지는 PR 없이 계속 수정될 수 있다"), 그렇다고 아예
  // 검사를 안 하는 건 아니다 - 버전 이력 Description에 뭐라도(내용이) 적혀있으면 OK, 아예
  // 안 적혀있으면 NG로 본다. collector.js가 baseline 이력에 승인 스탬프가 있었는지로 미리
  // 계산해둔다.
  if (!record.hasEverBeenApproved) {
    const verDescRaw = record.verDesc || "";
    const currentVersion = record.currentVersion || "미업로드";
    if (!verDescRaw) {
      const reasons = [`버전 이력 Description이 작성되지 않음(버전 ${currentVersion})`];
      return { ok: false, reasons, detailReasons: reasons };
    }
    return { ok: true, reasons: [], detailReasons: [] };
  }

  // 이 문서에 실제로 어떤 PR이 연결돼 열려있는지(NCL Related Item 대조)까지는 안 보고, 버전
  // 이력 Description에 PR 번호가 하나라도 적혀있는지 + 그 번호가 NC List에 실제 존재하는지만
  // 본다(완결성 체크) - FINALIZED_STATUSES 브랜치의 판단 방식과 동일하게 통일한 것.
  const reasons = [];
  const verDescRaw = record.verDesc || "";
  const currentVersion = record.currentVersion || "미업로드";
  if (!verDescRaw) {
    reasons.push(`버전 이력 Description이 작성되지 않음(버전 ${currentVersion})`);
  } else {
    const prNums = [];
    PR_IN_DESC_RE.lastIndex = 0;
    let m;
    while ((m = PR_IN_DESC_RE.exec(verDescRaw)) !== null) prNums.push(m[1]);

    if (prNums.length === 0) {
      reasons.push(`버전 이력 Description에 PR 번호가 적혀있지 않음(버전 ${currentVersion})`);
    } else {
      const validPrNumbers = record.validPrNumbers || new Set();
      const invalid = prNums.filter((n) => !validPrNumbers.has(n));
      if (invalid.length > 0) {
        reasons.push(`버전 이력 Description에 적힌 PR 번호(${invalid.join(", ")})가 NC List에서 확인되지 않음(버전 ${currentVersion})`);
      }
    }
  }

  return { ok: reasons.length === 0, reasons, detailReasons: reasons };
}

// ── 상태 규칙 검사 ──────────────────────────────────────────────────────────
export function checkStatusRule(record) {
  if (record.isEventBased) return null;
  if (isDateBasedTracker(record.trackerName)) return null;

  const itemCount = record.itemCount || 0;
  if (itemCount === 0) return null; // 아직 아무것도 등록 안 됨 - 시작 전이라 검사 대상 아님

  const uploadRaw = record.reviewReportUploaded; // true | false | "해당없음"
  if (uploadRaw === "해당없음") {
    return { ok: true, reasons: [], detailReasons: [] };
  }
  if (typeof uploadRaw !== "boolean") return null;

  const statusRaw = record.status;
  const currentVersion = record.currentVersion || "미업로드";
  const reasons = [];

  if (uploadRaw === true) {
    if (!UPLOAD_TRUE_STATUSES.has(statusRaw)) {
      reasons.push(`리뷰레포트 업로드 이후이나 상태가 '${statusRaw}'(버전 ${currentVersion})`);
    }
  } else {
    if (!UPLOAD_FALSE_STATUSES.has(statusRaw)) {
      reasons.push(`리뷰레포트 업로드 이전이나 상태가 '${statusRaw}'(버전 ${currentVersion})`);
    }
  }

  return { ok: reasons.length === 0, reasons, detailReasons: reasons };
}

// ── 리뷰레포트 대상 버전 규칙 검사 ──────────────────────────────────────────

/** 트래커명(프로세스 태그 제거 후, 괄호 한정자는 유지)을 키로 record를 찾을 수 있는 색인을 만든다. */
export function buildTrackerNameIndex(records) {
  const map = new Map();
  for (const r of records) {
    const pure = stripProcessTag(r.trackerName);
    if (pure && !map.has(pure)) map.set(pure, r);
  }
  return map;
}

/**
 * 산출물이 Approved 상태일 때, Review Report에 기재된 대상 문서 버전이 실제 현재 버전과
 * 일치하는지 확인한다. Test Result/Review Result 자체는 대상이 아니고, 짝이 되는
 * "...Test Report"/"...Review Report"가 Approved 될 때 그 문서 쪽에서 짝의 완료일까지
 * 같이 확인한다 (자세한 배경은 wikiTable.js의 nameEndsWith 관련 주석, 그리고 원본
 * C_Audit.py의 같은 함수 docstring 참고).
 */
export function checkReviewReportVersionRule(record, nameIndex) {
  if (isDateBasedTracker(record.trackerName)) return null;

  if (record.status !== "Approved") return null;

  const currentVersion = record.currentVersion;
  const targetVersion = record.targetVersion;
  const reasons = [];

  const hasOwnVersionData = !!(currentVersion && currentVersion !== "미업로드" && targetVersion);
  if (hasOwnVersionData && targetVersion.trim() !== currentVersion.trim()) {
    reasons.push(`Review Report에 기재된 버전(${targetVersion})이 현재 버전(${currentVersion})과 다름`);
  }

  const pureName = stripProcessTag(record.trackerName);
  if (nameEndsWith(pureName, "Report")) {
    const qualifierMatch = TRAILING_QUALIFIER_RE.exec(pureName);
    const qualifierSuffix = qualifierMatch ? qualifierMatch[0] : "";
    const baseWithoutQualifier = stripTrailingQualifier(pureName);
    const siblingName = baseWithoutQualifier.slice(0, -"Report".length) + "Result" + qualifierSuffix;
    const siblingRecord = nameIndex.get(siblingName);

    if (siblingRecord) {
      const siblingUploadRaw = siblingRecord.reviewReportUploaded;
      const actualDate = siblingRecord.testResultClosedDate;
      if (siblingUploadRaw !== "해당없음" && siblingUploadRaw !== true) {
        reasons.push(`${siblingName}의 Review Report가 업로드되지 않음(완료일 ${actualDate || "미확인"})`);
      } else {
        const targetDate = siblingRecord.targetVersion;
        if (actualDate && targetDate && targetDate.trim() !== actualDate.trim()) {
          reasons.push(`Review Report에 기재된 ${siblingName} 완료일(${targetDate})이 실제 완료일(${actualDate})과 다름`);
        }
      }
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reasons, detailReasons: reasons };
  }
  if (!hasOwnVersionData) return null; // 판정불가 - run()에서 별도 안내
  return { ok: true, reasons: [], detailReasons: [] };
}

// ── 메인 실행 ────────────────────────────────────────────────────────────

/**
 * 모든 record에 규칙 검사를 돌려 saveRule/versionRule/docHistoryRule/statusRule
 * (1=OK, 2=NG, null=대상 아님)과 comment(간결한 사유, codebeamer 전송용),
 * detailComment(상세 사유 배열)를 채워 넣는다.
 *
 * @returns {{records, versionCheckFailures: Array<{trackerName, reason, rawSnippet}>, incompleteFetchTrackers: string[], manualStatusCheckTrackers: string[], docHistoryManualCheckTrackers: Array<{trackerName, reason}>}}
 */
export function runAudit(records, options = {}) {
  const {
    cadence = DEFAULT_PERIODIC_CADENCE,
    anchor = DEFAULT_PERIODIC_ANCHOR,
    periodicTrackers = new Set(),
  } = options;

  const nameIndex = buildTrackerNameIndex(records);
  const versionCheckFailures = [];
  const incompleteFetchTrackers = [];
  const manualStatusCheckTrackers = [];
  const docHistoryManualCheckTrackers = [];

  for (const record of records) {
    if (record.itemFetchIncomplete) {
      incompleteFetchTrackers.push(record.trackerName);
    }

    const ngReasons = [];
    const detailNgReasons = [];

    // 저장 규칙
    const saveResult = checkSaveRule(record);
    record.saveRule = saveResult ? (saveResult.ok ? 1 : 2) : null;
    if (saveResult && !saveResult.ok) {
      ngReasons.push(...saveResult.reasons);
      detailNgReasons.push(...saveResult.detailReasons);
    }

    // 버전 규칙 (버전 규칙 + 이벤트성 Create Date + 주기적 Create Date 통합)
    // 주기적 활동 산출물(Schedule Plan(실행본), Project Weekly Meeting Record 등) 검사는
    // 당분간 안 하기로 해서 checkPeriodicCreateDate 호출을 주석 처리 - 필요해지면 복구.
    let verChecked = false;
    const verNgReasons = [];
    const verDetailReasons = [];
    for (const result of [
      checkVersionRule(record),
      checkEventbasedCreateDate(record),
      // checkPeriodicCreateDate(record, cadence, anchor, periodicTrackers),
    ]) {
      if (result === null) continue;
      verChecked = true;
      if (!result.ok) {
        verNgReasons.push(...result.reasons);
        verDetailReasons.push(...result.detailReasons);
      }
    }
    record.versionRule = verChecked ? (verNgReasons.length > 0 ? 2 : 1) : null;
    if (verNgReasons.length > 0) {
      ngReasons.push(...verNgReasons);
      detailNgReasons.push(...verDetailReasons);
    }

    // 문서 이력 기술 규칙
    const docHistResult = checkDocHistoryRule(record);
    record.docHistoryRule = docHistResult ? (docHistResult.ok ? 1 : 2) : null;
    if (docHistResult && !docHistResult.ok) {
      ngReasons.push(...docHistResult.reasons);
      detailNgReasons.push(...docHistResult.detailReasons);
    }
    // checkDocHistoryRule이 승인/베이스라인 완료라서 스킵된(N/A) 경우에 한해, collector.js가
    // 미리 확인해둔 "체크포인트 이후 새 버전 설명에 PR 번호가 빠졌거나 NC List에 없는
    // 번호인지"를 대신 안내 목록에 올린다 - 자동 NG는 아니고 사람이 직접 확인하라는 용도.
    // isEventBased/isDateBasedTracker/itemCount 0/아직 재버전 안 됨 등 다른 이유로 docHistResult가
    // null인 경우는 이 안내 목록의 취지(승인 이후라 자동 판정 불가)와 다르므로 올리지 않는다.
    if (docHistResult === null && FINALIZED_STATUSES.has(record.status) && record.docHistoryManualCheckReason) {
      docHistoryManualCheckTrackers.push({ trackerName: record.trackerName, reason: record.docHistoryManualCheckReason });
    }

    // 상태 규칙 (상태 규칙 + 리뷰 대상 버전 규칙 통합 - 같은 codebeamer 필드로 반영됨)
    let statusChecked = false;
    const statusNgReasons = [];
    const statusDetailReasons = [];

    // STATUS_RULE_MANUAL_CHECK_TRACKERS에 있는 트래커는 상태 규칙을 자동 판정하지 않고
    // 항상 사람이 직접 확인하게 한다 - 자동 OK/NG를 아예 안 매기고 별도 안내 목록에만 올린다.
    // 하드웨어 계열은 이름 앞에 차종 코드가 붙을 수 있어서(예: "NQ6 Hardware Circuit Diagram"),
    // 완전 일치가 아니라 그 이름으로 끝나는지로 비교한다.
    const pureTrackerNameForStatusCheck = stripProcessTag(record.trackerName);
    const needsManualStatusCheck = matchConfiguredSuffix(pureTrackerNameForStatusCheck, STATUS_RULE_MANUAL_CHECK_TRACKERS) !== null;
    if (needsManualStatusCheck) {
      manualStatusCheckTrackers.push(record.trackerName);
    } else {
      const statusResult = checkStatusRule(record);
      if (statusResult !== null) {
        statusChecked = true;
        if (!statusResult.ok) {
          statusNgReasons.push(...statusResult.reasons);
          statusDetailReasons.push(...statusResult.detailReasons);
        }
      }

      const reviewVerResult = checkReviewReportVersionRule(record, nameIndex);
      if (reviewVerResult === null) {
        // Approved인데 리뷰 대상 버전을 자동으로 못 읽은 경우만 "판정 불가" 목록에 안내
        const failReason = record.versionCheckFailReason;
        if (record.status === "Approved" && failReason) {
          versionCheckFailures.push({
            trackerName: record.trackerName,
            reason: failReason,
            rawSnippet: record.versionCheckRawSnippet || "",
          });
        }
      } else {
        statusChecked = true;
        if (!reviewVerResult.ok) {
          statusNgReasons.push(...reviewVerResult.reasons);
          statusDetailReasons.push(...reviewVerResult.detailReasons);
        }
      }
    }

    record.statusRule = statusChecked ? (statusNgReasons.length > 0 ? 2 : 1) : null;
    if (statusNgReasons.length > 0) {
      ngReasons.push(...statusNgReasons);
      detailNgReasons.push(...statusDetailReasons);
    }

    // codebeamer로 나가는 간결한 코멘트. NG가 하나도 없으면 비워둔다(원본 C_Audit.py와 동일하게,
    // "이상 없음" 기본값은 이후 반영 단계에서 채운다 - D_Result_Update 상당 로직 참고). 다만
    // 1) codebeamer 안에 연결된 트래커가 아예 없는 경우(Source Code처럼 실제 산출물이
    //    Bitbucket 등 밖에 있는 경우)는 자동으로 판단 자체가 불가능하니 직접 확인하라고 명시하고,
    // 2) 트래커는 있지만 아무 것도 등록 안 돼서(itemCount 0) 규칙 검사가 전부 스킵된 경우는
    //    "이상 없음"이라고 하면 마치 검사해서 통과한 것처럼 오해할 수 있어서, 감사 대상에서
    //    제외됐다는 걸 명시한다.
    if (record.noLinkedTracker) {
      record.comment = "codebeamer에 연결된 트래커가 없음 - 실제 산출물이 있는 곳(Bitbucket 등)에서 직접 확인 필요";
    } else if (ngReasons.length === 0 && (record.itemCount || 0) === 0) {
      record.comment = "파일이 등재되지 않아 감사 대상에서 제외";
    } else {
      record.comment = ngReasons.join(" / ");
    }
    record.detailComment = detailNgReasons;
  }

  return { records, versionCheckFailures, incompleteFetchTrackers, manualStatusCheckTrackers, docHistoryManualCheckTrackers };
}
