// 이 페이지 하나가 원래 backend(jobs.py의 Phase2~4 + review.html)가 하던 일을 전부 한다.
// 서비스워커가 아니라 사용자가 열어둔 일반 페이지에서 실행되므로, 몇 분 걸리는 감사 작업이
// 중간에 브라우저에 의해 강제 종료될 걱정이 없다.
//
// 계산이 끝나는 즉시(반영 전이라도) 검토 화면 상태를 프로젝트별로 저장해둔다(lib/reviewState.js).
// 이 창을 실수로 닫아도 side panel에서 "직전 감사 결과 보기"로 codebeamer 재조회 없이 이어보거나
// 확인할 수 있다.

import { createClient } from "./lib/codebeamerClient.js";
import { collectAuditData } from "./lib/collector.js";
import { runAudit, DEFAULT_PERIODIC_CADENCE, DEFAULT_PERIODIC_ANCHOR } from "./lib/ruleEngine.js";
import { PERIODIC_TRACKERS } from "./lib/periodicTrackers.js";
import { diffAndUpdateHistory, loadHistorySnapshot } from "./lib/history.js";
import { pushAllResults } from "./lib/pushResults.js";
import { saveReviewState, loadReviewState } from "./lib/reviewState.js";
import { checkUserProjectRole } from "./lib/memberRoles.js";
import { BASE_URL, BASE_URL_V3, PROJ_BASE_URL, CM_ROLE_NAME } from "./lib/config.js";

const params = new URLSearchParams(location.search);
const projectName = params.get("project");
const viewMode = params.get("mode") === "view";
const cadence = params.get("cadence") || DEFAULT_PERIODIC_CADENCE;
const anchor = params.has("anchor") ? Number(params.get("anchor")) : DEFAULT_PERIODIC_ANCHOR;
const trackerCil = params.get("trackerCil");
const trackerNcl = params.get("trackerNcl");
const onlyTrackerNames = params.has("onlyTrackers") ? JSON.parse(params.get("onlyTrackers")) : null;

const progressFill = document.getElementById("progressFill");
const progressStep = document.getElementById("progressStep");
const progressLog = document.getElementById("progressLog");
const reviewNotice = document.getElementById("reviewNotice");
const cmRoleBlockWrap = document.getElementById("cmRoleBlockWrap");
const cmRoleBlockMessage = document.getElementById("cmRoleBlockMessage");
const unregisteredWrap = document.getElementById("unregisteredWrap");
const unregisteredList = document.getElementById("unregisteredList");
const newTrackersWrap = document.getElementById("newTrackersWrap");
const newTrackersList = document.getElementById("newTrackersList");
const changedTrackersWrap = document.getElementById("changedTrackersWrap");
const changedTrackersList = document.getElementById("changedTrackersList");
const versionFailWrap = document.getElementById("versionFailWrap");
const versionFailList = document.getElementById("versionFailList");
const manualStatusCheckWrap = document.getElementById("manualStatusCheckWrap");
const manualStatusCheckList = document.getElementById("manualStatusCheckList");
const docHistoryManualCheckWrap = document.getElementById("docHistoryManualCheckWrap");
const docHistoryManualCheckList = document.getElementById("docHistoryManualCheckList");
const incompleteFetchWrap = document.getElementById("incompleteFetchWrap");
const incompleteFetchList = document.getElementById("incompleteFetchList");
const toolbarRow = document.getElementById("toolbarRow");
const legend = document.getElementById("legend");
const searchInput = document.getElementById("searchInput");
const viewFilterSelect = document.getElementById("viewFilterSelect");
const manualOnlyBtn = document.getElementById("manualOnlyBtn");
const selectAllBtn = document.getElementById("selectAllBtn");
const selectNoneBtn = document.getElementById("selectNoneBtn");
const downloadBtn = document.getElementById("downloadBtn");
const matchCount = document.getElementById("matchCount");
const scrollTopBtn = document.getElementById("scrollTopBtn");
const emptyEl = document.getElementById("empty");
const itemsTable = document.getElementById("itemsTable");
const itemsBody = document.getElementById("itemsBody");
const actionsToolbar = document.getElementById("actionsToolbar");
const applyBtn = document.getElementById("applyBtn");
const cancelBtn = document.getElementById("cancelBtn");
const statusEl = document.getElementById("status");

let auditRecords = [];
let warningsData = {
  unregisteredTrackers: [],
  newTrackers: [],
  changedTrackers: [],
  versionCheckFailures: [],
  incompleteFetchTrackers: [],
  manualStatusCheckTrackers: [],
  docHistoryManualCheckTrackers: [],
};
let reviewStatus = "pending"; // "pending" | "applied"
let currentProjectId = null;
let cmRoleBlocked = false;

function setProgress(pct, text) {
  progressFill.style.width = `${pct}%`;
  progressStep.textContent = text;
}

const MAX_LOG_LINES = 300; // 너무 길어지면 브라우저가 느려지니 오래된 줄은 지운다

