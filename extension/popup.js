// codebeamer 비밀번호는 브라우저 세션 저장소(chrome.storage.session)에만 잠깐 보관된다 -
// 브라우저를 닫으면 사라지고, 디스크에 남지 않는다. 서버가 없어서(서버리스) 이 확장이 직접
// codebeamer를 호출해야 하니 불가피한 트레이드오프다 (자세한 배경은 사용자와의 설계 논의 참고).

import { createClient } from "./lib/codebeamerClient.js";
import { verifyLogin, listProjects } from "./lib/projects.js";
import { listRegisteredTrackerNames } from "./lib/collector.js";
import { loadReviewState } from "./lib/reviewState.js";
import { checkUserProjectRole, filterProjectsByRole } from "./lib/memberRoles.js";
import { BASE_URL, BASE_URL_V3, PROJ_BASE_URL, CM_ROLE_NAME, TRACKER_NAME_CIL, TRACKER_NAME_NCL } from "./lib/config.js";

const loginView = document.getElementById("loginView");
const runView = document.getElementById("runView");
const errorEl = document.getElementById("error");
const stepEl = document.getElementById("step");
const projectSearchInput = document.getElementById("projectSearchInput");
const projectDropdownList = document.getElementById("projectDropdownList");
const trackerSearchInput = document.getElementById("trackerSearchInput");
const trackerListBox = document.getElementById("trackerListBox");
const trackerBulkButtons = document.getElementById("trackerBulkButtons");
const trackerSelectAllBtn = document.getElementById("trackerSelectAllBtn");
const trackerSelectNoneBtn = document.getElementById("trackerSelectNoneBtn");
const trackerSelectionSummary = document.getElementById("trackerSelectionSummary");
const cadenceSelect = document.getElementById("cadenceSelect");
const weekdaySelect = document.getElementById("weekdaySelect");
const dayOfMonthSelect = document.getElementById("dayOfMonthSelect");
const lastAuditInfo = document.getElementById("lastAuditInfo");
const viewLastBtn = document.getElementById("viewLastBtn");
const runBtn = document.getElementById("runBtn");
const cmRoleWarning = document.getElementById("cmRoleWarning");
const projectFilterNote = document.getElementById("projectFilterNote");

let allProjects = [];
let selectedProjectName = null;
let activeOptionIndex = -1;
let runConfirmArmed = false;
let runConfirmTimer = null;

let allTrackerNames = [];
let trackerNamesLoadedForProject = null;
let selectedTrackerNames = new Set();
let hasStoredTrackerSelection = false; // 이 프로젝트에 대해 세션 중 명시적으로 선택을 저장한 적 있는지

function resetRunConfirm() {
  runConfirmArmed = false;
  clearTimeout(runConfirmTimer);
  runBtn.textContent = "새 감사 시작";
}

async function refreshLastAuditInfo() {
  resetRunConfirm();
  if (!selectedProjectName) {
    lastAuditInfo.classList.add("hidden");
    viewLastBtn.classList.add("hidden");
    return;
  }
  const state = await loadReviewState(selectedProjectName);
  if (!state) {
    lastAuditInfo.classList.add("hidden");
    viewLastBtn.classList.add("hidden");
    return;
  }
  const when = new Date(state.savedAt).toLocaleString("ko-KR");
  const statusLabel = state.status === "applied" ? "반영 완료" : "검토 대기 중 (미반영)";
  lastAuditInfo.textContent = `직전 감사: ${when} · ${statusLabel}`;
  lastAuditInfo.classList.remove("hidden");
  viewLastBtn.classList.remove("hidden");
}

let cmRoleCheckToken = 0;

function setCmRoleWarning(text, kind) {
  cmRoleWarning.className = kind ? `role-${kind}` : "";
  if (!text) {
    cmRoleWarning.classList.add("hidden");
    cmRoleWarning.textContent = "";
    return;
  }
  cmRoleWarning.textContent = text;
  cmRoleWarning.classList.remove("hidden");
}

