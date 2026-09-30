// codebeamer 비밀번호는 브라우저 세션 저장소(chrome.storage.session)에만 잠깐 보관된다 -
// 브라우저를 닫으면 사라지고, 디스크에 남지 않는다. 서버가 없어서(서버리스) 이 확장이 직접
// codebeamer를 호출해야 하니 불가피한 트레이드오프다 (자세한 배경은 사용자와의 설계 논의 참고).

import { createClient } from "./lib/codebeamerClient.js";
import { verifyLogin, listProjects } from "./lib/projects.js";
import { listRegisteredTrackerNames, suggestTemplateTracker, loadProjectTrackers } from "./lib/collector.js";
import { cloneTracker, deleteTracker } from "./lib/trackerAdmin.js";
import { extractProcessTag } from "./lib/wikiTable.js";
import { loadReviewState } from "./lib/reviewState.js";
import { exportHistorySnapshot, importHistorySnapshot } from "./lib/history.js";
import { checkUserProjectRole, filterProjectsByRole } from "./lib/memberRoles.js";
import { BASE_URL, BASE_URL_V3, PROJ_BASE_URL, CM_ROLE_NAME, TRACKER_NAME_CIL, TRACKER_NAME_NCL } from "./lib/config.js";

const loginView = document.getElementById("loginView");
const runView = document.getElementById("runView");
const errorEl = document.getElementById("error");
const stepEl = document.getElementById("step");
const projectSearchInput = document.getElementById("projectSearchInput");
const projectDropdownList = document.getElementById("projectDropdownList");
const checkpointShareRow = document.getElementById("checkpointShareRow");
const exportCheckpointBtn = document.getElementById("exportCheckpointBtn");
const importCheckpointBtn = document.getElementById("importCheckpointBtn");
const importCheckpointFile = document.getElementById("importCheckpointFile");
const checkpointShareStatus = document.getElementById("checkpointShareStatus");
const trackerPicker = document.getElementById("trackerPicker");
const trackerSearchInput = document.getElementById("trackerSearchInput");
const trackerListBox = document.getElementById("trackerListBox");
const trackerBulkButtons = document.getElementById("trackerBulkButtons");
const trackerSelectAllBtn = document.getElementById("trackerSelectAllBtn");
const trackerSelectNoneBtn = document.getElementById("trackerSelectNoneBtn");
const trackerSelectionSummary = document.getElementById("trackerSelectionSummary");
const nameMismatchBlock = document.getElementById("nameMismatchBlock");
const nameMismatchUnregisteredWrap = document.getElementById("nameMismatchUnregisteredWrap");
const nameMismatchUnregisteredList = document.getElementById("nameMismatchUnregisteredList");
const nameMismatchUnregisteredCount = document.getElementById("nameMismatchUnregisteredCount");
const nameMismatchCilOnlyWrap = document.getElementById("nameMismatchCilOnlyWrap");
const nameMismatchCilOnlyList = document.getElementById("nameMismatchCilOnlyList");
const nameMismatchCilOnlyCount = document.getElementById("nameMismatchCilOnlyCount");
const recheckNameMatchBtn = document.getElementById("recheckNameMatchBtn");
const trackerCreateOverlay = document.getElementById("trackerCreateOverlay");
const trackerCreateSourceNote = document.getElementById("trackerCreateSourceNote");
const trackerCreateProjectSelect = document.getElementById("trackerCreateProjectSelect");
const trackerCreateTemplateSelect = document.getElementById("trackerCreateTemplateSelect");
const trackerCreateNameInput = document.getElementById("trackerCreateNameInput");
const trackerCreateKeyInput = document.getElementById("trackerCreateKeyInput");
const trackerCreateError = document.getElementById("trackerCreateError");
const trackerCreateCancelBtn = document.getElementById("trackerCreateCancelBtn");
const trackerCreateConfirmBtn = document.getElementById("trackerCreateConfirmBtn");
const trackerDeleteOverlay = document.getElementById("trackerDeleteOverlay");
const trackerDeleteMessage = document.getElementById("trackerDeleteMessage");
const trackerDeleteError = document.getElementById("trackerDeleteError");
const trackerDeleteCancelBtn = document.getElementById("trackerDeleteCancelBtn");
const trackerDeleteConfirmBtn = document.getElementById("trackerDeleteConfirmBtn");
// 주기적 활동 산출물 검사를 당분간 안 하기로 해서, 이 주기 선택 UI 참조도 같이 주석 처리
// (popup.html의 관련 <select> 자체도 주석 처리돼 있음 - 필요해지면 같이 복구).
// const cadenceSelect = document.getElementById("cadenceSelect");
// const weekdaySelect = document.getElementById("weekdaySelect");
// const dayOfMonthSelect = document.getElementById("dayOfMonthSelect");
const lastAuditInfo = document.getElementById("lastAuditInfo");
const viewLastBtn = document.getElementById("viewLastBtn");
const runBtn = document.getElementById("runBtn");
const cmRoleWarning = document.getElementById("cmRoleWarning");
const projectFilterNote = document.getElementById("projectFilterNote");

