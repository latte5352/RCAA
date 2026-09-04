// codebeamer 비밀번호는 이 확장 어디에도 저장하지 않는다.
// 이 창은 side panel(popup.js)이 연 별도의 큰 창으로, session_id는 chrome.storage.session을 통해 공유받는다.

const API_BASE = "http://localhost:8000";

const params = new URLSearchParams(location.search);
const jobId = params.get("job_id");

const reviewNotice = document.getElementById("reviewNotice");
const unregisteredWrap = document.getElementById("unregisteredWrap");
const unregisteredList = document.getElementById("unregisteredList");
const newTrackersWrap = document.getElementById("newTrackersWrap");
const newTrackersList = document.getElementById("newTrackersList");
const changedTrackersWrap = document.getElementById("changedTrackersWrap");
const changedTrackersList = document.getElementById("changedTrackersList");
const versionFailWrap = document.getElementById("versionFailWrap");
const versionFailList = document.getElementById("versionFailList");
const searchInput = document.getElementById("searchInput");
const selectAllBtn = document.getElementById("selectAllBtn");
const selectNoneBtn = document.getElementById("selectNoneBtn");
const downloadBtn = document.getElementById("downloadBtn");
const matchCount = document.getElementById("matchCount");
const loadingEl = document.getElementById("loading");
const emptyEl = document.getElementById("empty");
const itemsTable = document.getElementById("itemsTable");
const itemsBody = document.getElementById("itemsBody");
const applyBtn = document.getElementById("applyBtn");
const cancelBtn = document.getElementById("cancelBtn");
const statusEl = document.getElementById("status");

let pollTimer = null;

async function getSessionId() {
  const { session_id } = await chrome.storage.session.get("session_id");
  return session_id || null;
}

function setControlsEnabled(enabled) {
  applyBtn.disabled = !enabled;
  cancelBtn.disabled = !enabled;
  selectAllBtn.disabled = !enabled;
  selectNoneBtn.disabled = !enabled;
  itemsBody.querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.disabled = !enabled));
}

function badge(label, isNg) {
  const span = document.createElement("span");
  span.className = `badge ${isNg ? "ng" : "ok"}`;
  span.textContent = label;
  return span;
}

function updateMatchCount() {
  const rows = Array.from(itemsBody.querySelectorAll("tr"));
  const visible = rows.filter((r) => !r.classList.contains("hidden"));
  matchCount.textContent = `${visible.length} / ${rows.length}개 표시 중`;
}

function applySearchFilter() {
  const query = searchInput.value.trim().toLowerCase();
  itemsBody.querySelectorAll("tr").forEach((row) => {
    const hay = row.dataset.searchText;
    row.classList.toggle("hidden", query !== "" && !hay.includes(query));
  });
  updateMatchCount();
}

async function loadItems() {
  const res = await fetch(`${API_BASE}/api/audit-jobs/${jobId}/items`);
  if (!res.ok) throw new Error("항목 목록을 불러오지 못했습니다.");
  const { items } = await res.json();

  loadingEl.classList.add("hidden");
  if (!items.length) {
    emptyEl.classList.remove("hidden");
    return;
  }

  itemsBody.innerHTML = "";
  for (const item of items) {
    const row = document.createElement("tr");
    row.dataset.searchText = `${item.tracker_name} ${item.comment || ""}`.toLowerCase();

    const checkCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.cilId = item.cil_id;
    checkCell.appendChild(checkbox);
    row.appendChild(checkCell);

    const nameCell = document.createElement("td");
    nameCell.className = "col-name";
    nameCell.textContent = item.tracker_name;
    row.appendChild(nameCell);

    const badgesCell = document.createElement("td");
    badgesCell.className = "col-badges";
    badgesCell.appendChild(badge("저장", item.save_rule === 2));
    badgesCell.appendChild(badge("버전", item.version_rule === 2));
    badgesCell.appendChild(badge("이력", item.doc_history_rule === 2));
    badgesCell.appendChild(badge("상태", item.status_rule === 2));
    row.appendChild(badgesCell);

    const commentCell = document.createElement("td");
    commentCell.className = "col-comment";
    commentCell.textContent = item.comment || "";
    row.appendChild(commentCell);

    itemsBody.appendChild(row);
  }

  itemsTable.classList.remove("hidden");
  updateMatchCount();
}

async function loadUnregisteredTrackers() {
  const res = await fetch(`${API_BASE}/api/audit-jobs/${jobId}/unregistered`);
  if (!res.ok) return;
  const { trackers } = await res.json();
  if (!trackers.length) return;
  unregisteredList.innerHTML = "";
  for (const tracker of trackers) {
    const row = document.createElement("div");
    row.className = "row";
    row.textContent = tracker.tracker_name;
    unregisteredList.appendChild(row);
  }
  unregisteredWrap.classList.remove("hidden");
}

async function loadVersionCheckFailures() {
  const res = await fetch(`${API_BASE}/api/audit-jobs/${jobId}/version-check-failures`);
  if (!res.ok) return;
  const { failures } = await res.json();
  if (!failures || !failures.length) return;
  versionFailList.innerHTML = "";
  for (const failure of failures) {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("div");
    name.textContent = failure.tracker_name;
    row.appendChild(name);
    const reason = document.createElement("div");
    reason.className = "version-fail-reason";
    reason.textContent = failure.reason;
    row.appendChild(reason);
    versionFailList.appendChild(row);
  }
  versionFailWrap.classList.remove("hidden");
}