// codebeamer 정식 REST API가 아니라 프로젝트 멤버 화면이 내부적으로 쓰는 비공식 엔드포인트를
// 붙여서 확인하는 거라(lib/memberRoles.js 참고), 실패하거나 계정을 못 찾아도 절대 감사/반영을
// 막지 않는다 - 참고용 경고만 보여준다.
async function refreshCmRoleWarning() {
  const token = ++cmRoleCheckToken;
  setCmRoleWarning(null);
  if (!selectedProjectName) return;

  const project = allProjects.find((p) => p.name === selectedProjectName);
  const credentials = await getCredentials();
  if (!project || !project.uri || !credentials) return;

  const projectId = project.uri.split("/").filter(Boolean).pop();
  const client = createClient({ baseUrl: BASE_URL, baseUrlV3: BASE_URL_V3, ...credentials });
  const result = await checkUserProjectRole(client, {
    projBaseUrl: PROJ_BASE_URL,
    projectId,
    username: credentials.username,
    roleName: CM_ROLE_NAME,
  });

  if (token !== cmRoleCheckToken) return; // 그 사이 다른 프로젝트가 선택됨 - 이 결과는 버림

  if (result.error) {
    setCmRoleWarning(`이 계정의 ${CM_ROLE_NAME} 권한 여부를 확인하지 못했습니다 (${result.error}).`, "unknown");
  } else if (!result.found) {
    setCmRoleWarning(`이 프로젝트 멤버 목록에서 계정을 찾지 못해 ${CM_ROLE_NAME} 권한 여부를 확인할 수 없습니다.`, "unknown");
  } else if (!result.hasRole) {
    setCmRoleWarning(`⚠ 이 계정은 이 프로젝트에서 ${CM_ROLE_NAME} 권한이 없는 것 같습니다. codebeamer 반영이 거부될 수 있습니다.`, "missing");
  } else {
    setCmRoleWarning(`✓ 이 계정은 이 프로젝트에서 ${CM_ROLE_NAME} 권한이 있습니다.`, "ok");
  }
}

function showError(message) {
  errorEl.textContent = message;
}

async function getCredentials() {
  const { credentials } = await chrome.storage.session.get("credentials");
  return credentials || null;
}

async function setCredentials(username, password) {
  await chrome.storage.session.set({ credentials: { username, password } });
}

async function clearCredentials() {
  await chrome.storage.session.remove("credentials");
}

