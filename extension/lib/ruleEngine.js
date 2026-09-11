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

import { stripProcessTag, stripTrailingQualifier, nameEndsWith, isDateBasedTracker } from "./wikiTable.js";
import { parseDateOnly, formatDateOnly, businessDaysBetween } from "./businessDays.js";

const TRAILING_QUALIFIER_RE = /(\s*\([^)]*\))+$/;

const EMPTY_FILE_VALUES = new Set(["", "0", "미업로드"]);
const EMPTY_DATE_VALUES = new Set(["", "미업로드"]);
const VERSION_DEADLINE_DAYS = 10; // 2.1) 버전 규칙 준수: 첫 Edit 이후 Working Day 10일 이내 Version Up
const UPLOAD_TRUE_STATUSES = new Set(["Approved", "Internal Baselined", "Gate Baselined", "Waiting for Approval"]);
const UPLOAD_FALSE_STATUSES = new Set(["In Review", "Open"]);
const EVENTBASED_TERMINAL_STATUSES = new Set(["Released", "Read Only"]);
const PR_ID_SPLIT_RE = /[\s,]+/;
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
  // 확장자가 딸려 들어간 경우), 비교 전에 마지막 점(.) 뒤 확장자는 똑같이 떼고 비교한다.
  const rawRegisteredName = fileExists ? fileName : paItemName;
  const registeredName = rawRegisteredName.includes(".")
    ? rawRegisteredName.slice(0, rawRegisteredName.lastIndexOf("."))
    : rawRegisteredName;
  const registeredLabel = fileExists ? "실제 파일명" : "실제 항목명";

  // Test Result/Review Result 트래커는 실행(회차)마다 이름 뒤에 회차 구분용 문구가 붙을 수
  // 있어서(예: "Test Result_Run2"), 뒤에 뭐가 더 붙어있는 건 허용한다 - 다만 트래커명에
  // 해당하는 앞부분은 정확히 일치해야 한다.
  const namingOk = isDateBasedTracker(trackerName)
    ? normalizeForNamingCheck(registeredName).startsWith(normalizeForNamingCheck(pureName))
    : normalizeForNamingCheck(pureName) === normalizeForNamingCheck(registeredName);

  if (!namingOk) {
    reasons.push(`File Naming Rule 불일치 (${registeredLabel}: '${registeredName}')`);
    detailReasons.push(`File Naming Rule 불일치 (트래커명: '${pureName}', ${registeredLabel}: '${registeredName}')`);
  }

  return { ok: reasons.length === 0, reasons, detailReasons };
}

// ── 버전 규칙 검사 ──────────────────────────────────────────────────────────
export function checkVersionRule(record) {
  if (record.isEventBased) return null;
  if (isDateBasedTracker(record.trackerName)) return null;

  const firstEditIso = parseDatetimeIso(record.firstEdit);
  if (!firstEditIso) return null;

  const reasons = [];
  const versioningIso = parseDatetimeIso(record.versioning);

  if (!versioningIso) {
    reasons.push("첫 Edit 이후 버저닝 미수행");
  } else {
    const businessDays = businessDaysBetween(firstEditIso, versioningIso);
    if (businessDays > VERSION_DEADLINE_DAYS) {
      const firstEditDate = formatDateOnly(parseDateOnly(firstEditIso));
      const versioningDate = formatDateOnly(parseDateOnly(versioningIso));
      reasons.push(
        `버저닝 지연 (첫 Edit ${firstEditDate} → 버저닝 ${versioningDate}, ` +
          `영업일 ${businessDays}일 경과, 기준 ${VERSION_DEADLINE_DAYS}일 초과)`
      );
    }
  }

  return { ok: reasons.length === 0, reasons, detailReasons: reasons };
}

// ── 주기적 활동 산출물 Create Date 검사 ─────────────────────────────────────
// PERIODIC_TRACKERS 목록과 비교할 때 공백/언더스코어 차이는 무시한다(예: "Schedule Plan"과
// "Schedule_Plan"을 같은 이름으로 봄) - 단 괄호 안 내용(예: "(실행본)")은 그대로 남기고
// 비교하므로, 괄호 안 단어가 다르면 여전히 다른 산출물로 취급된다.
function stripWhitespaceAndUnderscore(name) {
  return (name || "").replace(/[\s_]+/g, "");
}

export function checkPeriodicCreateDate(record, cadence, anchor, periodicTrackers) {
  const pureName = stripWhitespaceAndUnderscore(stripProcessTag(record.trackerName));
  const isPeriodic = [...periodicTrackers].some((t) => stripWhitespaceAndUnderscore(t) === pureName);
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
  if (status === "Approved") return null; // Approved 상태의 버전은 문서 이력 기술 규칙 전체를 검사하지 않는다

  const prIds = new Set();
  for (const token of (record.prId || "").split(PR_ID_SPLIT_RE)) {
    const t = token.trim();
    if (/^\d+$/.test(t)) prIds.add(Number(t));
  }

  const reasons = [];
  const verDescRaw = record.verDesc || "";
  if (!verDescRaw) {
    const currentVersion = record.currentVersion || "미업로드";
    reasons.push(`버전 이력 Description이 작성되지 않음(버전 ${currentVersion})`);
  }

  const descPrIds = new Set();
  PR_IN_DESC_RE.lastIndex = 0;
  let m;
  while ((m = PR_IN_DESC_RE.exec(verDescRaw)) !== null) {
    descPrIds.add(Number(m[1]));
  }

  const missing = [...prIds].filter((id) => !descPrIds.has(id)).sort((a, b) => a - b);
  if (missing.length > 0) {
    reasons.push(`PR 조치 미기술: ${missing.join(", ")}`);
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
 * @returns {{records, versionCheckFailures: Array<{trackerName, reason}>, incompleteFetchTrackers: string[]}}
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
    let verChecked = false;
    const verNgReasons = [];
    const verDetailReasons = [];
    for (const result of [
      checkVersionRule(record),
      checkEventbasedCreateDate(record),
      checkPeriodicCreateDate(record, cadence, anchor, periodicTrackers),
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

    // 상태 규칙 (상태 규칙 + 리뷰 대상 버전 규칙 통합 - 같은 codebeamer 필드로 반영됨)
    let statusChecked = false;
    const statusNgReasons = [];
    const statusDetailReasons = [];

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
        versionCheckFailures.push({ trackerName: record.trackerName, reason: failReason });
      }
    } else {
      statusChecked = true;
      if (!reviewVerResult.ok) {
        statusNgReasons.push(...reviewVerResult.reasons);
        statusDetailReasons.push(...reviewVerResult.detailReasons);
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

  return { records, versionCheckFailures, incompleteFetchTrackers };
}
