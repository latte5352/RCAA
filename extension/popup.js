// codebeamer 비밀번호는 브라우저 세션 저장소(chrome.storage.session)에만 잠깐 보관된다 -
// 브라우저를 닫으면 사라지고, 디스크에 남지 않는다. 서버가 없어서(서버리스) 이 확장이 직접
// codebeamer를 호출해야 하니 불가피한 트레이드오프다 (자세한 배경은 사용자와의 설계 논의 참고).

import { createClient } from "./lib/codebeamerClient.js";
import { verifyLogin, listProjects } from "./lib/projects.js";
import { BASE_URL, BASE_URL_V3, TRACKER_NAME_CIL, TRACKER_NAME_NCL } from "./lib/config.js";

const loginView = document.getElementById("loginView");
const runView = document.getElementById("runView");
const errorEl = document.getElementById("error");
const stepEl = document.getElementById("step");
const projectSearchInput = document.getElementById("projectSearchInput");
const projectDropdownList = document.getElementById("projectDropdownList");
const cadenceSelect = document.getElementById("cadenceSelect");
const weekdaySelect = document.getElementById("weekdaySelect");
const dayOfMonthSelect = document.getElementById("dayOfMonthSelect");

let allProjects = [];
let selectedProjectName = null;
let activeOptionIndex = -1;

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

async function loadProjects(client) {
  projectSearchInput.value = "불러오는 중...";
  projectSearchInput.disabled = true;
  try {
    allProjects = await listProjects(client);
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
}

projectSearchInput.addEventListener("input", () => {
  selectedProjectName = null;
  renderProjectOptions(projectSearchInput.value);
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
    await loadProjects(client);
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

  const loginBtn = document.getElementById("loginBtn");
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
    document.getElementById("password").value = "";
    await refreshView();
  } catch (e) {
    showError("codebeamer에 연결할 수 없습니다.");
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "로그인";
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await clearCredentials();
  await chrome.storage.session.remove("selected_project");
  await refreshView();
});

document.getElementById("runBtn").addEventListener("click", async () => {
  const credentials = await getCredentials();
  if (!credentials) {
    await refreshView();
    return;
  }
  if (!selectedProjectName) {
    stepEl.textContent = "목록에서 프로젝트를 선택하세요.";
    return;
  }

  const periodicCadence = cadenceSelect.value;
  const periodicAnchor = periodicCadence === "monthly" ? Number(dayOfMonthSelect.value) : Number(weekdaySelect.value);

  const params = new URLSearchParams({
    project: selectedProjectName,
    cadence: periodicCadence,
    anchor: String(periodicAnchor),
    trackerCil: TRACKER_NAME_CIL,
    trackerNcl: TRACKER_NAME_NCL,
  });
  chrome.windows.create({
    url: chrome.runtime.getURL(`audit.html?${params.toString()}`),
    type: "popup",
    width: 1000,
    height: 750,
  });
  stepEl.textContent = "검토 창을 열었습니다.";
});

refreshView();
