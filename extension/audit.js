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
import { diffAndUpdateHistory } from "./lib/history.js";
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
const incompleteFetchWrap = document.getElementById("incompleteFetchWrap");
const incompleteFetchList = document.getElementById("incompleteFetchList");
const toolbarRow = document.getElementById("toolbarRow");
const searchInput = document.getElementById("searchInput");
const ngOnlyToggle = document.getElementById("ngOnlyToggle");
const selectAllBtn = document.getElementById("selectAllBtn");
const selectNoneBtn = document.getElementById("selectNoneBtn");
const downloadBtn = document.getElementById("downloadBtn");
const matchCount = document.getElementById("matchCount");
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

function handleCollectionProgress({ trackerName, status, completed, total }) {
  if (status === "start") {
    appendLogLine(`  ${trackerName} 조회 중...`, false);
  } else {
    appendLogLine(`✓ ${trackerName} 조회 완료 (${completed}/${total})`, true);
    setProgress(10 + Math.round((completed / total) * 45), `데이터 수집 중... (${completed}/${total})`);
  }
}

function badge(label, isNg) {
  const span = document.createElement("span");
  span.className = `badge ${isNg ? "ng" : "ok"}`;
  span.textContent = label;
  return span;
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
    badgesCell.appendChild(badge("저장", record.saveRule === 2));
    badgesCell.appendChild(badge("버전", record.versionRule === 2));
    badgesCell.appendChild(badge("이력", record.docHistoryRule === 2));
    badgesCell.appendChild(badge("상태", record.statusRule === 2));
    row.appendChild(badgesCell);

    const commentCell = document.createElement("td");
    commentCell.className = "col-comment";
    commentCell.textContent = record.comment || "이상 없음";
    row.appendChild(commentCell);

    itemsBody.appendChild(row);
  }

  itemsTable.classList.remove("hidden");
  toolbarRow.classList.remove("hidden");
  updateMatchCount();
}

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
  const rows = Array.from(itemsBody.querySelectorAll("tr"));
  const visible = rows.filter((r) => !r.classList.contains("hidden"));
  matchCount.textContent = `${visible.length} / ${rows.length}개 표시 중`;
}

function applyFilters() {
  const query = searchInput.value.trim().toLowerCase();
  const ngOnly = ngOnlyToggle.checked;
  itemsBody.querySelectorAll("tr").forEach((row) => {
    const matchesSearch = query === "" || row.dataset.searchText.includes(query);
    const matchesNg = !ngOnly || row.dataset.isNg === "true";
    row.classList.toggle("hidden", !matchesSearch || !matchesNg);
  });
  updateMatchCount();
}

searchInput.addEventListener("input", applyFilters);
ngOnlyToggle.addEventListener("change", applyFilters);

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
});

function renderWarnList(container, items, render) {
  container.innerHTML = "";
  for (const item of items) container.appendChild(render(item));
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
  const client = createClient({ baseUrl: BASE_URL, baseUrlV3: BASE_URL_V3, ...credentials });

  const excludedCilIds = getExcludedCilIds();

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
  const { records, unregisteredTrackers, projectId } = await collectAuditData(client, {
    projectName, trackerCil, trackerNcl, onlyTrackerNames, onProgress: handleCollectionProgress,
  });
  currentProjectId = projectId;
  await applyCmRoleGate(client, projectId, username);

  setProgress(60, "감사 규칙 검사 중...");
  const { records: auditedRecords, versionCheckFailures, incompleteFetchTrackers } = runAudit(records, {
    cadence, anchor, periodicTrackers: PERIODIC_TRACKERS,
  });
  auditRecords = auditedRecords;

  setProgress(80, "지난 감사와 비교 중...");
  const { newTrackers, changedTrackers } = await diffAndUpdateHistory(projectName, auditedRecords);

  warningsData = { unregisteredTrackers, newTrackers, changedTrackers, versionCheckFailures, incompleteFetchTrackers };

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
