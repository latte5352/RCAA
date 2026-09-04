// codebeamer 비밀번호는 이 확장 어디에도 저장하지 않는다.
// 로그인 시 백엔드로 1회 전송해 검증받고, 이후에는 발급받은 session_id만 보관/사용한다.

const API_BASE = "http://localhost:8000";

const loginView = document.getElementById("loginView");
const runView = document.getElementById("runView");
const errorEl = document.getElementById("error");
const progressWrap = document.getElementById("progressWrap");
const progressFill = document.getElementById("progressFill");
const stepEl = document.getElementById("step");
const projectSearchInput = document.getElementById("projectSearchInput");
const projectDropdownList = document.getElementById("projectDropdownList");
const cadenceSelect = document.getElementById("cadenceSelect");
const weekdaySelect = document.getElementById("weekdaySelect");
const dayOfMonthSelect = document.getElementById("dayOfMonthSelect");
const reviewOpenNotice = document.getElementById("reviewOpenNotice");
const openReviewBtn = document.getElementById("openReviewBtn");

let currentJobId = null;
let pollTimer = null;
let allProjects = [];
let selectedProjectName = null;
let activeOptionIndex = -1;
let reviewWindowOpenedForJob = null;

function openReviewWindow(jobId) {
  chrome.windows.create({
    url: chrome.runtime.getURL(`review.html?job_id=${encodeURIComponent(jobId)}`),
    type: "popup",
    width: 1000,
    height: 750,
  });
  reviewWindowOpenedForJob = jobId;
}

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
  projectSearchInput.value = "불러오는 중...";
  projectSearchInput.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/projects?session_id=${encodeURIComponent(sessionId)}`);
    if (!res.ok) {
      projectSearchInput.value = "";
      projectSearchInput.placeholder = "프로젝트 목록을 불러오지 못했습니다";
      return;
    }
    const { projects } = await res.json();
    allProjects = projects;
    projectSearchInput.disabled = false;
    projectSearchInput.value = "";
    projectSearchInput.placeholder = "프로젝트 검색...";

    const { selected_project } = await chrome.storage.session.get("selected_project");
    if (selected_project && projects.some((p) => p.name === selected_project)) {
      selectedProjectName = selected_project;
      projectSearchInput.value = selected_project;
    } else {
      selectedProjectName = null;
    }
  } catch (e) {
    projectSearchInput.value = "";
    projectSearchInput.placeholder = "백엔드 서버에 연결할 수 없습니다";
  }
}

function renderProjectOptions(filterText) {
  const query = filterText.trim().toLowerCase();
  const matches = query ? allProjects.filter((p) => p.name.toLowerCase().includes(query)) : allProjects;

  projectDropdownList.innerHTML = "";
  activeOptionIndex = -1;

  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "project-option-empty";
    empty.textContent = "일치하는 프로젝트가 없습니다";
    projectDropdownList.appendChild(empty);
  } else {
    matches.forEach((project) => {
      const option = document.createElement("div");
      option.className = "project-option";
      option.textContent = project.name;
      option.addEventListener("mousedown", (e) => {
        e.preventDefault(); // input blur보다 먼저 선택 처리
        selectProject(project.name);
      });
      projectDropdownList.appendChild(option);
    });
  }

  projectDropdownList.classList.remove("hidden");
}

function selectProject(name) {
  selectedProjectName = name;
  projectSearchInput.value = name;
  projectDropdownList.classList.add("hidden");
  chrome.storage.session.set({ selected_project: name });
}

projectSearchInput.addEventListener("input", () => {
  selectedProjectName = null;
  renderProjectOptions(projectSearchInput.value);
});

projectSearchInput.addEventListener("focus", () => {
  if (allProjects.length) renderProjectOptions(projectSearchInput.value);
});

projectSearchInput.addEventListener("blur", () => {
  // mousedown에서 이미 선택 처리를 하므로, 약간의 지연 후 닫아도 안전하다
  setTimeout(() => projectDropdownList.classList.add("hidden"), 100);
});

projectSearchInput.addEventListener("keydown", (e) => {
  const options = Array.from(projectDropdownList.querySelectorAll(".project-option"));
  if (!options.length) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeOptionIndex = Math.min(activeOptionIndex + 1, options.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeOptionIndex = Math.max(activeOptionIndex - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (activeOptionIndex >= 0) selectProject(options[activeOptionIndex].textContent);
    return;
  } else if (e.key === "Escape") {
    projectDropdownList.classList.add("hidden");
    return;
  } else {
    return;
  }

  options.forEach((opt, i) => opt.classList.toggle("active", i === activeOptionIndex));
  options[activeOptionIndex].scrollIntoView({ block: "nearest" });
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

async function login() {
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
}

document.getElementById("loginBtn").addEventListener("click", login);

for (const id of ["username", "password"]) {
  document.getElementById(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      login();
    }
  });
}

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

  const projectName = selectedProjectName;
  if (!projectName) {
    stepEl.textContent = "목록에서 프로젝트를 선택하세요.";
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
  reviewOpenNotice.classList.add("hidden");
  openReviewBtn.classList.add("hidden");
  reviewWindowOpenedForJob = null;
}

openReviewBtn.addEventListener("click", () => {
  if (currentJobId) openReviewWindow(currentJobId);
});

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    let job;
    try {
      const res = await fetch(`${API_BASE}/api/audit-jobs/${currentJobId}`);
      job = await res.json();
    } catch (e) {
      stepEl.textContent = "백엔드 서버에 연결할 수 없습니다. 재연결 시도 중...";
      return;
    }

    progressFill.style.width = `${job.progress || 0}%`;
    stepEl.textContent = job.step || job.status;

    if (job.status === "awaiting_review") {
      reviewOpenNotice.classList.remove("hidden");
      openReviewBtn.classList.remove("hidden");
      if (reviewWindowOpenedForJob !== currentJobId) {
        openReviewWindow(currentJobId);
      }
    } else if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
      clearInterval(pollTimer);
      if (job.status === "failed") {
        stepEl.textContent = `실패: ${job.error}`;
      }
      reviewOpenNotice.classList.add("hidden");
      openReviewBtn.classList.add("hidden");
    }
  }, 2000);
}

refreshView();
