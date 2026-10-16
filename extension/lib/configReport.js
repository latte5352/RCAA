// "10월 2일 기준 형상 상태 및 주기적 형상 감사 결과 보고" 형식의 보고서 본문을 만든다.
// 순수 함수로만 구성 - codebeamer 호출이나 storage 접근은 전부 호출하는 쪽(audit.js)이
// 맡고, 여기는 이미 계산된 레코드/스냅샷 데이터를 받아 보고서 텍스트로 조립만 한다.

import { extractProcessTag } from "./wikiTable.js";
import { FINALIZED_STATUSES, EVENTBASED_TERMINAL_STATUSES } from "./ruleEngine.js";

const ALL_RULE_KEYS = ["saveRule", "versionRule", "docHistoryRule", "statusRule"];

// "진행·승인 방향"과 "재검토·재오픈 방향"을 가르는 기준 - 이미 승인/베이스라인/종료 등
// "끝난" 상태였다가 그렇지 않은 상태로 돌아간 경우만 재검토·재오픈으로 본다(예: Approved ->
// Waiting for Approval). 그 외(처음 그 상태에 도달하는 모든 경우 포함)는 전부 진행·승인
// 방향으로 친다. ruleEngine.js가 이미 쓰고 있는 FINALIZED_STATUSES/EVENTBASED_TERMINAL_STATUSES를
// 그대로 재사용한다 - 새 기준을 따로 만들면 나중에 둘이 따로 놀 위험이 있어서.
const FINALIZED_OR_TERMINAL = new Set([...FINALIZED_STATUSES, ...EVENTBASED_TERMINAL_STATUSES]);

function classifyDirection(fromStatus, toStatus) {
  const wasFinal = FINALIZED_OR_TERMINAL.has(fromStatus);
  const isFinal = FINALIZED_OR_TERMINAL.has(toStatus);
  return wasFinal && !isFinal ? "reopen" : "forward";
}

function isNgFound(record) {
  return ALL_RULE_KEYS.some((k) => record[k] === 2);
}

// "PR WorkItem" 칸에서 이미 닫힌 PR은 뺀다 - NC List 항목 자체의 status를 보면 되므로
// (collector.js가 이미 한 번에 불러온 nclItemsResult에서 추출해둔 prStatusByNumber), 예전처럼
// 건마다 /relations를 따로 조회할 필요가 없다. 상태를 모르는 PR(그 사이 NC List에서 지워진
// 경우 등)은 안전하게 그대로 보여준다.
function filterOpenPrWorkItems(prIdList, prStatusByNumber) {
  if (!prStatusByNumber) return prIdList;
  return prIdList.filter((prName) => {
    const m = /(\d+)/.exec(prName || "");
    if (!m) return true;
    const status = prStatusByNumber[m[1]];
    return status !== "Closed";
  });
}

/**
 * 1. 형상 상태 보고 - "마지막으로 반영한 감사" 대비 상태가 실제로 바뀐 산출물들을
 * (이전 상태 → 이후 상태) 쌍으로 묶는다. 버전만 바뀌고 상태는 그대로인 건 제외한다
 * (diffAgainstAppliedSnapshot의 changedTrackers는 버전만 바뀐 것도 포함하므로 여기서 거름).
 * @param {Array} records - 이번 감사 결과 레코드 전체(상태 조회용)
 * @param {string[]} newTrackers - 직전 반영 스냅샷엔 없던 트래커명
 * @param {Array<{trackerName, previousStatus, currentStatus}>} changedTrackers
 */
export function buildStatusChangeGroups(records, newTrackers, changedTrackers) {
  const statusByName = new Map(records.map((r) => [r.trackerName, r.status]));

  const transitions = [];
  for (const name of newTrackers) {
    const currentStatus = statusByName.get(name);
    if (currentStatus == null) continue; // 매칭 레코드가 없으면(Reference 파일 등) 건너뜀
    transitions.push({ trackerName: name, previousStatus: "N/A", currentStatus });
  }
  for (const c of changedTrackers) {
    if (c.previousStatus === c.currentStatus) continue;
    transitions.push({
      trackerName: c.trackerName,
      previousStatus: c.previousStatus ?? "N/A",
      currentStatus: c.currentStatus,
    });
  }

  const groups = new Map();
  for (const t of transitions) {
    const key = `${t.previousStatus}→${t.currentStatus}`;
    if (!groups.has(key)) {
      groups.set(key, {
        from: t.previousStatus,
        to: t.currentStatus,
        direction: classifyDirection(t.previousStatus, t.currentStatus),
        items: [],
      });
    }
    groups.get(key).items.push({ trackerName: t.trackerName, processTag: extractProcessTag(t.trackerName) });
  }

  const allGroups = [...groups.values()];
  for (const g of allGroups) g.items.sort((a, b) => a.trackerName.localeCompare(b.trackerName, "ko"));

  return {
    totalCount: transitions.length,
    forwardGroups: allGroups.filter((g) => g.direction === "forward"),
    reopenGroups: allGroups.filter((g) => g.direction === "reopen"),
  };
}