function appendLogLine(text, isDone) {
  progressLog.classList.remove("hidden");
  const line = document.createElement("div");
  if (isDone) line.className = "log-done";
  line.textContent = text;
  progressLog.appendChild(line);
  while (progressLog.childNodes.length > MAX_LOG_LINES) {
    progressLog.removeChild(progressLog.firstChild);
  }
  progressLog.scrollTop = progressLog.scrollHeight;
}

let phaseAnimTimer = null;
let phaseDotCount = 1;

// NCL-CIL 연결 관계 조회처럼 중간 진행률 업데이트 없이 한 단계가 오래 걸리는 경우, 그동안
// 화면이 멈춘 것처럼 보이지 않게 마지막 phase 줄 끝에 점을 주기적으로 움직여준다. 실제 phase
// 메시지가 오면(evt.phase) 점 개수를 초기화하고, 트래커별 조회 루프로 넘어가면 멈춘다.
function startPhaseAnimation() {
  if (phaseAnimTimer) return;
  phaseAnimTimer = setInterval(() => {
    const lastLine = progressLog.lastElementChild;
    if (!lastLine || lastLine.dataset.phase !== "1") return;
    phaseDotCount = (phaseDotCount % 3) + 1;
    lastLine.textContent = lastLine.dataset.baseText + ".".repeat(phaseDotCount);
  }, 400);
}

function stopPhaseAnimation() {
  if (phaseAnimTimer) {
    clearInterval(phaseAnimTimer);
    phaseAnimTimer = null;
  }
}

function handleCollectionProgress(evt) {
  if (evt.phase) {
    // per-tracker 조회 루프 전 단계(프로젝트/트래커 목록/CIL/베이스라인/NCL 조회 등) - 페이지네이션
    // 때문에 같은 단계가 여러 번 불릴 수 있어서, 직전 줄이 phase 메시지면 새 줄을 추가하는 대신
    // 그 줄을 갱신한다(예: "CIL 조회 중... (100건)" -> "(200건)").
    const baseText = evt.phase.replace(/\.+$/, "");
    const lastLine = progressLog.lastElementChild;
    if (lastLine && lastLine.dataset.phase === "1") {
      lastLine.dataset.baseText = baseText;
      lastLine.textContent = evt.phase;
    } else {
      appendLogLine(evt.phase, false);
      progressLog.lastElementChild.dataset.phase = "1";
      progressLog.lastElementChild.dataset.baseText = baseText;
    }
    phaseDotCount = 1;
    startPhaseAnimation();
    return;
  }
  stopPhaseAnimation();
  const { trackerName, status, completed, total } = evt;
  if (status === "start") {
    appendLogLine(`  ${trackerName} 조회 중...`, false);
  } else {
    appendLogLine(`✓ ${trackerName} 조회 완료 (${completed}/${total})`, true);
    setProgress(10 + Math.round((completed / total) * 45), `데이터 수집 중... (${completed}/${total})`);
  }
}

// isManualPending: 이 규칙이 "직접확인 필요" 대상인데 아직 사람이 판정을 안 고른 상태.
// 그냥 검사 대상이 아니라서 "-"인 경우(na)와 겉보기가 똑같으면, 뭘 직접 봐야 하는지 배지만
// 보고는 구분이 안 된다 - 그래서 이 경우만 따로 색을 준다(amber).
function badge(label, ruleValue, ruleKey, isManualPending) {
  const span = document.createElement("span");
  const kind = isManualPending ? "manual" : ruleValue === 2 ? "ng" : ruleValue === 1 ? "ok" : "na";
  span.className = `badge ${kind}`;
  span.textContent = label;
  if (ruleKey) span.dataset.rule = ruleKey; // 직접확인 입력 시 이 배지를 찾아 미리보기로 갱신하는 용도
  return span;
}

// "직접확인 필요"로 뜨는 두 가지(🙋 상태 규칙 자동 판정 불가, 📝 문서 이력 PR 기재 확인 필요)만
// 여기서 사람이 OK/NG/N-A를 직접 고르고 코멘트를 쓰게 강제한다. 이벤트성/Test Result류/승인
// 완료로 버전 규칙이 아예 스킵되는 경우처럼 "원래 그 규칙 대상이 아닌" N/A는 대상이 아니다 -
// 그런 건 도구가 이미 정확히 판단한 거라 사람이 매번 다시 확인할 이유가 없다.
function getManualCheckFlags(record) {
  const flags = [];
  if ((warningsData.manualStatusCheckTrackers || []).includes(record.trackerName)) {
    flags.push({ rule: "statusRule", label: "상태", reason: null });
  }
  const docHistEntry = (warningsData.docHistoryManualCheckTrackers || []).find(
    (t) => t.trackerName === record.trackerName
  );
  if (docHistEntry) {
    flags.push({ rule: "docHistoryRule", label: "이력", reason: docHistEntry.reason });
  }
  return flags;
}