async function loadProjects(client, username) {
  projectSearchInput.value = "불러오는 중...";
  projectSearchInput.disabled = true;
  projectFilterNote.classList.add("hidden");
  try {
    const rawProjects = await listProjects(client);

    projectSearchInput.value = "권한 확인 중...";
    const { projects, filtered, hiddenCount } = await filterProjectsByRole(client, {
      projBaseUrl: PROJ_BASE_URL, projects: rawProjects, username, roleName: CM_ROLE_NAME,
    });
    allProjects = projects;

    if (!filtered) {
      projectFilterNote.textContent = `${CM_ROLE_NAME} 권한 필터를 확인하지 못해 전체 프로젝트를 표시합니다. 반영 시점에는 계속 확인합니다.`;
      projectFilterNote.classList.remove("hidden");
    } else if (hiddenCount > 0) {
      projectFilterNote.textContent = `${CM_ROLE_NAME} 권한이 없는 프로젝트 ${hiddenCount}개는 목록에서 제외했습니다.`;
      projectFilterNote.classList.remove("hidden");
    }

    projectSearchInput.disabled = false;
    projectSearchInput.value = "";
    projectSearchInput.placeholder = "프로젝트 검색...";

    const { selected_project } = await chrome.storage.session.get("selected_project");
    if (selected_project && allProjects.some((p) => p.name === selected_project)) {
      selectedProjectName = selected_project;
      projectSearchInput.value = selected_project;
    } else {
      selectedProjectName = null;
    }
    await refreshLastAuditInfo();
    refreshCmRoleWarning();
    resetTrackerPicker();
    await restoreSelectedTrackersForProject();
    if (selectedProjectName) loadTrackerNamesForCurrentProject();
  } catch (e) {
    projectSearchInput.value = "";
    projectSearchInput.placeholder = "프로젝트 목록을 불러오지 못했습니다";
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
        e.preventDefault();
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
  refreshLastAuditInfo();
  refreshCmRoleWarning();
  resetTrackerPicker();
  restoreSelectedTrackersForProject().then(loadTrackerNamesForCurrentProject);
}

projectSearchInput.addEventListener("input", () => {
  selectedProjectName = null;
  renderProjectOptions(projectSearchInput.value);
  refreshLastAuditInfo();
  refreshCmRoleWarning();
  resetTrackerPicker();
  restoreSelectedTrackersForProject();
});

projectSearchInput.addEventListener("focus", () => {
  if (allProjects.length) renderProjectOptions(projectSearchInput.value);
});

projectSearchInput.addEventListener("blur", () => {
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

function resetTrackerPicker() {
  allTrackerNames = [];
  trackerNamesLoadedForProject = null;
  trackerSearchInput.value = "";
  trackerSearchInput.readOnly = false;
  trackerSearchInput.placeholder = "트래커 검색...";
  trackerListBox.innerHTML = "";
  trackerListBox.classList.add("hidden");
  trackerBulkButtons.classList.add("hidden");
}

async function persistSelectedTrackers() {
  const { selected_trackers } = await chrome.storage.session.get("selected_trackers");
  const map = selected_trackers || {};
  // 빈 배열이어도 그대로 저장한다 - "한 번도 선택한 적 없음(디폴트: 전체)"과 "명시적으로
  // 전체 해제함"을 구분해야 나중에 트래커 목록을 다시 불러왔을 때 전체 체크로 되돌리지 않는다.
  map[selectedProjectName] = Array.from(selectedTrackerNames);
  await chrome.storage.session.set({ selected_trackers: map });
}

async function restoreSelectedTrackersForProject() {
  selectedTrackerNames = new Set();
  hasStoredTrackerSelection = false;
  if (selectedProjectName) {
    const { selected_trackers } = await chrome.storage.session.get("selected_trackers");
    const map = selected_trackers || {};
    if (Object.prototype.hasOwnProperty.call(map, selectedProjectName)) {
      selectedTrackerNames = new Set(map[selectedProjectName]);
      hasStoredTrackerSelection = true;
    }
  }
  updateTrackerSummary();
}

function updateTrackerSummary() {
  trackerSelectionSummary.innerHTML = "";
  if (!allTrackerNames.length) {
    trackerSelectionSummary.classList.add("hidden");
    return;
  }
  if (selectedTrackerNames.size === 0) {
    trackerSelectionSummary.textContent = "⚠ 선택된 트래커가 없습니다. 최소 1개는 선택해야 감사를 실행할 수 있습니다.";
    trackerSelectionSummary.classList.remove("hidden");
    return;
  }
  if (selectedTrackerNames.size >= allTrackerNames.length) {
    trackerSelectionSummary.classList.add("hidden"); // 기본값(전체 선택) - 별도 안내 없음
    return;
  }
  trackerSelectionSummary.textContent = `전체 대신 ${selectedTrackerNames.size}개 트래커만 감사 (전체 ${allTrackerNames.length}개 중)`;
  trackerSelectionSummary.classList.remove("hidden");
}

trackerSelectAllBtn.addEventListener("click", () => {
  selectedTrackerNames = new Set(allTrackerNames.map((t) => t.name));
  persistSelectedTrackers();
  updateTrackerSummary();
  renderTrackerOptions(trackerSearchInput.value);
});

trackerSelectNoneBtn.addEventListener("click", () => {
  selectedTrackerNames = new Set();
  persistSelectedTrackers();
  updateTrackerSummary();
  renderTrackerOptions(trackerSearchInput.value);
});

// 포커스 있어야만 뜨는 드롭다운이 아니라, 항상 보이는 체크리스트 박스다 - 전체 선택/해제나
// 하나씩 토글할 때마다 다른 곳을 클릭해 포커스를 옮길 필요가 없게 하기 위함.
function renderTrackerOptions(filterText) {
  const query = filterText.trim().toLowerCase();
  // 트래커명뿐 아니라 앞에 붙는 프로세스 태그(HWE.1, SUP.8 등)로도 검색되게 한다.
  const matches = query
    ? allTrackerNames.filter((t) => t.name.toLowerCase().includes(query) || t.processTag.toLowerCase().includes(query))
    : allTrackerNames;

  trackerListBox.innerHTML = "";
  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "project-option-empty";
    empty.textContent = allTrackerNames.length ? "일치하는 트래커가 없습니다" : "불러온 트래커가 없습니다";
    trackerListBox.appendChild(empty);
  } else {
    matches.forEach(({ name, processTag }) => {
      const option = document.createElement("div");
      const isChecked = selectedTrackerNames.has(name);
      option.className = "tracker-option" + (isChecked ? " checked" : "");
      const label = processTag ? `${processTag} · ${name}` : name;
      option.textContent = `${isChecked ? "☑" : "☐"} ${label}`;
      option.addEventListener("click", () => {
        if (selectedTrackerNames.has(name)) selectedTrackerNames.delete(name);
        else selectedTrackerNames.add(name);
        persistSelectedTrackers();
        updateTrackerSummary();
        renderTrackerOptions(trackerSearchInput.value);
      });
      trackerListBox.appendChild(option);
    });
  }

  trackerListBox.classList.remove("hidden");
}

async function loadTrackerNamesForCurrentProject() {
  const credentials = await getCredentials();
  if (!credentials || !selectedProjectName) return;

  trackerSearchInput.readOnly = true;
  trackerSearchInput.placeholder = "불러오는 중...";
  trackerListBox.innerHTML = '<div class="project-option-empty">불러오는 중...</div>';
  trackerListBox.classList.remove("hidden");
  try {
    const client = createClient({ baseUrl: BASE_URL, baseUrlV3: BASE_URL_V3, ...credentials });
    allTrackerNames = await listRegisteredTrackerNames(client, { projectName: selectedProjectName, trackerCil: TRACKER_NAME_CIL });
    trackerNamesLoadedForProject = selectedProjectName;
    trackerSearchInput.placeholder = "트래커 검색...";

    if (!hasStoredTrackerSelection) {
      // 이 프로젝트에서 한 번도 선택한 적 없으면 디폴트는 전체 체크
      selectedTrackerNames = new Set(allTrackerNames.map((t) => t.name));
      hasStoredTrackerSelection = true;
      await persistSelectedTrackers();
    } else {
      // 저장된 선택 중 지금은 더 이상 존재하지 않는 트래커 이름은 걸러낸다
      const validNames = new Set(allTrackerNames.map((t) => t.name));
      selectedTrackerNames = new Set(Array.from(selectedTrackerNames).filter((n) => validNames.has(n)));
    }
    trackerBulkButtons.classList.toggle("hidden", allTrackerNames.length === 0);
    updateTrackerSummary();
    renderTrackerOptions(trackerSearchInput.value);
  } catch (e) {
    allTrackerNames = [];
    trackerSearchInput.placeholder = "트래커 목록을 불러오지 못했습니다";
    trackerListBox.innerHTML = "";
    trackerListBox.classList.add("hidden");
  } finally {
    trackerSearchInput.readOnly = false;
  }
}

trackerSearchInput.addEventListener("input", () => {
  renderTrackerOptions(trackerSearchInput.value);
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
  const credentials = await getCredentials();
  if (credentials) {
    loginView.classList.add("hidden");
    runView.classList.remove("hidden");
    const client = createClient({ baseUrl: BASE_URL, baseUrlV3: BASE_URL_V3, ...credentials });
    await loadProjects(client, credentials.username);
    await loadPeriodicSettings();
  } else {
    loginView.classList.remove("hidden");
    runView.classList.add("hidden");
  }
}

const loginBtn = document.getElementById("loginBtn");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");

async function handleLogin() {
  showError("");
  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!username || !password) {
    showError("계정과 비밀번호를 입력하세요.");
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = "확인 중...";
  try {
    const client = createClient({ baseUrl: BASE_URL, baseUrlV3: BASE_URL_V3, username, password });
    const ok = await verifyLogin(client);
    if (!ok) {
      showError("로그인에 실패했습니다. 계정/비밀번호를 확인하세요.");
      return;
    }
    await setCredentials(username, password);
    passwordInput.value = "";
    await refreshView();
  } catch (e) {
    showError("codebeamer에 연결할 수 없습니다.");
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "로그인";
  }
}

loginBtn.addEventListener("click", handleLogin);
[usernameInput, passwordInput].forEach((input) => {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleLogin();
  });
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await clearCredentials();
  await chrome.storage.session.remove(["selected_project", "selected_trackers"]);
  await refreshView();
});

viewLastBtn.addEventListener("click", async () => {
  const credentials = await getCredentials();
  if (!credentials) {
    await refreshView();
    return;
  }
  if (!selectedProjectName) return;

  const params = new URLSearchParams({ project: selectedProjectName, mode: "view" });
  chrome.windows.create({
    url: chrome.runtime.getURL(`audit.html?${params.toString()}`),
    type: "popup",
    width: 1000,
    height: 750,
  });
  stepEl.textContent = "직전 감사 결과 창을 열었습니다.";
});

runBtn.addEventListener("click", async () => {
  const credentials = await getCredentials();
  if (!credentials) {
    await refreshView();
    return;
  }
  if (!selectedProjectName) {
    stepEl.textContent = "목록에서 프로젝트를 선택하세요.";
    return;
  }
  if (allTrackerNames.length > 0 && selectedTrackerNames.size === 0) {
    stepEl.textContent = "최소 1개의 트래커는 선택해야 합니다.";
    return;
  }

  const existing = await loadReviewState(selectedProjectName);
  if (existing && existing.status !== "applied" && !runConfirmArmed) {
    runConfirmArmed = true;
    runBtn.textContent = "정말 새로 시작할까요? 직전 결과가 사라집니다 (다시 클릭)";
    clearTimeout(runConfirmTimer);
    runConfirmTimer = setTimeout(resetRunConfirm, 4000);
    return;
  }
  resetRunConfirm();

  const periodicCadence = cadenceSelect.value;
  const periodicAnchor = periodicCadence === "monthly" ? Number(dayOfMonthSelect.value) : Number(weekdaySelect.value);

  const params = new URLSearchParams({
    project: selectedProjectName,
    cadence: periodicCadence,
    anchor: String(periodicAnchor),
    trackerCil: TRACKER_NAME_CIL,
    trackerNcl: TRACKER_NAME_NCL,
  });
  const isPartialSelection = allTrackerNames.length > 0 && selectedTrackerNames.size < allTrackerNames.length;
  if (isPartialSelection) {
    params.set("onlyTrackers", JSON.stringify(Array.from(selectedTrackerNames)));
  }
  chrome.windows.create({
    url: chrome.runtime.getURL(`audit.html?${params.toString()}`),
    type: "popup",
    width: 1000,
    height: 750,
  });
  stepEl.textContent = isPartialSelection
    ? `검토 창을 열었습니다 (선택한 트래커 ${selectedTrackerNames.size}개만 감사).`
    : "검토 창을 열었습니다.";
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !selectedProjectName) return;
  if (`review_state_${selectedProjectName}` in changes) refreshLastAuditInfo();
});

refreshView();
