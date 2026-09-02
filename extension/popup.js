// codebeamer 비밀번호는 이 확장 어디에도 저장하지 않는다.
// 로그인 시 백엔드로 1회 전송해 검증받고, 이후에는 발급받은 session_id만 보관/사용한다.

const API_BASE = "http://localhost:8000";

const loginView = document.getElementById("loginView");
const runView = document.getElementById("runView");
const errorEl = document.getElementById("error");
const progressWrap = document.getElementById("progressWrap");
const progressFill = document.getElementById("progressFill");
const stepEl = document.getElementById("step");
const projectSelect = document.getElementById("projectSelect");
const cadenceSelect = document.getElementById("cadenceSelect");
const weekdaySelect = document.getElementById("weekdaySelect");
const dayOfMonthSelect = document.getElementById("dayOfMonthSelect");
const downloadLink = document.getElementById("downloadLink");
const reviewNotice = document.getElementById("reviewNotice");
const reviewActions = document.getElementById("reviewActions");
const approveBtn = document.getElementById("approveBtn");
const rejectBtn = document.getElementById("rejectBtn");
const selectActions = document.getElementById("selectActions");
const selectAllBtn = document.getElementById("selectAllBtn");
const selectNoneBtn = document.getElementById("selectNoneBtn");
const itemsList = document.getElementById("itemsList");
const unregisteredWrap = document.getElementById("unregisteredWrap");
const unregisteredList = document.getElementById("unregisteredList");
const newTrackersWrap = document.getElementById("newTrackersWrap");
const newTrackersList = document.getElementById("newTrackersList");
const changedTrackersWrap = document.getElementById("changedTrackersWrap");
const changedTrackersList = document.getElementById("changedTrackersList");
const versionFailWrap = document.getElementById("versionFailWrap");
const versionFailList = document.getElementById("versionFailList");

let currentJobId = null;
let pollTimer = null;

function showError(message) {
  errorEl.textContent = message;
}

async function getSessionId() {
  const { session_id } = await chrome.storage.session.get("session_id");
  return session_id || null;
}

async function setSessionId(sessionId) {
  await chrome.storage.session.set({ session_id: sessionId });
}

async function clearSessionId() {
  await chrome.storage.session.remove("session_id");
}

async function loadProjects(sessionId) {
  projectSelect.innerHTML = "<option>불러오는 중...</option>";
  try {
    const res = await fetch(`${API_BASE}/api/projects?session_id=${encodeURIComponent(sessionId)}`);
    if (!res.ok) {
      projectSelect.innerHTML = "<option>프로젝트 목록을 불러오지 못했습니다</option>";
      return;
    }
    const { projects } = await res.json();
    projectSelect.innerHTML = "";
    for (const project of projects) {
      const option = document.createElement("option");
      option.value = project.name;
      option.textContent = project.name;
      projectSelect.appendChild(option);
    }

    const { selected_project } = await chrome.storage.session.get("selected_project");
    if (selected_project && projects.some((p) => p.name === selected_project)) {
      projectSelect.value = selected_project;
    }
  } catch (e) {
    projectSelect.innerHTML = "<option>백엔드 서버에 연결할 수 없습니다</option>";
  }
}

projectSelect.addEventListener("change", () => {
  chrome.storage.session.set({ selected_project: projectSelect.value });
});

for (let day = 1; day <= 31; day++) {
  const option = document.createElement("option");
  option.value = day;
  option.textContent = `${day}일`;
  dayOfMonthSelect.appendChild(option);
}

function updatePeriodicInputsVisibility() {
  const isMonthly = cadenceSelect.value === "monthly";
  weekdaySelect.classList.toggle("hidden", isMonthly);
  dayOfMonthSelect.classList.toggle("hidden", !isMonthly);
}

async function loadPeriodicSettings() {
  const stored = await chrome.storage.session.get(["periodic_cadence", "periodic_weekday", "periodic_day_of_month"]);
  if (stored.periodic_cadence) cadenceSelect.value = stored.periodic_cadence;
  if (stored.periodic_weekday) weekdaySelect.value = stored.periodic_weekday;
  if (stored.periodic_day_of_month) dayOfMonthSelect.value = stored.periodic_day_of_month;
  updatePeriodicInputsVisibility();
}

cadenceSelect.addEventListener("change", () => {
  chrome.storage.session.set({ periodic_cadence: cadenceSelect.value });
  updatePeriodicInputsVisibility();
});

weekdaySelect.addEventListener("change", () => {
  chrome.storage.session.set({ periodic_weekday: weekdaySelect.value });
});

dayOfMonthSelect.addEventListener("change", () => {
  chrome.storage.session.set({ periodic_day_of_month: dayOfMonthSelect.value });
});

async function refreshView() {
  const sessionId = await getSessionId();
  if (sessionId) {
    loginView.classList.add("hidden");
    runView.classList.remove("hidden");
    await loadProjects(sessionId);
    await loadPeriodicSettings();
  } else {
    loginView.classList.remove("hidden");
    runView.classList.add("hidden");
  }
}