function createManualRow(record, manualFlags) {
  const tr = document.createElement("tr");
  tr.className = "manual-row";
  tr.dataset.cilId = record.cilId;

  tr.appendChild(document.createElement("td")); // 체크박스 칸 자리 맞추기용 빈 칸

  const content = document.createElement("td");
  content.colSpan = 3;
  content.className = "manual-content";

  const title = document.createElement("div");
  title.className = "manual-title";
  title.textContent = "🙋 직접 확인 필요 - 아래 판정을 입력해야 반영할 수 있습니다";
  content.appendChild(title);

  for (const flag of manualFlags) {
    const fieldRow = document.createElement("div");
    fieldRow.className = "manual-field-row";

    const label = document.createElement("span");
    label.className = "manual-field-label";
    label.textContent = `${flag.label} 규칙:`;
    fieldRow.appendChild(label);

    const select = document.createElement("select");
    select.className = "manual-verdict-select";
    select.dataset.rule = flag.rule;
    select.innerHTML = `
      <option value="">선택해주세요</option>
      <option value="1">OK</option>
      <option value="2">NG</option>
      <option value="0">N/A (해당 없음)</option>
    `;
    fieldRow.appendChild(select);

    if (flag.reason) {
      const reasonSpan = document.createElement("span");
      reasonSpan.className = "manual-field-reason";
      reasonSpan.textContent = `(참고: ${flag.reason})`;
      fieldRow.appendChild(reasonSpan);
    }

    content.appendChild(fieldRow);
  }

  const commentLabel = document.createElement("div");
  commentLabel.className = "manual-comment-label";
  commentLabel.textContent = "직접 확인 코멘트 (위에서 NG를 하나라도 고르면 필수 - 기존 자동 코멘트에 이어붙습니다):";
  content.appendChild(commentLabel);

  const textarea = document.createElement("textarea");
  textarea.className = "manual-comment-input";
  textarea.rows = 2;
  content.appendChild(textarea);

  tr.appendChild(content);
  return tr;
}

// 한 트래커 행(tr)의 왼쪽 색상 표시(빨강=NG 있음, 노랑=직접확인 미입력, 초록=이상 없음)를
// 갱신한다 - 목록이 길 때 한눈에 훑어보기 위한 용도라, 배지 상태가 바뀔 때마다 다시 불러야 한다.
function updateRowAccent(mainRow) {
  const manualRow = mainRow.nextElementSibling;
  const pendingManual = manualRow && manualRow.classList.contains("manual-row")
    && Array.from(manualRow.querySelectorAll(".manual-verdict-select")).some((s) => s.value === "");
  const hasNg = Array.from(mainRow.querySelectorAll(".badge")).some((b) => b.classList.contains("ng"));
  mainRow.classList.remove("row-ng", "row-manual", "row-ok");
  mainRow.classList.add(pendingManual ? "row-manual" : hasNg ? "row-ng" : "row-ok");
}

function renderItemsTable(records, excludedCilIds = new Set()) {
  if (records.length === 0) {
    emptyEl.classList.remove("hidden");
    emptyEl.textContent = "검토할 항목이 없습니다.";
    return;
  }

  itemsBody.innerHTML = "";
  for (const record of records) {
    const row = document.createElement("tr");
    row.dataset.searchText = `${record.trackerName} ${record.comment || ""}`.toLowerCase();
    const isNg = [record.saveRule, record.versionRule, record.docHistoryRule, record.statusRule].includes(2);
    row.dataset.isNg = String(isNg);
    // 규칙별로 위반만 모아보기 필터용 - 각 규칙 값(1=OK, 2=NG, null=대상 아님)을 그대로 저장.
    row.dataset.saveRule = String(record.saveRule);
    row.dataset.versionRule = String(record.versionRule);
    row.dataset.docHistoryRule = String(record.docHistoryRule);
    row.dataset.statusRule = String(record.statusRule);
    // "직접확인 필요만 보기" 필터용 - 이 트래커가 사람이 직접 판정해야 하는 항목(🙋/📝)인지.
    const manualFlags = getManualCheckFlags(record);
    const manualRuleKeys = new Set(manualFlags.map((f) => f.rule));
    row.dataset.hasManual = String(manualFlags.length > 0);

    const checkCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !excludedCilIds.has(record.cilId);
    checkbox.dataset.cilId = record.cilId;
    checkCell.appendChild(checkbox);
    row.appendChild(checkCell);

    const nameCell = document.createElement("td");
    nameCell.className = "col-name";
    nameCell.textContent = record.trackerName;
    row.appendChild(nameCell);

    const badgesCell = document.createElement("td");
    badgesCell.className = "col-badges";
    const badgesGrid = document.createElement("div");
    badgesGrid.className = "badges-grid";
    badgesGrid.appendChild(badge("저장", record.saveRule, "saveRule", manualRuleKeys.has("saveRule")));
    badgesGrid.appendChild(badge("버전", record.versionRule, "versionRule", manualRuleKeys.has("versionRule")));
    badgesGrid.appendChild(badge("이력", record.docHistoryRule, "docHistoryRule", manualRuleKeys.has("docHistoryRule")));
    badgesGrid.appendChild(badge("상태", record.statusRule, "statusRule", manualRuleKeys.has("statusRule")));
    badgesCell.appendChild(badgesGrid);
    row.appendChild(badgesCell);

    const commentCell = document.createElement("td");
    commentCell.className = "col-comment" + (record.comment ? "" : " default");
    commentCell.textContent = record.comment || "이상 없음";
    if (record.comment) commentCell.title = record.comment;
    row.appendChild(commentCell);

    itemsBody.appendChild(row);

    if (manualFlags.length > 0) {
      itemsBody.appendChild(createManualRow(record, manualFlags));
    }
    updateRowAccent(row);
  }

  itemsTable.classList.remove("hidden");
  toolbarRow.classList.remove("hidden");
  legend.classList.remove("hidden");
  updateMatchCount();
  updateStickyOffsets();
}