async function loadChanges() {
  const res = await fetch(`${API_BASE}/api/audit-jobs/${jobId}/changes`);
  if (!res.ok) return;
  const { new_trackers, changed_trackers } = await res.json();

  if (new_trackers && new_trackers.length) {
    newTrackersList.innerHTML = "";
    for (const name of new_trackers) {
      const row = document.createElement("div");
      row.className = "row";
      row.textContent = name;
      newTrackersList.appendChild(row);
    }
    newTrackersWrap.classList.remove("hidden");
  }

  if (changed_trackers && changed_trackers.length) {
    changedTrackersList.innerHTML = "";
    for (const change of changed_trackers) {
      const row = document.createElement("div");
      row.className = "row";

      const name = document.createElement("span");
      name.style.fontWeight = "600";
      name.textContent = change.tracker_name;
      row.appendChild(name);

      const detail = document.createElement("span");
      detail.className = "change-detail";
      const parts = [];
      if (change.previous_status !== change.current_status) {
        parts.push(`상태: ${change.previous_status ?? "-"} → ${change.current_status ?? "-"}`);
      }
      if (change.previous_version !== change.current_version) {
        parts.push(`버전: ${change.previous_version ?? "-"} → ${change.current_version ?? "-"}`);
      }
      detail.textContent = parts.length ? `  (${parts.join(" / ")})` : "";
      row.appendChild(detail);

      changedTrackersList.appendChild(row);
    }
    changedTrackersWrap.classList.remove("hidden");
  }
}

searchInput.addEventListener("input", applySearchFilter);

selectAllBtn.addEventListener("click", () => {
  itemsBody.querySelectorAll('tr:not(.hidden) input[type="checkbox"]').forEach((cb) => (cb.checked = true));
});

selectNoneBtn.addEventListener("click", () => {
  itemsBody.querySelectorAll('tr:not(.hidden) input[type="checkbox"]').forEach((cb) => (cb.checked = false));
});

applyBtn.addEventListener("click", async () => {
  const sessionId = await getSessionId();
  if (!sessionId) {
    statusEl.textContent = "로그인이 만료되었습니다. side panel에서 다시 로그인해주세요.";
    return;
  }

  const excludedCilIds = Array.from(itemsBody.querySelectorAll('input[type="checkbox"]'))
    .filter((cb) => !cb.checked)
    .map((cb) => Number(cb.dataset.cilId));

  setControlsEnabled(false);
  statusEl.textContent = "반영 진행 요청 중...";

  const res = await fetch(`${API_BASE}/api/audit-jobs/${jobId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, excluded_cil_ids: excludedCilIds }),
  });
  if (res.status === 401) {
    statusEl.textContent = "로그인이 만료되었습니다. side panel에서 다시 로그인해주세요.";
    return;
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    statusEl.textContent = `반영 요청 실패: ${detail.detail || res.status}`;
    setControlsEnabled(true);
    return;
  }
  pollUntilDone();
});

cancelBtn.addEventListener("click", async () => {
  setControlsEnabled(false);
  statusEl.textContent = "취소 중...";
  await fetch(`${API_BASE}/api/audit-jobs/${jobId}/reject`, { method: "POST" });
  statusEl.textContent = "취소됨 (codebeamer에는 반영되지 않았습니다). 이 창을 닫아도 됩니다.";
});

function pollUntilDone() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    let job;
    try {
      const res = await fetch(`${API_BASE}/api/audit-jobs/${jobId}`);
      job = await res.json();
    } catch (e) {
      statusEl.textContent = "백엔드 서버에 연결할 수 없습니다. 재연결 시도 중...";
      return;
    }
    statusEl.textContent = job.step || job.status;

    if (job.status === "done") {
      clearInterval(pollTimer);
      statusEl.textContent = "완료되었습니다. codebeamer에 반영되었습니다. 이 창을 닫아도 됩니다.";
    } else if (job.status === "failed") {
      clearInterval(pollTimer);
      statusEl.textContent = `실패: ${job.error}`;
    }
  }, 2000);
}

async function init() {
  if (!jobId) {
    loadingEl.textContent = "job_id가 없습니다.";
    return;
  }

  downloadBtn.href = `${API_BASE}/api/audit-jobs/${jobId}/download`;

  try {
    const res = await fetch(`${API_BASE}/api/audit-jobs/${jobId}`);
    const job = await res.json();

    if (job.status !== "awaiting_review") {
      // 이미 반영되었거나 취소된 job을 다시 연 경우 - 항목 선택 UI 없이 현재 상태만 보여준다
      loadingEl.classList.add("hidden");
      emptyEl.classList.remove("hidden");
      emptyEl.textContent = "이 감사는 이미 처리되었습니다.";
      document.getElementById("actionsToolbar").classList.add("hidden");
      statusEl.textContent = job.step || job.status;
      if (job.status === "done" || job.status === "failed") return;
      if (job.status === "applying" || job.status === "collecting") pollUntilDone();
      return;
    }

    reviewNotice.textContent = "감사 규칙 검사까지 끝났습니다. codebeamer에는 아직 아무 것도 반영되지 않았습니다. 아래 목록에서 반영하고 싶지 않은 항목은 체크 해제한 뒤 진행하세요.";
    reviewNotice.classList.remove("hidden");

    await Promise.all([loadItems(), loadUnregisteredTrackers(), loadChanges(), loadVersionCheckFailures()]);
  } catch (e) {
    loadingEl.textContent = "백엔드 서버에 연결할 수 없습니다.";
  }
}

init();