document.getElementById("loginBtn").addEventListener("click", async () => {
  showError("");
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  if (!username || !password) {
    showError("계정과 비밀번호를 입력하세요.");
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      showError(detail.detail || "로그인에 실패했습니다.");
      return;
    }
    const data = await res.json();
    await setSessionId(data.session_id);
    document.getElementById("password").value = "";
    await refreshView();
  } catch (e) {
    showError("백엔드 서버에 연결할 수 없습니다.");
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  const sessionId = await getSessionId();
  if (sessionId) {
    await fetch(`${API_BASE}/api/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    }).catch(() => {});
  }
  await clearSessionId();
  await chrome.storage.session.remove("selected_project");
  await refreshView();
});

document.getElementById("runBtn").addEventListener("click", async () => {
  const sessionId = await getSessionId();
  if (!sessionId) {
    await refreshView();
    return;
  }

  const projectName = projectSelect.value;
  if (!projectName) {
    stepEl.textContent = "프로젝트를 선택하세요.";
    return;
  }

  const periodicCadence = cadenceSelect.value;
  const periodicAnchor = periodicCadence === "monthly" ? Number(dayOfMonthSelect.value) : Number(weekdaySelect.value);

  progressWrap.classList.remove("hidden");
  progressFill.style.width = "0%";
  stepEl.textContent = "요청 중...";
  hideReviewUI();

  try {
    const res = await fetch(`${API_BASE}/api/audit-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        project_name: projectName,
        periodic_cadence: periodicCadence,
        periodic_anchor: periodicAnchor,
      }),
    });
    if (res.status === 401) {
      await clearSessionId();
      await refreshView();
      return;
    }
    const { job_id } = await res.json();
    currentJobId = job_id;
    startPolling();
  } catch (e) {
    stepEl.textContent = "백엔드 서버에 연결할 수 없습니다.";
  }
});

function hideReviewUI() {
  downloadLink.classList.add("hidden");
  reviewNotice.classList.add("hidden");
  reviewActions.classList.add("hidden");
  selectActions.classList.add("hidden");
  itemsList.classList.add("hidden");
  itemsList.innerHTML = "";
  unregisteredWrap.classList.add("hidden");
  unregisteredList.innerHTML = "";
  newTrackersWrap.classList.add("hidden");
  newTrackersList.innerHTML = "";
  changedTrackersWrap.classList.add("hidden");
  changedTrackersList.innerHTML = "";
  versionFailWrap.classList.add("hidden");
  versionFailList.innerHTML = "";
}

async function loadVersionCheckFailures(jobId) {
  try {
    const res = await fetch(`${API_BASE}/api/audit-jobs/${jobId}/version-check-failures`);
    if (!res.ok) return;
    const { failures } = await res.json();
    if (!failures || !failures.length) return;

    versionFailList.innerHTML = "";
    for (const failure of failures) {
      const row = document.createElement("div");
      row.className = "version-fail-row";

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
  } catch (e) {
    // 조용히 무시 - 참고용 정보라 실패해도 검토/승인 흐름을 막지 않는다
  }
}

async function loadUnregisteredTrackers(jobId) {
  try {
    const res = await fetch(`${API_BASE}/api/audit-jobs/${jobId}/unregistered`);
    if (!res.ok) return;
    const { trackers } = await res.json();
    if (!trackers.length) return;

    unregisteredList.innerHTML = "";
    for (const tracker of trackers) {
      const row = document.createElement("div");
      row.textContent = tracker.tracker_name;
      unregisteredList.appendChild(row);
    }
    unregisteredWrap.classList.remove("hidden");
  } catch (e) {
    // 조용히 무시 - 이 목록은 참고용 경고라 실패해도 검토/승인 흐름을 막지 않는다
  }
}

async function loadChanges(jobId) {
  try {
    const res = await fetch(`${API_BASE}/api/audit-jobs/${jobId}/changes`);
    if (!res.ok) return;
    const { new_trackers, changed_trackers } = await res.json();

    if (new_trackers && new_trackers.length) {
      newTrackersList.innerHTML = "";
      for (const name of new_trackers) {
        const row = document.createElement("div");
        row.textContent = name;
        newTrackersList.appendChild(row);
      }
      newTrackersWrap.classList.remove("hidden");
    }

    if (changed_trackers && changed_trackers.length) {
      changedTrackersList.innerHTML = "";
      for (const change of changed_trackers) {
        const row = document.createElement("div");
        row.className = "change-row";

        const name = document.createElement("div");
        name.className = "change-name";
        name.textContent = change.tracker_name;
        row.appendChild(name);

        const detail = document.createElement("div");
        detail.className = "change-detail";
        const parts = [];
        if (change.previous_status !== change.current_status) {
          parts.push(`상태: ${change.previous_status ?? "-"} → ${change.current_status ?? "-"}`);
        }
        if (change.previous_version !== change.current_version) {
          parts.push(`버전: ${change.previous_version ?? "-"} → ${change.current_version ?? "-"}`);
        }
        detail.textContent = parts.join(" / ");
        row.appendChild(detail);

        changedTrackersList.appendChild(row);
      }
      changedTrackersWrap.classList.remove("hidden");
    }
  } catch (e) {
    // 조용히 무시 - 참고용 정보라 실패해도 검토/승인 흐름을 막지 않는다
  }
}

function badge(label, isNg) {
  const span = document.createElement("span");
  span.className = `badge ${isNg ? "ng" : "ok"}`;
  span.textContent = label;
  return span;
}

async function loadReviewItems(jobId) {
  itemsList.innerHTML = "불러오는 중...";
  itemsList.classList.remove("hidden");
  try {
    const res = await fetch(`${API_BASE}/api/audit-jobs/${jobId}/items`);
    if (!res.ok) {
      itemsList.textContent = "항목 목록을 불러오지 못했습니다.";
      return;
    }
    const { items } = await res.json();
    itemsList.innerHTML = "";

    for (const item of items) {
      const row = document.createElement("label");
      row.className = "item-row";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.dataset.cilId = item.cil_id;
      row.appendChild(checkbox);

      const body = document.createElement("div");
      body.className = "item-body";

      const name = document.createElement("div");
      name.className = "item-name";
      name.textContent = item.tracker_name;
      body.appendChild(name);

      const badges = document.createElement("div");
      badges.className = "item-badges";
      badges.appendChild(badge("저장", item.save_rule === 2));
      badges.appendChild(badge("버전", item.version_rule === 2));
      badges.appendChild(badge("이력", item.doc_history_rule === 2));
      badges.appendChild(badge("상태", item.status_rule === 2));
      body.appendChild(badges);

      const comment = document.createElement("div");
      comment.className = "item-comment";
      comment.textContent = item.comment || "";
      body.appendChild(comment);

      row.appendChild(body);
      itemsList.appendChild(row);
    }

    selectActions.classList.remove("hidden");
  } catch (e) {
    itemsList.textContent = "백엔드 서버에 연결할 수 없습니다.";
  }
}

selectAllBtn.addEventListener("click", () => {
  itemsList.querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.checked = true));
});