let allProjects = [];
let selectedProjectName = null;
let activeOptionIndex = -1;

let allTrackerNames = [];
let trackerNamesLoadedForProject = null;
let selectedTrackerNames = new Set();
let hasStoredTrackerSelection = false; // 이 프로젝트에 대해 세션 중 명시적으로 선택을 저장한 적 있는지
// 지금 선택된 프로젝트의 트래커 목록을 다 불러왔는지. 이게 false인 동안(=allTrackerNames가
// 아직 비어있는 로딩 중) "새 감사 시작"을 누르면, runBtn 클릭 핸들러의 isPartialSelection
// 판단이 allTrackerNames.length>0에 기대고 있어서 "선택 트래커만"이 아니라 "전체 감사"로
// 조용히 돌아버린다(트래커 선택을 해뒀어도 무시됨) - 그래서 이 플래그로 로딩 중엔 아예 막는다.
let trackerNamesReady = false;
// 트래커/Item List 이름 불일치(둘 중 하나에만 있는 것)가 있으면 true - 이름을 맞춰서
// 재확인하기 전까지는 감사 대상에서 조용히 빠지는 산출물이 생기므로, 감사 시작 자체를 막는다.
let hasNameMismatch = false;
// 이름 불일치 화면에서 트래커를 바로 생성(복제)/삭제할 때 쓰는 상태. mismatchProjectUri는
// loadTrackerNamesForCurrentProject가 채워두고(새 트래커가 만들어질 대상 프로젝트),
// pendingDelete*는 삭제 확인 다이얼로그가 열려있는 동안만 잠깐 들고 있는다(어느 트래커를
// 지울지). templateProjectsCache는 "템플릿을 가져올 프로젝트" 드롭다운용 - 감사 대상
// 프로젝트와 무관하게 계정이 접근 가능한 전체 프로젝트 목록이라 세션 동안 한 번만 불러와
// 재사용한다.
let mismatchProjectUri = null;
let templateProjectsCache = null;
let pendingDeleteTrackerUri = null;
let pendingDeleteTrackerName = null;

const runConfirmOverlay = document.getElementById("runConfirmOverlay");
const runConfirmYesBtn = document.getElementById("runConfirmYesBtn");
const runConfirmNoBtn = document.getElementById("runConfirmNoBtn");

function hideRunConfirmModal() {
  runConfirmOverlay.classList.add("hidden");
}

function showRunConfirmModal() {
  runConfirmOverlay.classList.remove("hidden");
}