/**
 * 2. 주기적 형상 감사 - 현재 NG인 항목(수동 확인이 아직 안 끝난 건 제외)을 직전 반영 시점의
 * NG 집합과 비교해 신규/지속/해결 건수를 센다. 아직 사람이 판정해야 하는 항목(직접확인
 * 필요)은 최종 NG/OK가 안 정해졌으므로 집계에선 빼고 따로 모아서 반환한다.
 * @param {Array} records
 * @param {Set<number>} excludedCilIds - 반영 대상에서 체크 해제한 항목(보고서에서도 제외)
 * @param {Set<string>} previousNgNames - 직전 반영 시점에 NG였던 트래커명
 * @param {(record) => Array<{rule, label, reason}>} manualCheckFlagsFn - audit.js의 getManualCheckFlags
 */
export function buildPeriodicNgReport(records, excludedCilIds, previousNgNames, manualCheckFlagsFn) {
  const ngItems = [];
  const pendingItems = [];

  for (const record of records) {
    if (record.isReferenceFile) continue;
    if (record.cilId != null && excludedCilIds.has(record.cilId)) continue;

    const flags = manualCheckFlagsFn(record);
    const unresolved = flags.filter((f) => record[f.rule] == null);
    if (unresolved.length > 0) {
      pendingItems.push({
        trackerName: record.trackerName,
        processTag: extractProcessTag(record.trackerName),
        reasons: unresolved.map((f) => `${f.label}: ${f.reason || "직접 확인 필요"}`),
      });
      continue;
    }

    if (!isNgFound(record)) continue;

    ngItems.push({
      trackerName: record.trackerName,
      processTag: extractProcessTag(record.trackerName),
      status: record.status || "",
      prWorkItems: filterOpenPrWorkItems(record.prIdList || [], record.prStatusByNumber),
      comment: record.comment || "",
    });
  }

  const currentNgNames = new Set(ngItems.map((i) => i.trackerName));
  const newNgCount = [...currentNgNames].filter((n) => !previousNgNames.has(n)).length;
  const persistentNgCount = [...currentNgNames].filter((n) => previousNgNames.has(n)).length;
  const resolvedNgCount = [...previousNgNames].filter((n) => !currentNgNames.has(n)).length;

  ngItems.sort((a, b) => a.trackerName.localeCompare(b.trackerName, "ko"));
  pendingItems.sort((a, b) => a.trackerName.localeCompare(b.trackerName, "ko"));

  return {
    newNgCount, resolvedNgCount, persistentNgCount, totalNgCount: currentNgNames.size,
    ngItems, pendingItems, currentNgNames,
  };
}

function fmtDateBracket(d) {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

function fmtDateKorean(d) {
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

export function buildReportTitle(date) {
  return `[${fmtDateBracket(date)}] 형상 상태 및 주기적 형상 감사 보고`;
}

/** @returns {string} NG 표만 떼어서 복사할 때 쓰는 탭 구분 텍스트(헤더 포함). */
export function buildNgTableText(ngReport) {
  if (ngReport.ngItems.length === 0) return "(NG 항목 없음)";
  const lines = [["Item List", "Process", "WorkItem Status", "PR WorkItem", "Audit Comment"].join("\t")];
  for (const item of ngReport.ngItems) {
    lines.push(
      [
        item.trackerName,
        item.processTag || "-",
        item.status || "-",
        item.prWorkItems.join(", ") || "-",
        (item.comment || "").replace(/\n/g, " "),
      ].join("\t")
    );
  }
  return lines.join("\n");
}

/** @returns {string} 그대로 복사해서 붙여넣을 수 있는 평문 보고서 본문(표는 탭으로 구분). */
export function buildReportBody(date, statusReport, ngReport) {
  const lines = [];
  const renderGroups = (groups) => {
    for (const g of groups) {
      const label = g.from === "N/A" ? `Status N/A → ${g.to}` : `${g.from} → ${g.to}`;
      lines.push(`${label}: ${g.items.length}건`);
      for (const item of g.items) lines.push(`${item.trackerName} - ${item.processTag || "-"}`);
      lines.push("");
    }
  };

  lines.push(`${fmtDateKorean(date)} 기준 형상 상태 및 주기적 형상 감사 결과 보고`);
  lines.push("");
  lines.push("1.형상 상태 보고");
  lines.push("");
  lines.push("[형상 상태 변경 현황]");
  lines.push("");
  lines.push(`전체 상태 변경: ${statusReport.totalCount}건`);
  lines.push("");

  const forwardCount = statusReport.forwardGroups.reduce((s, g) => s + g.items.length, 0);
  lines.push(`진행·승인 방향 변경: ${forwardCount}건`);
  lines.push("");
  renderGroups(statusReport.forwardGroups);

  const reopenCount = statusReport.reopenGroups.reduce((s, g) => s + g.items.length, 0);
  lines.push(`재검토·재오픈 방향 변경: ${reopenCount}건`);
  lines.push("");
  renderGroups(statusReport.reopenGroups);

  lines.push("2.주기적 형상 감사");
  lines.push("");
  lines.push(`신규 NG: ${ngReport.newNgCount}건`);
  lines.push("");
  lines.push(`해결·삭제 NG: ${ngReport.resolvedNgCount}건`);
  lines.push("");
  lines.push(`지속 NG: ${ngReport.persistentNgCount}건`);
  lines.push("");
  lines.push(`현재 총 NG: ${ngReport.totalNgCount}건`);
  lines.push("");
  lines.push("관련 산출물 및 NG 사항은 다음과 같습니다.");
  lines.push("");

  lines.push(buildNgTableText(ngReport));

  return lines.join("\n");
}
