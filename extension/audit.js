// 이 페이지 하나가 원래 backend(jobs.py의 Phase2~4 + review.html)가 하던 일을 전부 한다.
// 서비스워커가 아니라 사용자가 열어둔 일반 페이지에서 실행되므로, 몇 분 걸리는 감사 작업이
// 중간에 브라우저에 의해 강제 종료될 걱정이 없다.

import { createClient } from "./lib/codebeamerClient.js";
import { collectAuditData } from "./lib/collector.js";
import { runAudit, DEFAULT_PERIODIC_CADENCE, DEFAULT_PERIODIC_ANCHOR } from "./lib/ruleEngine.js";
import { PERIODIC_TRACKERS } from "./lib/periodicTrackers.js";
import { diffAndUpdateHistory } from "./lib/history.js";
import { pushAllResults } from "./lib/pushResults.js";
import { BASE_URL, BASE_URL_V3 } from "./lib/config.js";

const params = new URLSearchParams(location.search);
const projectName = params.get("project");
const cadence = params.get("cadence") || DEFAULT_PERIODIC_CADENCE;
const anchor = params.has("anchor") ? Number(params.get("anchor")) : DEFAULT_PERIODIC_ANCHOR;
const trackerCil = params.get("trackerCil");
const trackerNcl = params.get("trackerNcl");

const progressFill = document.getElementById("progressFill");
const progressStep = document.getElementById("progressStep");
const reviewNotice = document.getElementById("reviewNotice");
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
const selectAllBtn = document.getElementById("selectAllBtn");
const selectNoneBtn = document.getElementById("selectNoneBtn");
const matchCount = document.getElementById("matchCount");
const emptyEl = document.getElementById("empty");
const itemsTable = document.getElementById("itemsTable");
const itemsBody = document.getElementById("itemsBody");
const actionsToolbar = document.getElementById("actionsToolbar");
const applyBtn = document.getElementById("applyBtn");
const cancelBtn = document.getElementById("cancelBtn");
const statusEl = document.getElementById("status");

let auditRecords = [];

function setProgress(pct, text) {
  progressFill.style.width = `${pct}%`;
  progressStep.textContent = text;
}

function badge(label, isNg) {
  const span = document.createElement("span");
  span.className = `badge ${isNg ? "ng" : "ok"}`;
  span.textContent = label;
  return span;
}

function renderItemsTable(records) {
  if (records.length === 0) {
    emptyEl.classList.remove("hidden");
    emptyEl.textContent = "검토할 항목이 없습니다.";
    return;
  }

  itemsBody.innerHTML = "";
  for (const record of records) {
    const row = document.createElement("tr");
    row.dataset.searchText = `${record.trackerName} ${record.comment || ""}`.toLowerCase();

    const checkCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
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

function updateMatchCount() {
  const rows = Array.from(itemsBody.querySelectorAll("tr"));
  const visible = rows.filter((r) => !r.classList.contains("hidden"));
  matchCount.textContent = `${visible.length} / ${rows.length}개 표시 중`;
}

searchInput.addEventListener("input", () => {
  const query = searchInput.value.trim().toLowerCase();
  itemsBody.querySelectorAll("tr").forEach((row) => {
    row.classList.toggle("hidden", query !== "" && !row.dataset.searchText.includes(query));
  });
  updateMatchCount();
});

selectAllBtn.addEventListener("click", () => {
  itemsBody.querySelectorAll('tr:not(.hidden) input[type="checkbox"]').forEach((cb) => (cb.checked = true));
});
selectNoneBtn.addEventListener("click", () => {
  itemsBody.querySelectorAll('tr:not(.hidden) input[type="checkbox"]').forEach((cb) => (cb.checked = false));
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

function setControlsEnabled(enabled) {
  applyBtn.disabled = !enabled;
  cancelBtn.disabled = !enabled;
  selectAllBtn.disabled = !enabled;
  selectNoneBtn.disabled = !enabled;
  itemsBody.querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.disabled = !enabled));
}

applyBtn.addEventListener("click", async () => {
  const { credentials } = await chrome.storage.session.get("credentials");
  if (!credentials) {
    statusEl.textContent = "로그인이 만료되었습니다. side panel에서 다시 로그인해주세요.";
    return;
  }
  const client = createClient({ baseUrl: BASE_URL, baseUrlV3: BASE_URL_V3, ...credentials });

  const excludedCilIds = new Set(
    Array.from(itemsBody.querySelectorAll('input[type="checkbox"]'))
      .filter((cb) => !cb.checked)
      .map((cb) => Number(cb.dataset.cilId))
  );

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
  } catch (e) {
    statusEl.textContent = `반영 중 오류: ${e.message}`;
    setControlsEnabled(true);
  }
});

cancelBtn.addEventListener("click", () => {
  statusEl.textContent = "취소했습니다 (codebeamer에는 반영되지 않았습니다). 이 창을 닫아도 됩니다.";
  setControlsEnabled(false);
});

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

  const client = createClient({ baseUrl: BASE_URL, baseUrlV3: BASE_URL_V3, ...credentials });

  try {
    setProgress(10, "데이터 수집 중 (codebeamer에서 트래커/베이스라인/리뷰레포트 조회)...");
    const { records, unregisteredTrackers } = await collectAuditData(client, {
      projectName, trackerCil, trackerNcl,
    });

    setProgress(60, "감사 규칙 검사 중...");
    const { records: auditedRecords, versionCheckFailures, incompleteFetchTrackers } = runAudit(records, {
      cadence, anchor, periodicTrackers: PERIODIC_TRACKERS,
    });
    auditRecords = auditedRecords;

    setProgress(80, "지난 감사와 비교 중...");
    const { newTrackers, changedTrackers } = await diffAndUpdateHistory(projectName, auditedRecords);

    setProgress(100, "검토 대기 중 (codebeamer에는 아직 반영 안 됨)");

    reviewNotice.textContent = "감사 규칙 검사까지 끝났습니다. codebeamer에는 아직 아무 것도 반영되지 않았습니다. 아래 목록에서 반영하고 싶지 않은 항목은 체크 해제한 뒤 진행하세요.";
    reviewNotice.classList.remove("hidden");

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

    renderItemsTable(auditedRecords);
    actionsToolbar.classList.remove("hidden");
  } catch (e) {
    setProgress(0, `실패: ${e.message}`);
    console.error(e);
  }
}

main();