async function refreshLastAuditInfo() {
  hideRunConfirmModal();
  checkpointShareStatus.classList.add("hidden");
  checkpointShareStatus.textContent = "";
  checkpointShareRow.classList.toggle("hidden", !selectedProjectName);
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

function showCheckpointShareStatus(text) {
  checkpointShareStatus.textContent = text;
  checkpointShareStatus.classList.remove("hidden");
}

// 체크포인트(문서 이력 확인 기준)는 chrome.storage.local, 즉 이 브라우저 안에만 있어서
// 같은 프로젝트를 여러 사람이 각자 다른 컴퓨터에서 감사하면 서로 안 맞을 수 있다 - 이
// 내보내기/가져오기로 파일을 통해 수동으로 동기화한다(history.js 참고).
exportCheckpointBtn.addEventListener("click", async () => {
  if (!selectedProjectName) return;
  const data = await exportHistorySnapshot(selectedProjectName);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const safeProject = selectedProjectName.replace(/[\\/:*?"<>|]/g, "_");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const a = document.createElement("a");
  a.href = url;
  a.download = `SUP8_체크포인트_${safeProject}_${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showCheckpointShareStatus("내보내기 완료. 이 파일을 팀원에게 전달해주세요.");
});

importCheckpointBtn.addEventListener("click", () => {
  importCheckpointFile.click();
});

importCheckpointFile.addEventListener("change", async () => {
  const file = importCheckpointFile.files[0];
  importCheckpointFile.value = ""; // 같은 파일을 다시 골라도 change가 또 뜨도록 초기화
  if (!file || !selectedProjectName) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.snapshot !== "object" || data.snapshot === null) {
      throw new Error("체크포인트 파일 형식이 올바르지 않습니다.");
    }
    const projectNote = data.projectName && data.projectName !== selectedProjectName
      ? ` (원래 "${data.projectName}" 프로젝트 것이니 프로젝트가 맞는지 확인해주세요)`
      : "";
    const result = await importHistorySnapshot(selectedProjectName, data.snapshot);
    const exportedAtNote = data.exportedAt ? `${new Date(data.exportedAt).toLocaleString("ko-KR")} 기준 ` : "";
    showCheckpointShareStatus(`가져오기 완료 - ${exportedAtNote}${result.mergedCount}개 트래커 반영됨${projectNote}.`);
  } catch (e) {
    showCheckpointShareStatus(`가져오기 실패: ${e.message}`);
  }
});

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
  trackerNamesReady = false;
  hasNameMismatch = false;
  runBtn.disabled = true;
  trackerSearchInput.value = "";
  trackerSearchInput.readOnly = false;
  trackerSearchInput.placeholder = "트래커 검색...";
  trackerListBox.innerHTML = "";
  trackerListBox.classList.add("hidden");
  trackerBulkButtons.classList.add("hidden");
  trackerPicker.classList.remove("hidden");
  nameMismatchBlock.classList.add("hidden");
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

// 이름 순 정렬 + 개수 표시 + 한 줄씩 구분되는 카드형 리스트로 렌더링한다(그냥 죽 늘어놓으면
// 트래커가 10개, 20개씩 나올 때 알아보기 힘들어서). 각 줄은 나중에 "복사" 버튼이 그대로
// 텍스트로 긁어갈 수 있게 .mismatch-list-item-name 클래스를 붙인다. renderActions가 있으면
// 이름 옆에 그 항목 전용 버튼(생성/삭제)을 같이 붙인다 - codebeamer를 오가지 않고 여기서
// 바로 처리할 수 있게.
function renderMismatchList(container, countEl, items, getText, renderActions) {
  // getText(item)이 빈 값인 행이 섞여 있어도(원인 확인 중) 정렬에서 죽지 않게 방어하고,
  // 콘솔에 원인 파악용으로 그 항목을 그대로 남긴다.
  const sorted = [...items].sort((a, b) => {
    const nameA = getText(a) || "";
    const nameB = getText(b) || "";
    return nameA.localeCompare(nameB, "ko");
  });
  countEl.textContent = `${sorted.length}개`;
  container.innerHTML = "";
  for (const item of sorted) {
    const displayName = getText(item);
    if (!displayName) console.warn("[renderMismatchList] 이름이 없는 항목:", item);
    const row = document.createElement("div");
    row.className = "mismatch-list-item";
    const nameSpan = document.createElement("span");
    nameSpan.className = "mismatch-list-item-name";
    nameSpan.textContent = displayName || "(이름 없음)";
    row.appendChild(nameSpan);
    renderActions?.(item, row);
    container.appendChild(row);
  }
}

// 그룹 제목 옆 "복사" 버튼 - 다른 사람에게 넘기는 게 아니라, 본인이 직접 codebeamer 가서
// 트래커를 만들거나 Item List 이름을 고칠 때 하나씩 보면서 처리하기 편하게 목록을 줄바꿈으로
// 이어붙여 클립보드에 복사해둔다. 이름만 긁어야 하므로(옆에 붙은 생성/삭제 버튼 글자가 섞여
// 들어가면 안 됨) .mismatch-list-item이 아니라 .mismatch-list-item-name만 읽는다.
nameMismatchBlock.addEventListener("click", async (e) => {
  const btn = e.target.closest(".mismatch-copy-btn");
  if (!btn) return;
  const container = document.getElementById(btn.dataset.copyTarget);
  const text = Array.from(container.querySelectorAll(".mismatch-list-item-name")).map((el) => el.textContent).join("\n");
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "복사됨!";
  } catch (e2) {
    btn.textContent = "복사 실패";
  }
  setTimeout(() => { btn.textContent = original; }, 1200);
});

async function loadTrackerNamesForCurrentProject() {
  // 이 함수가 끝나기 전까지(성공/실패 어느 쪽이든) "새 감사 시작"을 막아둔다 - resetTrackerPicker가
  // 이미 호출 시점에 꺼뒀지만, 여기서도 끝까지 보장한다(위 trackerNamesReady 선언부 설명 참고).
  try {
    const credentials = await getCredentials();
    if (!credentials || !selectedProjectName) return;

    trackerSearchInput.readOnly = true;
    trackerSearchInput.placeholder = "불러오는 중...";
    trackerListBox.innerHTML = '<div class="project-option-empty">불러오는 중...</div>';
    trackerListBox.classList.remove("hidden");
    try {
      const client = createClient({ baseUrl: BASE_URL, baseUrlV3: BASE_URL_V3, ...credentials });
      const { trackerNames, unregisteredTrackers, cilOnlyEntries, projectUri } = await listRegisteredTrackerNames(
        client, { projectName: selectedProjectName, trackerCil: TRACKER_NAME_CIL }
      );
      trackerNamesLoadedForProject = selectedProjectName;
      mismatchProjectUri = projectUri;
      trackerSearchInput.placeholder = "트래커 검색...";

      // 트래커/Item List 이름이 하나라도 안 맞으면, 그 산출물은 감사도 반영도 안 되는 채로
      // 조용히 빠지게 된다(runAudit이 아예 못 만들어짐) - codebeamer에서 이름을 맞추고 다시
      // 확인하기 전까지는 감사 시작 자체를 막는다(트래커 선택 UI도 어차피 못 돌리니 숨긴다).
      hasNameMismatch = unregisteredTrackers.length > 0 || cilOnlyEntries.length > 0;
      if (hasNameMismatch) {
        trackerPicker.classList.add("hidden");
        trackerSelectionSummary.classList.add("hidden");
        nameMismatchUnregisteredWrap.classList.toggle("hidden", unregisteredTrackers.length === 0);
        renderMismatchList(nameMismatchUnregisteredList, nameMismatchUnregisteredCount, unregisteredTrackers, (t) => t.trackerName, (t, row) => {
          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "mismatch-action-btn mismatch-delete-btn";
          delBtn.textContent = "삭제";
          delBtn.addEventListener("click", () => openTrackerDeleteDialog(t));
          row.appendChild(delBtn);
        });
        nameMismatchCilOnlyWrap.classList.toggle("hidden", cilOnlyEntries.length === 0);
        renderMismatchList(nameMismatchCilOnlyList, nameMismatchCilOnlyCount, cilOnlyEntries, (t) => t.trackerName, (t, row) => {
          const createBtn = document.createElement("button");
          createBtn.type = "button";
          createBtn.className = "mismatch-action-btn mismatch-create-btn";
          createBtn.textContent = "트래커 생성";
          createBtn.addEventListener("click", () => openTrackerCreateDialog(t));
          row.appendChild(createBtn);
        });
        nameMismatchBlock.classList.remove("hidden");
        return;
      }

      nameMismatchBlock.classList.add("hidden");
      trackerPicker.classList.remove("hidden");
      allTrackerNames = trackerNames;

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
      // 실패 원인을 조용히 숨기지 않고 화면에 그대로 보여준다 - CIL 트래커를 못 찾음/권한
      // 부족/네트워크 오류 등 원인이 제각각이라, 메시지 없이는 사용자가 뭘 고쳐야 할지 알 수
      // 없다 (console에도 남겨서 개발자 도구로 스택까지 볼 수 있게 한다).
      console.error("트래커 목록 조회 실패:", e);
      allTrackerNames = [];
      trackerSearchInput.placeholder = "트래커 목록을 불러오지 못했습니다";
      const empty = document.createElement("div");
      empty.className = "project-option-empty";
      empty.textContent = e?.message ? `불러오기 실패: ${e.message}` : "트래커 목록을 불러오지 못했습니다";
      trackerListBox.innerHTML = "";
      trackerListBox.appendChild(empty);
      trackerListBox.classList.remove("hidden");
    } finally {
      trackerSearchInput.readOnly = false;
    }
  } finally {
    trackerNamesReady = true;
    runBtn.disabled = hasNameMismatch;
  }
}

recheckNameMatchBtn.addEventListener("click", () => {
  loadTrackerNamesForCurrentProject();
});

// ── 이름 불일치 화면에서 바로 트래커 생성(복제)/삭제 ────────────────────────────
// codebeamer REST API(cb/rest, v2)의 POST {트래커URI}/clone, DELETE {트래커URI}를 그대로
// 쓴다(lib/trackerAdmin.js). 두 작업 다 되돌리기 어려운 작업이라(삭제는 codebeamer 휴지통으로
// 이동되긴 하지만 이 확장에서 복구할 방법은 없음) 확인 다이얼로그를 거친 뒤에만 실행하고,
// 끝나면 항상 이름 불일치 목록을 다시 불러와(loadTrackerNamesForCurrentProject) 최신 상태를
// 보여준다.
//
// 복제 템플릿은 감사 대상 프로젝트 자신의 트래커가 아니라, 사용자가 직접 고르는 별도
// "템플릿 프로젝트"에서 가져온다 - 감사 대상 프로젝트 안에서 다른 프로세스 도메인 트래커를
// 템플릿으로 쓰면 권한 설정이 프로세스마다 달라서 꼬이기 때문(실사용자 확인 사항). 템플릿
// 프로젝트 후보는 계정이 접근 가능한 전체 프로젝트 목록이고, 감사 대상 프로젝트 이름에 있는
// "ASPICE4.1" 같은 버전 태그와 같은 태그가 붙은 "...Template..." 프로젝트가 있으면 그걸
// 기본값으로 미리 골라둔다(예: "ASPICE4.1 Test PROJECT" -> "SL Project Template1.0
// (ASPICE4.1 CSMS1.0)"). 못 찾으면 추천 없이 사용자가 직접 고르게 둔다.

function extractAspiceTag(name) {
  const m = /ASPICE\s*[\d.]+/i.exec(name || "");
  return m ? m[0].replace(/\s+/g, "").toUpperCase() : null;
}

function guessDefaultTemplateProject(projects, currentProjectName) {
  const tag = extractAspiceTag(currentProjectName);
  if (!tag) return null;
  return projects.find((p) => /template/i.test(p.name) && extractAspiceTag(p.name) === tag) || null;
}

// 감사 대상 프로젝트 이름에 ASPICE 버전 태그가 없어서(예: "CB Test Project") 자동 추천이
// 안 되는 경우, 사용자가 한 번 고른 템플릿 프로젝트를 그 프로젝트 전용 기본값으로 기억해둔다
// (selected_trackers와 같은 방식 - 프로젝트명별 맵으로 세션 동안 저장). 다음에 같은 프로젝트에서
// "트래커 생성"을 열면 매번 다시 찾지 않고 바로 이 프로젝트가 맨 위에 기본 선택돼 있다.
async function persistTemplateProjectChoice(projectUriValue) {
  if (!selectedProjectName || !projectUriValue) return;
  const { template_project_by_project } = await chrome.storage.session.get("template_project_by_project");
  const map = template_project_by_project || {};
  map[selectedProjectName] = projectUriValue;
  await chrome.storage.session.set({ template_project_by_project: map });
}

async function getStoredTemplateProjectUri() {
  if (!selectedProjectName) return null;
  const { template_project_by_project } = await chrome.storage.session.get("template_project_by_project");
  const map = template_project_by_project || {};
  return map[selectedProjectName] || null;
}

// 방금 불러온 템플릿 프로젝트의 트래커 목록 - 트래커 드롭다운에서 고른 값(uri)으로 그
// 트래커의 원래 이름(프로세스 태그 포함)을 다시 찾을 때 쓴다(applyNameFromSelectedTemplate).
let currentTemplateTrackerList = [];
// 지금 만들려는 새 트래커의 "순수" 이름(CIL 항목명에서 대괄호 태그를 뗀 것) - 템플릿을
// 바꿀 때마다 이름 입력칸을 이 기준으로 다시 채우기 위해 다이얼로그를 여는 시점에 고정해둔다.
let pendingCreateBaseName = "";

// "SUP.10" + "Change Request Plan" -> "SUP10_CRP" - 태그의 점을 떼고, 이름의 각 단어
// 첫 글자를 이어붙인다. 키는 codebeamer 전체에서 겹치면 안 되는 짧은 식별자라 자동 생성은
// 어디까지나 출발점이고, 겹치면(생성 실패) 사용자가 직접 고쳐야 한다.
function generateKeySuggestion(tag, baseName) {
  const tagPart = (tag || "").replace(/\./g, "");
  const initials = (baseName || "").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").toUpperCase();
  if (tagPart && initials) return `${tagPart}_${initials}`;
  return tagPart || initials;
}

// codebeamer는 트래커 이름이 "[SUP.9]Change Management Plan"처럼 프로세스 태그 대괄호로
// 시작해야만 Item List와 매칭된다(collector.js의 mergeCilWithTrackers - 대괄호 없는
// 트래커는 아예 매칭 후보에서 빠진다). CIL 항목명 자체엔 보통 이 태그가 없어서, 그대로
// 새 트래커 이름으로 쓰면 만들어져도 계속 "Item List엔 있는데 트래커를 못 찾음"에 남는다.
// 그래서 고른 템플릿 트래커의 태그를 그대로 물려받아 이름/키를 채운다(편집 가능 - 필요하면
// 직접 고칠 수 있음).
function applyNameFromSelectedTemplate() {
  const template = currentTemplateTrackerList.find((t) => t.uri === trackerCreateTemplateSelect.value);
  if (!template) return;
  const tag = extractProcessTag(template.name);
  trackerCreateNameInput.value = tag ? `[${tag}]${pendingCreateBaseName}` : pendingCreateBaseName;
  trackerCreateKeyInput.value = generateKeySuggestion(tag, pendingCreateBaseName);
}

// 템플릿 프로젝트 드롭다운에서 고른 프로젝트의 트래커 목록을 불러와 템플릿 트래커 드롭다운을
// 채운다(이름이 가장 비슷한 걸 추천/기본 선택). targetName은 추천 기준으로 삼을 이름 -
// 프로세스 태그가 매칭에 영향을 주지 않도록(collector.js의 suggestTemplateTracker도 태그를
// 떼고 비교하긴 하지만) pendingCreateBaseName(순수 이름)을 넘긴다.
async function refreshTemplateTrackerOptions(targetName) {
  const projectUri = trackerCreateProjectSelect.value;
  trackerCreateTemplateSelect.innerHTML = "";
  currentTemplateTrackerList = [];
  if (!projectUri) {
    trackerCreateConfirmBtn.disabled = true;
    return;
  }
  trackerCreateTemplateSelect.innerHTML = '<option value="">불러오는 중...</option>';
  trackerCreateConfirmBtn.disabled = true;
  try {
    const credentials = await getCredentials();
    const client = createClient({ baseUrl: BASE_URL, baseUrlV3: BASE_URL_V3, ...credentials });
    const trackers = await loadProjectTrackers(client, projectUri);
    currentTemplateTrackerList = trackers;
    const suggested = suggestTemplateTracker(targetName, trackers);
    trackerCreateTemplateSelect.innerHTML = "";
    if (trackers.length === 0) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "(이 프로젝트엔 트래커가 없습니다)";
      trackerCreateTemplateSelect.appendChild(empty);
      return;
    }
    // 추천 트래커가 있으면 목록 맨 위로 올려서, 드롭다운을 열자마자 스크롤 없이 바로
    // 보이게 한다(선택값만 맞춰두면 native select가 원래 자리에서 하이라이트만 해줘서
    // 목록이 길면 찾기 불편하다).
    const orderedTrackers = suggested ? [suggested, ...trackers.filter((t) => t.uri !== suggested.uri)] : trackers;
    for (const t of orderedTrackers) {
      const option = document.createElement("option");
      option.value = t.uri;
      option.textContent = t.uri === suggested?.uri ? `⭐ ${t.name} (추천)` : t.name;
      trackerCreateTemplateSelect.appendChild(option);
    }
    if (suggested) trackerCreateTemplateSelect.value = suggested.uri;
    applyNameFromSelectedTemplate();
    trackerCreateConfirmBtn.disabled = false;
  } catch (e) {
    trackerCreateTemplateSelect.innerHTML = "";
    trackerCreateError.textContent = `트래커 목록을 불러오지 못했습니다: ${e.message}`;
    trackerCreateError.style.display = "block";
  }
}

trackerCreateProjectSelect.addEventListener("change", () => {
  // 사용자가 직접 고른 프로젝트는 이 감사 대상 프로젝트의 기본 템플릿 프로젝트로 기억해둔다
  // (다음에 열 때 자동 추천이 없어도 이 선택이 우선 적용됨 - getStoredTemplateProjectUri).
  persistTemplateProjectChoice(trackerCreateProjectSelect.value);
  refreshTemplateTrackerOptions(pendingCreateBaseName);
});

trackerCreateTemplateSelect.addEventListener("change", applyNameFromSelectedTemplate);

async function openTrackerCreateDialog(cilEntry) {
  trackerCreateError.style.display = "none";
  trackerCreateError.textContent = "";
  trackerCreateSourceNote.textContent = `Item List 항목: ${cilEntry.trackerName}`;
  // CIL 항목명엔 보통 프로세스 태그가 없으니(있으면 떼고) 일단 그대로 채워두고, 템플릿을
  // 고르는 즉시 applyNameFromSelectedTemplate이 그 템플릿의 태그를 붙여 다시 채운다.
  pendingCreateBaseName = cilEntry.trackerName.replace(/^\[.*?\]/, "").trim();
  trackerCreateNameInput.value = pendingCreateBaseName;
  trackerCreateKeyInput.value = "";
  trackerCreateProjectSelect.innerHTML = '<option value="">불러오는 중...</option>';
  trackerCreateTemplateSelect.innerHTML = "";
  trackerCreateConfirmBtn.disabled = true;
  trackerCreateOverlay.classList.remove("hidden");

  try {
    if (!templateProjectsCache) {
      const credentials = await getCredentials();
      const client = createClient({ baseUrl: BASE_URL, baseUrlV3: BASE_URL_V3, ...credentials });
      // CM 권한으로 필터된 allProjects(감사용 프로젝트 목록)와 달리, 템플릿 프로젝트는
      // 감사 대상이 아니라서(권한 설정만 미리 해둔 프로젝트일 수 있음) 필터 없이 전체
      // 프로젝트 목록에서 고를 수 있게 한다.
      templateProjectsCache = await listProjects(client);
    }
  } catch (e) {
    trackerCreateError.textContent = `프로젝트 목록을 불러오지 못했습니다: ${e.message}`;
    trackerCreateError.style.display = "block";
    return;
  }

  // 이 감사 대상 프로젝트에서 예전에 직접 고른 템플릿 프로젝트가 있으면 그걸 최우선으로,
  // 없으면 ASPICE 버전 태그로 추측한 프로젝트를 기본값으로 쓴다. 기본값은 목록 맨 위로
  // 올려서(트래커 드롭다운과 동일한 이유) 열자마자 바로 보이게 한다.
  const storedProjectUri = await getStoredTemplateProjectUri();
  const storedProject = storedProjectUri ? templateProjectsCache.find((p) => p.uri === storedProjectUri) : null;
  const defaultProject = storedProject || guessDefaultTemplateProject(templateProjectsCache, selectedProjectName);

  trackerCreateProjectSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "-- 템플릿 프로젝트 선택 --";
  trackerCreateProjectSelect.appendChild(placeholder);
  const orderedProjects = defaultProject
    ? [defaultProject, ...templateProjectsCache.filter((p) => p.uri !== defaultProject.uri)]
    : templateProjectsCache;
  for (const p of orderedProjects) {
    const option = document.createElement("option");
    option.value = p.uri;
    option.textContent = p.uri === defaultProject?.uri ? `⭐ ${p.name} (기본값)` : p.name;
    trackerCreateProjectSelect.appendChild(option);
  }
  if (defaultProject) trackerCreateProjectSelect.value = defaultProject.uri;

  await refreshTemplateTrackerOptions(pendingCreateBaseName);
}

function closeTrackerCreateDialog() {
  trackerCreateOverlay.classList.add("hidden");
}

trackerCreateCancelBtn.addEventListener("click", closeTrackerCreateDialog);

trackerCreateConfirmBtn.addEventListener("click", async () => {
  const templateTrackerUri = trackerCreateTemplateSelect.value;
  const name = trackerCreateNameInput.value.trim();
  const keyName = trackerCreateKeyInput.value.trim();

  trackerCreateError.style.display = "none";
  if (!templateTrackerUri) {
    trackerCreateError.textContent = "템플릿으로 쓸 트래커를 골라주세요.";
    trackerCreateError.style.display = "block";
    return;
  }
  if (!name || !keyName) {
    trackerCreateError.textContent = "이름과 키를 모두 입력해주세요.";
    trackerCreateError.style.display = "block";
    return;
  }
  if (!mismatchProjectUri) {
    trackerCreateError.textContent = "프로젝트 정보를 다시 불러온 뒤 시도해주세요.";
    trackerCreateError.style.display = "block";
    return;
  }

  trackerCreateConfirmBtn.disabled = true;
  trackerCreateConfirmBtn.textContent = "생성 중...";
  try {
    const credentials = await getCredentials();
    const client = createClient({ baseUrl: BASE_URL, baseUrlV3: BASE_URL_V3, ...credentials });
    await cloneTracker(client, { templateTrackerUri, projectUri: mismatchProjectUri, name, keyName });
    closeTrackerCreateDialog();
    await loadTrackerNamesForCurrentProject();
  } catch (e) {
    trackerCreateError.textContent = e?.message || "트래커 생성에 실패했습니다.";
    trackerCreateError.style.display = "block";
  } finally {
    trackerCreateConfirmBtn.disabled = false;
    trackerCreateConfirmBtn.textContent = "생성";
  }
});

function openTrackerDeleteDialog(unregisteredTracker) {
  pendingDeleteTrackerUri = unregisteredTracker.trackerUri;
  pendingDeleteTrackerName = unregisteredTracker.trackerName;
  trackerDeleteError.style.display = "none";
  trackerDeleteError.textContent = "";
  trackerDeleteMessage.innerHTML =
    `"${pendingDeleteTrackerName}" 트래커를 삭제하시겠습니까?<br><br>` +
    `codebeamer 휴지통으로 이동되어 관리자가 복구할 수는 있지만, 이 작업 자체는 되돌릴 수 없습니다.`;
  trackerDeleteConfirmBtn.disabled = false;
  trackerDeleteConfirmBtn.textContent = "예, 삭제";
  trackerDeleteOverlay.classList.remove("hidden");
}

function closeTrackerDeleteDialog() {
  trackerDeleteOverlay.classList.add("hidden");
  pendingDeleteTrackerUri = null;
  pendingDeleteTrackerName = null;
}

trackerDeleteCancelBtn.addEventListener("click", closeTrackerDeleteDialog);

trackerDeleteConfirmBtn.addEventListener("click", async () => {
  if (!pendingDeleteTrackerUri) return;
  trackerDeleteError.style.display = "none";
  trackerDeleteConfirmBtn.disabled = true;
  trackerDeleteConfirmBtn.textContent = "삭제 중...";
  try {
    const credentials = await getCredentials();
    const client = createClient({ baseUrl: BASE_URL, baseUrlV3: BASE_URL_V3, ...credentials });
    await deleteTracker(client, pendingDeleteTrackerUri);
    closeTrackerDeleteDialog();
    await loadTrackerNamesForCurrentProject();
  } catch (e) {
    trackerDeleteError.textContent = e?.message || "트래커 삭제에 실패했습니다.";
    trackerDeleteError.style.display = "block";
    trackerDeleteConfirmBtn.disabled = false;
    trackerDeleteConfirmBtn.textContent = "예, 삭제";
  }
});

trackerSearchInput.addEventListener("input", () => {
  renderTrackerOptions(trackerSearchInput.value);
});

// 주기적 활동 산출물 검사를 당분간 안 하기로 해서, 주기 설정 UI 관련 로직 전체 주석 처리
// (필요해지면 위 const 선언 3개와 함께 복구).
// for (let day = 1; day <= 31; day++) {
//   const option = document.createElement("option");
//   option.value = day;
//   option.textContent = `${day}일`;
//   dayOfMonthSelect.appendChild(option);
// }
//
// function updatePeriodicInputsVisibility() {
//   const isMonthly = cadenceSelect.value === "monthly";
//   weekdaySelect.classList.toggle("hidden", isMonthly);
//   dayOfMonthSelect.classList.toggle("hidden", !isMonthly);
// }
//
// async function loadPeriodicSettings() {
//   const stored = await chrome.storage.session.get(["periodic_cadence", "periodic_weekday", "periodic_day_of_month"]);
//   if (stored.periodic_cadence) cadenceSelect.value = stored.periodic_cadence;
//   if (stored.periodic_weekday) weekdaySelect.value = stored.periodic_weekday;
//   if (stored.periodic_day_of_month) dayOfMonthSelect.value = stored.periodic_day_of_month;
//   updatePeriodicInputsVisibility();
// }
//
// cadenceSelect.addEventListener("change", () => {
//   chrome.storage.session.set({ periodic_cadence: cadenceSelect.value });
//   updatePeriodicInputsVisibility();
// });
// weekdaySelect.addEventListener("change", () => {
//   chrome.storage.session.set({ periodic_weekday: weekdaySelect.value });
// });
// dayOfMonthSelect.addEventListener("change", () => {
//   chrome.storage.session.set({ periodic_day_of_month: dayOfMonthSelect.value });
// });

async function refreshView() {
  const credentials = await getCredentials();
  if (credentials) {
    loginView.classList.add("hidden");
    runView.classList.remove("hidden");
    const client = createClient({ baseUrl: BASE_URL, baseUrlV3: BASE_URL_V3, ...credentials });
    await loadProjects(client, credentials.username);
    // await loadPeriodicSettings(); // 주기 설정 UI 자체를 주석 처리해서 같이 비활성화
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

// 감사 결과 창은 side panel(popup.html)과 같은 확장 origin이라, 기본적으로 Chrome의 줌
// 레벨이 origin 단위로 저장돼서 한쪽에서 Ctrl +/-로 줌을 바꾸면 다른 쪽도 같이 바뀐다 - 감사
// 결과 창의 탭 줌 범위를 "이 탭만"으로 바꿔서 서로 안 엮이게 한다. 줌 API는 매니페스트 권한이
// 따로 필요 없다.
function openAuditWindow(url) {
  chrome.windows.create({ url, type: "popup", width: 1000, height: 750 }, (win) => {
    const tabId = win?.tabs?.[0]?.id;
    if (tabId == null) return;
    // windows.create 콜백 시점엔 아직 audit.html로의 첫 네비게이션이 안 끝나있어서, 여기서
    // 바로 setZoomSettings를 걸어도 그 직후 네비게이션이 완료되면서 Chrome이 per-tab 설정을
    // 도로 per-origin으로 초기화해버린다 - 그 탭의 로딩이 끝난 뒤에 걸어야 유지된다.
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.setZoomSettings(tabId, { scope: "per-tab" });
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

viewLastBtn.addEventListener("click", async () => {
  const credentials = await getCredentials();
  if (!credentials) {
    await refreshView();
    return;
  }
  if (!selectedProjectName) return;

  const params = new URLSearchParams({ project: selectedProjectName, mode: "view" });
  openAuditWindow(chrome.runtime.getURL(`audit.html?${params.toString()}`));
  stepEl.textContent = "직전 감사 결과 창을 열었습니다.";
});

// 실제로 감사 창을 여는 부분 - 확인이 필요 없거나(직전 미반영 결과가 없음), 확인 모달에서
// "예"를 눌렀을 때 호출된다.
function startNewAudit() {
  // 주기적 활동 산출물 검사를 당분간 안 하기로 해서 cadence/anchor는 안 보낸다 - audit.js가
  // URL에 없으면 DEFAULT_PERIODIC_CADENCE/ANCHOR로 자동 대체한다(어차피 이제 안 쓰이지만).
  const params = new URLSearchParams({
    project: selectedProjectName,
    trackerCil: TRACKER_NAME_CIL,
    trackerNcl: TRACKER_NAME_NCL,
  });
  const isPartialSelection = allTrackerNames.length > 0 && selectedTrackerNames.size < allTrackerNames.length;
  if (isPartialSelection) {
    params.set("onlyTrackers", JSON.stringify(Array.from(selectedTrackerNames)));
  }
  openAuditWindow(chrome.runtime.getURL(`audit.html?${params.toString()}`));
  stepEl.textContent = isPartialSelection
    ? `검토 창을 열었습니다 (선택한 트래커 ${selectedTrackerNames.size}개만 감사).`
    : "검토 창을 열었습니다.";
}

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
  if (!trackerNamesReady) {
    // allTrackerNames가 아직 비어있는 "로딩 중"과 "이 프로젝트는 트래커가 0개"를 구분 못 하면
    // 아래 isPartialSelection 판단이 깨져서 선택 범위를 무시하고 전체 감사로 돌아버린다.
    stepEl.textContent = "트래커 목록을 아직 불러오는 중입니다. 잠시 후 다시 시도해주세요.";
    return;
  }
  if (hasNameMismatch) {
    // runBtn이 disabled라 보통 여기까지 못 오지만, 방어적으로 한 번 더 막는다.
    stepEl.textContent = "이름이 안 맞는 항목을 먼저 codebeamer에서 정리해주세요.";
    return;
  }
  if (allTrackerNames.length > 0 && selectedTrackerNames.size === 0) {
    stepEl.textContent = "최소 1개의 트래커는 선택해야 합니다.";
    return;
  }

  const existing = await loadReviewState(selectedProjectName);
  if (existing && existing.status !== "applied") {
    showRunConfirmModal();
    return;
  }
  startNewAudit();
});

runConfirmYesBtn.addEventListener("click", () => {
  hideRunConfirmModal();
  startNewAudit();
});
runConfirmNoBtn.addEventListener("click", () => {
  hideRunConfirmModal();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !selectedProjectName) return;
  if (`review_state_${selectedProjectName}` in changes) refreshLastAuditInfo();
});

refreshView();