// 검색창/필터 버튼(#toolbarRow)과 표 헤더(thead)가 header 아래에 겹치지 않고 딱 붙어서
// 스크롤을 오래 내려도 계속 보이게, 실제 렌더된 높이를 읽어 CSS 변수로 넘긴다.
function updateStickyOffsets() {
  document.documentElement.style.setProperty("--header-h", `${document.querySelector("header").offsetHeight}px`);
  document.documentElement.style.setProperty("--toolbar-h", `${toolbarRow.offsetHeight}px`);
}
window.addEventListener("resize", updateStickyOffsets);

window.addEventListener("scroll", () => {
  scrollTopBtn.classList.toggle("hidden", window.scrollY < 400);
});
scrollTopBtn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

const BOM = "﻿"; // 엑셀에서 CSV를 열었을 때 한글이 깨지지 않게 하는 UTF-8 BOM

function csvField(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function ruleLabel(value) {
  return value === 2 ? "NG" : value === 1 ? "OK" : "-";
}

function downloadRecordsAsCsv() {
  const header = ["트래커명", "저장", "버전", "이력", "상태", "현재 버전", "감사 코멘트", "CIL ID"];
  const lines = [header.map(csvField).join(",")];
  for (const r of auditRecords) {
    lines.push([
      r.trackerName,
      ruleLabel(r.saveRule),
      ruleLabel(r.versionRule),
      ruleLabel(r.docHistoryRule),
      ruleLabel(r.statusRule),
      r.currentVersion || "",
      r.comment || "이상 없음",
      r.cilId ?? "",
    ].map(csvField).join(","));
  }
  // BOM(U+FEFF)을 붙여야 엑셀에서 열었을 때 한글이 안 깨진다.
  const blob = new Blob([BOM + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const safeProject = (projectName || "project").replace(/[\\/:*?"<>|]/g, "_");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const a = document.createElement("a");
  a.href = url;
  a.download = `SUP8_감사결과_${safeProject}_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

downloadBtn.addEventListener("click", downloadRecordsAsCsv);

function updateMatchCount() {
  // .manual-row는 별도 트래커 행이 아니라 그 앞 행의 "직접확인 입력창"이라 개수에서 뺀다.
  const rows = Array.from(itemsBody.querySelectorAll("tr:not(.manual-row)"));
  const visible = rows.filter((r) => !r.classList.contains("hidden"));
  matchCount.textContent = `${visible.length} / ${rows.length}개 표시 중`;
}

let manualOnlyActive = false;

function applyFilters() {
  const query = searchInput.value.trim().toLowerCase();
  const view = viewFilterSelect.value; // "" | "ng" | "saveRule" | "versionRule" | "docHistoryRule" | "statusRule"
  itemsBody.querySelectorAll("tr:not(.manual-row)").forEach((row) => {
    const matchesSearch = query === "" || row.dataset.searchText.includes(query);
    let matchesView;
    if (view === "") matchesView = true; // 전체 보기
    else if (view === "ng") matchesView = row.dataset.isNg === "true"; // 전체 규칙 중 하나라도 NG
    else matchesView = row.dataset[view] === "2"; // 특정 규칙만 NG
    const matchesManual = !manualOnlyActive || row.dataset.hasManual === "true";
    const hidden = !matchesSearch || !matchesView || !matchesManual;
    row.classList.toggle("hidden", hidden);
    // 바로 다음이 이 행의 "직접확인 입력창"(.manual-row)이면 같이 보이고/숨겨지게 한다.
    const next = row.nextElementSibling;
    if (next && next.classList.contains("manual-row")) next.classList.toggle("hidden", hidden);
  });
  updateMatchCount();
}

searchInput.addEventListener("input", applyFilters);
viewFilterSelect.addEventListener("change", applyFilters);
manualOnlyBtn.addEventListener("click", () => {
  manualOnlyActive = !manualOnlyActive;
  manualOnlyBtn.classList.toggle("active", manualOnlyActive);
  applyFilters();
});

function getExcludedCilIds() {
  return new Set(
    Array.from(itemsBody.querySelectorAll('input[type="checkbox"]'))
      .filter((cb) => !cb.checked)
      .map((cb) => Number(cb.dataset.cilId))
  );
}

async function persistReviewState(status) {
  reviewStatus = status;
  await saveReviewState(projectName, {
    savedAt: new Date().toISOString(),
    status,
    params: { cadence, anchor, trackerCil, trackerNcl, onlyTrackerNames, projectId: currentProjectId },
    records: auditRecords,
    warnings: warningsData,
    excludedCilIds: Array.from(getExcludedCilIds()),
  });
}

function persistSelectionIfPending() {
  if (reviewStatus === "applied") return;
  persistReviewState("pending");
}

selectAllBtn.addEventListener("click", () => {
  itemsBody.querySelectorAll('tr:not(.hidden) input[type="checkbox"]').forEach((cb) => (cb.checked = true));
  persistSelectionIfPending();
});
selectNoneBtn.addEventListener("click", () => {
  itemsBody.querySelectorAll('tr:not(.hidden) input[type="checkbox"]').forEach((cb) => (cb.checked = false));
  persistSelectionIfPending();
});
itemsBody.addEventListener("change", (e) => {
  if (e.target.matches('input[type="checkbox"]')) persistSelectionIfPending();
  if (e.target.matches(".manual-verdict-select")) {
    // 사람이 고른 판정을 위쪽 배지에 미리보기로 반영한다(실제 record는 반영 버튼 누를 때
    // 합쳐짐 - persistReviewState도 그때 저장되므로, 이 미리보기는 새로고침하면 사라진다).
    const manualRow = e.target.closest("tr.manual-row");
    const mainRow = manualRow.previousElementSibling;
    const rule = e.target.dataset.rule;
    const badgeEl = mainRow.querySelector(`.badge[data-rule="${rule}"]`);
    // ""(아직 선택 안 함)은 여전히 "직접확인 필요" amber로 남겨두고, "0"(사람이 N/A로 명시적
    // 판정)만 na 회색으로 바꾼다 - 안 그러면 "아직 안 고름"과 "직접 N/A로 판정함"이 똑같아 보인다.
    const kind = e.target.value === "2" ? "ng" : e.target.value === "1" ? "ok" : e.target.value === "0" ? "na" : "manual";
    if (badgeEl) badgeEl.className = `badge ${kind}`;
    manualRow.classList.remove("problem");
    updateRowAccent(mainRow);
  }
});

function renderWarnList(container, items, render) {
  container.innerHTML = "";
  for (const item of items) container.appendChild(render(item));
  const wrap = container.closest(".warn");
  const countEl = wrap && wrap.querySelector(".warn-count");
  if (countEl) countEl.textContent = `(${items.length})`;
}

function simpleRow(text) {
  const row = document.createElement("div");
  row.className = "row";
  row.textContent = text;
  return row;
}

function renderWarnings(data) {
  const {
    unregisteredTrackers = [],
    newTrackers = [],
    changedTrackers = [],
    versionCheckFailures = [],
    incompleteFetchTrackers = [],
    manualStatusCheckTrackers = [],
    docHistoryManualCheckTrackers = [],
  } = data;

  if (unregisteredTrackers.length) {
    renderWarnList(unregisteredList, unregisteredTrackers, (t) => simpleRow(t.trackerName));
    unregisteredWrap.classList.remove("hidden");
  }
  if (newTrackers.length) {
    renderWarnList(newTrackersList, newTrackers, (name) => simpleRow(name));
    newTrackersWrap.classList.remove("hidden");
  }
  if (changedTrackers.length) {
    renderWarnList(changedTrackersList, changedTrackers, (c) => {
      const row = document.createElement("div");
      row.className = "row";
      const name = document.createElement("span");
      name.style.fontWeight = "600";
      name.textContent = c.trackerName;
      row.appendChild(name);
      const parts = [];
      if (c.previousStatus !== c.currentStatus) parts.push(`상태: ${c.previousStatus ?? "-"} → ${c.currentStatus ?? "-"}`);
      if (c.previousVersion !== c.currentVersion) parts.push(`버전: ${c.previousVersion ?? "-"} → ${c.currentVersion ?? "-"}`);
      const detail = document.createElement("span");
      detail.className = "change-detail";
      detail.textContent = parts.length ? `  (${parts.join(" / ")})` : "";
      row.appendChild(detail);
      return row;
    });
    changedTrackersWrap.classList.remove("hidden");
  }
  if (versionCheckFailures.length) {
    renderWarnList(versionFailList, versionCheckFailures, (f) => {
      const row = document.createElement("div");
      row.className = "row";
      const name = document.createElement("div");
      name.textContent = f.trackerName;
      row.appendChild(name);
      const reason = document.createElement("div");
      reason.className = "version-fail-reason";
      reason.textContent = f.reason;
      row.appendChild(reason);
      return row;
    });
    versionFailWrap.classList.remove("hidden");
  }
  if (manualStatusCheckTrackers.length) {
    renderWarnList(manualStatusCheckList, manualStatusCheckTrackers, (name) => simpleRow(name));
    manualStatusCheckWrap.classList.remove("hidden");
  }
  if (docHistoryManualCheckTrackers.length) {
    renderWarnList(docHistoryManualCheckList, docHistoryManualCheckTrackers, (f) => {
      const row = document.createElement("div");
      row.className = "row";
      const name = document.createElement("div");
      name.textContent = f.trackerName;
      row.appendChild(name);
      const reason = document.createElement("div");
      reason.className = "version-fail-reason";
      reason.textContent = f.reason;
      row.appendChild(reason);
      return row;
    });
    docHistoryManualCheckWrap.classList.remove("hidden");
  }
  if (incompleteFetchTrackers.length) {
    renderWarnList(incompleteFetchList, incompleteFetchTrackers, (name) => simpleRow(name));
    incompleteFetchWrap.classList.remove("hidden");
  }
}

function setControlsEnabled(enabled) {
  applyBtn.disabled = !enabled;
  cancelBtn.disabled = !enabled;
  selectAllBtn.disabled = !enabled;
  selectNoneBtn.disabled = !enabled;
  itemsBody.querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.disabled = !enabled));
}

// "직접확인 필요" 입력창(.manual-row) 하나당 그 위 트래커 행, 고른 판정들, 코멘트를 모아 반환한다.
function collectManualRowInputs() {
  return Array.from(itemsBody.querySelectorAll("tr.manual-row")).map((manualRow) => {
    const mainRow = manualRow.previousElementSibling;
    const verdicts = {};
    manualRow.querySelectorAll(".manual-verdict-select").forEach((select) => {
      verdicts[select.dataset.rule] = select.value; // "" | "0"(N/A) | "1"(OK) | "2"(NG)
    });
    const comment = manualRow.querySelector(".manual-comment-input").value.trim();
    return { cilId: Number(manualRow.dataset.cilId), mainRow, manualRow, verdicts, comment };
  });
}

// 반영 대상(체크된 것)에 한해서만 검증한다 - 체크 해제해서 이번엔 안 올릴 항목까지 억지로
// 채우게 하면 안 되므로. 문제가 있으면 그 입력창에 problem 표시를 남기고, 문제 목록을 반환한다.
function validateManualInputs(excludedCilIds) {
  const problems = [];
  for (const entry of collectManualRowInputs()) {
    entry.manualRow.classList.remove("problem");
    if (excludedCilIds.has(entry.cilId)) continue;

    const trackerName = entry.mainRow.querySelector(".col-name").textContent;
    const values = Object.values(entry.verdicts);
    if (values.some((v) => v === "")) {
      problems.push({ trackerName, reason: "직접확인 판정을 다 선택해주세요", row: entry.manualRow });
      continue;
    }
    if (values.includes("2") && !entry.comment) {
      problems.push({ trackerName, reason: "NG로 판정한 항목이 있어 코멘트를 적어야 합니다", row: entry.manualRow });
    }
  }
  for (const p of problems) p.row.classList.add("problem");
  return problems;
}

function showManualValidationProblems(problems) {
  statusEl.innerHTML = "";
  const title = document.createElement("div");
  title.className = "validation-title";
  title.textContent = "⚠ 반영하기 전에 아래 \"직접확인\" 항목을 먼저 채워주세요:";
  statusEl.appendChild(title);
  for (const p of problems) {
    const line = document.createElement("div");
    line.className = "validation-line";
    line.textContent = `- ${p.trackerName}: ${p.reason}`;
    statusEl.appendChild(line);
  }
  problems[0].row.scrollIntoView({ behavior: "smooth", block: "center" });
}

// 검증을 통과한 뒤, 사람이 고른 직접확인 판정/코멘트를 실제 record에 합쳐 넣는다. 자동으로
// 만들어진 코멘트(ngReasons)는 절대 지우지 않고 뒤에 이어붙인다 - 안 그러면 이미 적혀있던
// 자동 NG 사유(예: 상태 규칙 위반)가 사람이 새로 적은 코멘트로 덮여 사라져버린다.
function applyManualInputsToRecords(excludedCilIds) {
  for (const entry of collectManualRowInputs()) {
    if (excludedCilIds.has(entry.cilId)) continue;
    const record = auditRecords.find((r) => r.cilId === entry.cilId);
    if (!record) continue;

    for (const [rule, value] of Object.entries(entry.verdicts)) {
      record[rule] = value === "1" ? 1 : value === "2" ? 2 : null; // "0"(N/A)과 ""는 둘 다 null
    }
    if (entry.comment) {
      const addition = `[직접확인] ${entry.comment}`;
      record.comment = record.comment ? `${record.comment} / ${addition}` : addition;
    }
  }
}

applyBtn.addEventListener("click", async () => {
  if (cmRoleBlocked) {
    statusEl.textContent = `CM 권한이 없어서 반영할 수 없습니다.`;
    return;
  }
  const { credentials } = await chrome.storage.session.get("credentials");
  if (!credentials) {
    statusEl.textContent = "로그인이 만료되었습니다. side panel에서 다시 로그인해주세요.";
    return;
  }

  const excludedCilIds = getExcludedCilIds();

  const problems = validateManualInputs(excludedCilIds);
  if (problems.length > 0) {
    showManualValidationProblems(problems);
    return;
  }
  applyManualInputsToRecords(excludedCilIds);

  const client = createClient({ baseUrl: BASE_URL, baseUrlV3: BASE_URL_V3, ...credentials });

  setControlsEnabled(false);
  statusEl.textContent = "codebeamer에 반영 중...";

  try {
    const summary = await pushAllResults(client, auditRecords, excludedCilIds, (done, total) => {
      statusEl.textContent = `codebeamer에 반영 중... (${done}/${total})`;
    });

    let text = `완료되었습니다. codebeamer에 반영되었습니다. (반영: ${summary.updated}건`;
    if (summary.duplicateSkipped > 0) text += `, 동일 사유로 생략: ${summary.duplicateSkipped}건`;
    if (summary.fetchFailed > 0) text += `, 조회 실패: ${summary.fetchFailed}건`;
    text += ")";
    statusEl.textContent = text;

    if (summary.duplicateSkipped > 0) {
      statusEl.appendChild(document.createElement("br"));
      const list = document.createElement("span");
      list.style.fontSize = "12px";
      list.style.color = "#888";
      list.textContent = "생략된 항목: " + summary.duplicateSkippedTrackers.join(", ");
      statusEl.appendChild(list);
    }

    await persistReviewState("applied");
  } catch (e) {
    statusEl.textContent = `반영 중 오류: ${e.message}`;
    setControlsEnabled(true);
  }
});

cancelBtn.addEventListener("click", () => {
  if (reviewStatus !== "applied") {
    statusEl.textContent = "취소했습니다 (codebeamer에는 반영되지 않았습니다). 이 창을 닫아도 됩니다.";
  }
  setControlsEnabled(false);
  cancelBtn.disabled = false;
});

// codebeamer 정식 REST API가 아니라 프로젝트 멤버 화면이 내부적으로 쓰는 비공식 엔드포인트를
// 붙여서 확인하는 거라(lib/memberRoles.js 참고) 100% 신뢰할 순 없지만, "이 계정은 CM 권한이
// 없다"고 확실히 판정된 경우(found && !hasRole)만 반영 자체를 막는다 - 조회 실패/계정을
// 못 찾은 경우(판단 불가)까지 막아버리면 이 비공식 엔드포인트 하나 때문에 정상적인 반영까지
// 전부 막힐 수 있어서, 그런 경우는 막지 않는다.
async function applyCmRoleGate(client, projectId, username) {
  if (!projectId || !username) return;
  const result = await checkUserProjectRole(client, {
    projBaseUrl: PROJ_BASE_URL,
    projectId,
    username,
    roleName: CM_ROLE_NAME,
  });
  if (result.found && !result.hasRole) {
    cmRoleBlocked = true;
    cmRoleBlockMessage.textContent = `이 계정(${username})은 이 프로젝트에서 ${CM_ROLE_NAME} 권한이 없어서 codebeamer에 반영할 수 없습니다. CM 권한이 있는 계정으로 다시 로그인해주세요.`;
    cmRoleBlockWrap.classList.remove("hidden");
    applyBtn.disabled = true;
  }
}

async function runNewAudit(client, username) {
  const scopeText = onlyTrackerNames && onlyTrackerNames.length
    ? `선택한 트래커 ${onlyTrackerNames.length}개만`
    : "전체 트래커";
  setProgress(10, `데이터 수집 중 (${scopeText} - codebeamer에서 트래커/베이스라인/리뷰레포트 조회)...`);
  // "마지막으로 확인해서 문제없었던 버전 이후 새로 생긴 버전에 PR 기재가 빠졌는지" 확인하려면
  // 데이터 수집 단계에서부터 그 체크포인트를 알아야 한다 - diffAndUpdateHistory는 이번 결과로
  // 스냅샷을 덮어써버리므로, 그 전에 먼저 읽기 전용으로 조회해둔다.
  const previousSnapshot = await loadHistorySnapshot(projectName);
  const docHistoryCheckpoints = {};
  // 트래커명이 바뀌어도 체크포인트를 잃지 않도록, ID 기준으로도 같은 값을 찾을 수 있게
  // 별도 맵을 만들어둔다(트래커명으로 못 찾을 때만 collector.js에서 이걸로 대체 조회).
  const docHistoryCheckpointsById = {};
  for (const [name, entry] of Object.entries(previousSnapshot)) {
    docHistoryCheckpoints[name] = entry.docHistoryCheckedVersion;
    if (entry.trackerId) docHistoryCheckpointsById[entry.trackerId] = entry.docHistoryCheckedVersion;
  }
  const { records, unregisteredTrackers, projectId } = await collectAuditData(client, {
    projectName, trackerCil, trackerNcl, onlyTrackerNames, onProgress: handleCollectionProgress,
    docHistoryCheckpoints, docHistoryCheckpointsById,
  });
  currentProjectId = projectId;
  await applyCmRoleGate(client, projectId, username);

  setProgress(60, "감사 규칙 검사 중...");
  const {
    records: auditedRecords, versionCheckFailures, incompleteFetchTrackers, manualStatusCheckTrackers, docHistoryManualCheckTrackers,
  } = runAudit(records, {
    cadence, anchor, periodicTrackers: PERIODIC_TRACKERS,
  });
  auditRecords = auditedRecords;

  setProgress(80, "지난 감사와 비교 중...");
  const { newTrackers, changedTrackers } = await diffAndUpdateHistory(projectName, auditedRecords);

  warningsData = {
    unregisteredTrackers, newTrackers, changedTrackers, versionCheckFailures, incompleteFetchTrackers,
    manualStatusCheckTrackers, docHistoryManualCheckTrackers,
  };

  setProgress(100, "검토 대기 중 (codebeamer에는 아직 반영 안 됨)");

  const scopeNotice = onlyTrackerNames && onlyTrackerNames.length
    ? ` (선택한 트래커 ${onlyTrackerNames.length}개만 감사했습니다)`
    : "";
  reviewNotice.textContent = `감사 규칙 검사까지 끝났습니다.${scopeNotice} codebeamer에는 아직 아무 것도 반영되지 않았습니다. 아래 목록에서 반영하고 싶지 않은 항목은 체크 해제한 뒤 진행하세요. (이 창을 실수로 닫아도 side panel에서 "직전 감사 결과 보기"로 이어볼 수 있습니다.)`;
  reviewNotice.classList.remove("hidden");

  renderWarnings(warningsData);
  renderItemsTable(auditRecords);
  actionsToolbar.classList.remove("hidden");

  await persistReviewState("pending");
}

async function renderStoredReview(state, client, username) {
  auditRecords = state.records || [];
  warningsData = state.warnings || {};
  reviewStatus = state.status || "pending";
  currentProjectId = (state.params || {}).projectId || null;

  const when = new Date(state.savedAt).toLocaleString("ko-KR");
  setProgress(100, `저장된 감사 결과 (저장 시각: ${when})`);

  const storedOnlyTrackerNames = (state.params || {}).onlyTrackerNames;
  const scopeNotice = storedOnlyTrackerNames && storedOnlyTrackerNames.length
    ? ` 선택한 트래커 ${storedOnlyTrackerNames.length}개만 대상으로 한 감사입니다.`
    : "";

  if (reviewStatus !== "applied") {
    await applyCmRoleGate(client, currentProjectId, username);
  }

  renderWarnings(warningsData);
  renderItemsTable(auditRecords, new Set(state.excludedCilIds || []));
  actionsToolbar.classList.remove("hidden");

  if (reviewStatus === "applied") {
    reviewNotice.textContent = `이 감사는 이미 codebeamer에 반영되었습니다 (저장 시각: ${when}).${scopeNotice} 결과 확인만 가능하며, 다시 반영할 수는 없습니다.`;
    reviewNotice.classList.remove("hidden");
    setControlsEnabled(false);
    applyBtn.classList.add("hidden");
    cancelBtn.disabled = false;
  } else {
    reviewNotice.textContent = `직전에 저장된 검토 화면을 codebeamer 재조회 없이 그대로 불러왔습니다 (저장 시각: ${when}).${scopeNotice} 아직 반영되지 않았으니 이어서 진행하세요.`;
    reviewNotice.classList.remove("hidden");
  }
}

async function main() {
  if (!projectName) {
    setProgress(0, "project 파라미터가 없습니다.");
    return;
  }

  const { credentials } = await chrome.storage.session.get("credentials");
  if (!credentials) {
    setProgress(0, "로그인이 필요합니다. side panel에서 로그인해주세요.");
    return;
  }

  try {
    const client = createClient({ baseUrl: BASE_URL, baseUrlV3: BASE_URL_V3, ...credentials });

    if (viewMode) {
      const state = await loadReviewState(projectName);
      if (!state) {
        setProgress(0, "저장된 감사 결과가 없습니다. side panel에서 새 감사를 실행해주세요.");
        return;
      }
      await renderStoredReview(state, client, credentials.username);
      return;
    }

    await runNewAudit(client, credentials.username);
  } catch (e) {
    setProgress(0, `실패: ${e.message}`);
    console.error(e);
  }
}

main();