selectNoneBtn.addEventListener("click", () => {
  itemsList.querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.checked = false));
});

approveBtn.addEventListener("click", async () => {
  const sessionId = await getSessionId();
  if (!sessionId || !currentJobId) return;

  const excludedCilIds = Array.from(itemsList.querySelectorAll('input[type="checkbox"]'))
    .filter((cb) => !cb.checked)
    .map((cb) => Number(cb.dataset.cilId));

  reviewActions.classList.add("hidden");
  reviewNotice.classList.add("hidden");
  selectActions.classList.add("hidden");
  itemsList.classList.add("hidden");
  unregisteredWrap.classList.add("hidden");
  newTrackersWrap.classList.add("hidden");
  changedTrackersWrap.classList.add("hidden");
  versionFailWrap.classList.add("hidden");
  stepEl.textContent = "반영 진행 요청 중...";

  const res = await fetch(`${API_BASE}/api/audit-jobs/${currentJobId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, excluded_cil_ids: excludedCilIds }),
  });
  if (res.status === 401) {
    await clearSessionId();
    await refreshView();
    return;
  }
  startPolling();
});

rejectBtn.addEventListener("click", async () => {
  if (!currentJobId) return;
  await fetch(`${API_BASE}/api/audit-jobs/${currentJobId}/reject`, { method: "POST" });
  reviewActions.classList.add("hidden");
  reviewNotice.classList.add("hidden");
  selectActions.classList.add("hidden");
  itemsList.classList.add("hidden");
  unregisteredWrap.classList.add("hidden");
  newTrackersWrap.classList.add("hidden");
  changedTrackersWrap.classList.add("hidden");
  versionFailWrap.classList.add("hidden");
  stepEl.textContent = "취소됨 (codebeamer에는 반영되지 않았습니다)";
});

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const res = await fetch(`${API_BASE}/api/audit-jobs/${currentJobId}`);
    const job = await res.json();

    progressFill.style.width = `${job.progress || 0}%`;
    stepEl.textContent = job.step || job.status;

    if (job.result_file) {
      downloadLink.href = `${API_BASE}/api/audit-jobs/${currentJobId}/download`;
      downloadLink.classList.remove("hidden");
    }

    if (job.status === "awaiting_review") {
      clearInterval(pollTimer);
      reviewNotice.classList.remove("hidden");
      reviewActions.classList.remove("hidden");
      loadReviewItems(currentJobId);
      loadUnregisteredTrackers(currentJobId);
      loadChanges(currentJobId);
      loadVersionCheckFailures(currentJobId);
    } else if (job.status === "done" || job.status === "failed") {
      clearInterval(pollTimer);
      if (job.status === "failed") {
        stepEl.textContent = `실패: ${job.error}`;
      }
    }
  }, 2000);
}

refreshView();
