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
import { diffAndUpdateHistory, loadHistorySnapshot, diffAgainstAppliedSnapshot, updateAppliedSnapshot } from "./lib/history.js";
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
const newTrackersWrap = document.getElementById("newTrackersWrap");
const newTrackersList = document.getElementById("newTrackersList");
const changedTrackersWrap = document.getElementById("changedTrackersWrap");
const changedTrackersList = document.getElementById("changedTrackersList");
const versionFailWrap = document.getElementById("versionFailWrap");
const versionFailList = document.getElementById("versionFailList");
const manualStatusCheckWrap = document.getElementById("manualStatusCheckWrap");
const manualStatusCheckList = document.getElementById("manualStatusCheckList");
const unchangedSinceApprovalWrap = document.getElementById("unchangedSinceApprovalWrap");
const unchangedSinceApprovalList = document.getElementById("unchangedSinceApprovalList");
const docHistoryManualCheckWrap = document.getElementById("docHistoryManualCheckWrap");
const docHistoryManualCheckList = document.getElementById("docHistoryManualCheckList");
const crIdManualCheckWrap = document.getElementById("crIdManualCheckWrap");
const crIdManualCheckList = document.getElementById("crIdManualCheckList");
const noTrackerManualCheckWrap = document.getElementById("noTrackerManualCheckWrap");
const noTrackerManualCheckList = document.getElementById("noTrackerManualCheckList");
const unregisteredReferenceFilesWrap = document.getElementById("unregisteredReferenceFilesWrap");
const unregisteredReferenceFilesList = document.getElementById("unregisteredReferenceFilesList");
const incompleteFetchWrap = document.getElementById("incompleteFetchWrap");
const incompleteFetchList = document.getElementById("incompleteFetchList");
const retryIncompleteFetchBtn = document.getElementById("retryIncompleteFetchBtn");
const fetchFailedWrap = document.getElementById("fetchFailedWrap");
const fetchFailedList = document.getElementById("fetchFailedList");
const retryFetchFailedBtn = document.getElementById("retryFetchFailedBtn");
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
  newTrackers: [],
  changedTrackers: [],
  versionCheckFailures: [],
  incompleteFetchTrackers: [],
  manualStatusCheckTrackers: [],
  docHistoryManualCheckTrackers: [],
  crIdManualCheckTrackers: [],
  noTrackerManualCheckTrackers: [],
  fetchFailedTrackers: [],
  unchangedSinceApprovalTrackers: [],
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
  if (evt.done) {
    // phase 메시지(점 애니메이션 도는 줄)는 트래커별 조회 루프처럼 "끝났다"는 신호가 따로
    // 없어서, collectReferenceFileRecords처럼 phase만 보내고 끝나는 단계는 이걸로 명시적으로
    // 마무리해줘야 마지막 줄이 "아직 조회 중"인 것처럼 계속 애니메이션이 도는 걸 막을 수 있다.
    stopPhaseAnimation();
    appendLogLine(evt.doneText || "완료", true);
    return;
  }
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

const RULE_LABELS = { saveRule: "저장", versionRule: "버전", docHistoryRule: "이력", statusRule: "상태" };
const ALL_RULE_KEYS = ["saveRule", "versionRule", "docHistoryRule", "statusRule"];

// "직접확인 필요"로 뜨는 세 가지(🙋 상태 규칙 자동 판정 불가, 📝 문서 이력 PR 기재 확인 필요,
// 📂 codebeamer 밖 산출물 - 저장/버전/이력 규칙 확인 필요)만 여기서 사람이 OK/NG/N-A를 직접
// 고르고 코멘트를 쓰게 강제한다(필수). 이벤트성/Test Result류/승인 완료로 버전 규칙이 아예
// 스킵되는 경우처럼 "원래 그 규칙 대상이 아닌" N/A는 대상이 아니다 - 그런 건 도구가 이미
// 정확히 판단한 거라 사람이 매번 다시 확인할 이유가 없다. 이 목록에 없는 나머지 규칙들은
// 강제는 아니지만, createManualRow에서 "선택 사항"으로 똑같이 고칠 수 있게 한다.
function getManualCheckFlags(record) {
  const flags = [];
  if ((warningsData.manualStatusCheckTrackers || []).includes(record.trackerName)) {
    const links = record.paItemId
      ? [{ href: `https://codebeamer.slworld.com/cb/issue/${record.paItemId}`, text: "🔗 대상 산출물에서 직접 확인" }]
      : [];
    flags.push({ rule: "statusRule", label: "상태", reason: null, links });
  }
  const docHistEntry = (warningsData.docHistoryManualCheckTrackers || []).find(
    (t) => t.trackerName === record.trackerName
  );
  if (docHistEntry) {
    const links = docHistEntry.paItemId
      ? [{ href: `https://codebeamer.slworld.com/cb/issue/${docHistEntry.paItemId}`, text: "🔗 대상 산출물에서 직접 확인" }]
      : [];
    flags.push({ rule: "docHistoryRule", label: "이력", reason: docHistEntry.reason, links });
  }
  // CR 기재 확인도 PR과 같은 codebeamer 필드(이력)를 강제 대상으로 삼는다 - 둘 다 "문서 이력
  // 기술 규칙"의 증거라서, 둘 중 하나라도 걸리면 이력 규칙을 직접 판정해야 한다.
  const crIdEntry = (warningsData.crIdManualCheckTrackers || []).find(
    (t) => t.trackerName === record.trackerName
  );
  if (crIdEntry) {
    flags.push({ rule: "docHistoryRule", label: "이력", reason: crIdEntry.reason });
  }
  // Source Code처럼 codebeamer에 연결된 트래커 자체가 없는 산출물(noTrackerManualCheckTrackers) -
  // 상태 규칙은 리뷰레포트 개념 자체가 없어 그냥 N/A로 두고, 나머지 세 규칙만 강제한다.
  if ((warningsData.noTrackerManualCheckTrackers || []).includes(record.trackerName)) {
    const reason = "실제 산출물이 codebeamer 밖(Bitbucket 등)에 있어 자동 판정이 불가능함";
    flags.push({ rule: "saveRule", label: "저장", reason });
    flags.push({ rule: "versionRule", label: "버전", reason });
    flags.push({ rule: "docHistoryRule", label: "이력", reason });
  }
  // 조회가 아예 실패했거나(fetchFailedTrackers - 데이터가 하나도 없음) 조회가 불완전했던
  // (incompleteFetchTrackers - 일부만 있어서 자동 판정을 못 믿음) 트래커는 4개 규칙 전부
  // 강제한다. 체크박스로 이 트래커를 반영 대상에서 빼면(재시도로 나중에 따로 해결하기로
  // 하면) 다른 강제 항목과 마찬가지로 이번엔 입력 안 해도 된다(validateManualInputs 참고).
  if ((warningsData.fetchFailedTrackers || []).includes(record.trackerName)) {
    const reason = "네트워크 오류로 조회하지 못해 자동 판정 불가능 - 직접 확인 후 판정 필요";
    for (const rule of ALL_RULE_KEYS) flags.push({ rule, label: RULE_LABELS[rule], reason });
  }
  if ((warningsData.incompleteFetchTrackers || []).includes(record.trackerName)) {
    const reason = "데이터 조회가 불완전해 자동 판정을 신뢰할 수 없음 - 직접 확인 후 판정 필요";
    for (const rule of ALL_RULE_KEYS) flags.push({ rule, label: RULE_LABELS[rule], reason });
  }

  // 같은 규칙이 여러 조건에 동시에 걸려 중복으로 쌓일 수 있어서(예: 상태 규칙 자동 판정 불가
  // 대상이면서 동시에 조회도 불완전한 경우), 규칙별로 하나만 남긴다(먼저 쌓인 것 유지).
  const seenRules = new Set();
  return flags.filter((f) => (seenRules.has(f.rule) ? false : (seenRules.add(f.rule), true)));
}

// 코멘트 텍스트에서 규칙 하나의 자동 사유(reasonText)만 콕 집어 떼어낸다 - 여러 규칙 사유가
// " / "로 이어붙어 있는데, 한 규칙의 사유 자체가 내부적으로 여러 조각을 " / "로 합친 것일 수도
// 있어서(예: 버전 규칙), 부분 문자열이 아니라 연속된 조각(parts) 시퀀스로 찾아서 그만큼만
// 제거한다 - 그래야 다른 규칙 사유나 사람이 직접 적은 문구를 건드리지 않는다.
function removeReasonFromComment(comment, reasonText) {
  if (!reasonText) return comment;
  const parts = comment.split(" / ");
  const reasonParts = reasonText.split(" / ");
  for (let i = 0; i + reasonParts.length <= parts.length; i++) {
    if (reasonParts.every((rp, j) => parts[i + j] === rp)) {
      parts.splice(i, reasonParts.length);
      return parts.join(" / ");
    }
  }
  return comment; // 이미 사람이 편집해서 못 찾으면 건드리지 않고 그대로 둔다
}

function addReasonToComment(comment, reasonText) {
  if (!reasonText || comment.includes(reasonText)) return comment;
  return comment ? `${comment} / ${reasonText}` : reasonText;
}

// isRequired=true: "선택해주세요"부터 시작(안 고르면 반영 차단). isRequired=false: 기본값이
// "자동 판정 유지"라 안 건드리면 자동 계산값 그대로 나간다(applyManualInputsToRecords 참고) -
// 사람이 자동 판정에 동의하지 않을 때만 바꾸면 되는 순수 선택 사항.
// commentSync: 선택 사항 규칙에서만 쓴다 - { textarea, reasonText(그 규칙의 자동 NG 사유) }를
// 주면, 이 규칙을 NG가 아닌 값으로 바꿀 때 코멘트에서 그 사유를 빼고, 다시 NG(또는 자동판정
// 유지)로 돌리면 다시 넣는다.
// links: [{href, text}] - 판정하려면 결국 codebeamer에서 직접 봐야 하는 항목(📝 문서 이력 PR
// 기재 확인 필요, 🔍 리뷰 대상 버전 자동 확인 불가)은 위 경고 목록과 같은 링크를 사유 옆에 같이
// 보여줘서, 입력하다가 경고 목록까지 다시 올라가지 않아도 되게 한다.
function createManualFieldRow(rule, label, reason, isRequired, autoValue, commentSync = null, links = []) {
  const fieldRow = document.createElement("div");
  fieldRow.className = "manual-field-row";

  const labelEl = document.createElement("span");
  labelEl.className = "manual-field-label";
  labelEl.textContent = `${label} 규칙:`;
  fieldRow.appendChild(labelEl);

  const select = document.createElement("select");
  select.className = "manual-verdict-select";
  select.dataset.rule = rule;
  select.dataset.required = String(isRequired);
  if (isRequired) {
    select.innerHTML = `
      <option value="">선택해주세요</option>
      <option value="1">OK</option>
      <option value="2">NG</option>
      <option value="0">N/A (해당 없음)</option>
    `;
  } else {
    // 배지를 "자동 판정 유지"로 되돌렸을 때 원래 색으로 복원하기 위해 원래 계산값을 같이 들고 있는다.
    select.dataset.autoKind = autoValue === 2 ? "ng" : autoValue === 1 ? "ok" : "na";
    select.innerHTML = `
      <option value="auto">자동 판정 유지</option>
      <option value="1">OK</option>
      <option value="2">NG</option>
      <option value="0">N/A (해당 없음)</option>
    `;
  }
  fieldRow.appendChild(select);

  if (reason) {
    const reasonSpan = document.createElement("span");
    reasonSpan.className = "manual-field-reason";
    reasonSpan.textContent = `(참고: ${reason})`;
    fieldRow.appendChild(reasonSpan);
  }

  for (const { href, text } of links) {
    const link = document.createElement("a");
    link.className = "manual-field-link";
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = text;
    fieldRow.appendChild(link);
  }

  if (commentSync && commentSync.reasonText) {
    const { textarea, reasonText } = commentSync;
    select.addEventListener("change", () => {
      const effectiveIsNg = select.value === "auto" || select.value === "2";
      textarea.value = effectiveIsNg
        ? addReasonToComment(textarea.value, reasonText)
        : removeReasonFromComment(textarea.value, reasonText);
    });
  }

  return fieldRow;
}

// requiredFlags(강제) 뒤에 나머지 규칙들을 "선택 사항"으로 이어 붙인다 - 강제 항목이 하나도
// 없는 트래커도 사람이 원하면 아무 규칙이나 골라 고칠 수 있게 하기 위함(기본은 접힘 상태).
function createManualRow(record, requiredFlags) {
  const tr = document.createElement("tr");
  tr.className = "manual-row";
  tr.dataset.cilId = record.cilId;
  if (requiredFlags.length === 0) tr.classList.add("collapsed");

  tr.appendChild(document.createElement("td")); // 체크박스 칸 자리 맞추기용 빈 칸

  const content = document.createElement("td");
  content.colSpan = 3;
  content.className = "manual-content";

  const title = document.createElement("div");
  title.className = "manual-title";
  title.textContent = requiredFlags.length > 0
    ? "🙋 직접 확인 필요 - 아래 판정을 입력해야 반영할 수 있습니다"
    : "✏ 직접 판정 수정 (선택 사항 - 자동 판정에 동의하지 않으면 바꿔서 반영할 수 있습니다)";
  content.appendChild(title);

  // 아래 필드 행들이 코멘트 칸을 직접 고쳐야 해서(규칙을 NG 아닌 값으로 바꾸면 그 사유를
  // 코멘트에서 빼줌) textarea를 먼저 만들어두고 자동 코멘트로 미리 채운다 - 그대로 반영해도
  // 되고, 사람이 그 자리에서 직접 고쳐도 된다.
  const textarea = document.createElement("textarea");
  textarea.className = "manual-comment-input";
  textarea.rows = 2;
  textarea.value = record.comment || "";

  const requiredRuleKeys = new Set(requiredFlags.map((f) => f.rule));
  // 🔍 리뷰 대상 버전 자동 확인 불가 항목은 강제 입력 대상은 아니지만, 버전 규칙 줄에 그 사유와
  // 링크(대상 산출물 / 리뷰레포트)를 같이 보여준다.
  const versionFail = (warningsData.versionCheckFailures || []).find((f) => f.trackerName === record.trackerName);
  const versionFailLinks = [];
  if (versionFail?.targetPaItemId) {
    versionFailLinks.push({ href: `https://codebeamer.slworld.com/cb/issue/${versionFail.targetPaItemId}`, text: "🔗 대상 산출물에서 직접 확인" });
  }
  if (versionFail?.reviewReportPaItemId) {
    versionFailLinks.push({ href: `https://codebeamer.slworld.com/cb/issue/${versionFail.reviewReportPaItemId}`, text: "🔗 리뷰레포트 PA 항목에서 직접 확인" });
  }

  for (const flag of requiredFlags) {
    const isVersionFail = flag.rule === "versionRule" && versionFail;
    const reason = flag.reason ?? (isVersionFail ? versionFail.reason : null);
    const links = flag.links ?? (isVersionFail ? versionFailLinks : []);
    content.appendChild(createManualFieldRow(flag.rule, flag.label, reason, true, null, null, links));
  }
  for (const rule of ALL_RULE_KEYS) {
    if (requiredRuleKeys.has(rule)) continue;
    const reasonText = (record.ruleReasons || {})[rule] || "";
    const isVersionFail = rule === "versionRule" && versionFail;
    content.appendChild(createManualFieldRow(
      rule, RULE_LABELS[rule], isVersionFail ? versionFail.reason : null, false, record[rule],
      { textarea, reasonText }, isVersionFail ? versionFailLinks : []
    ));
  }

  const commentLabel = document.createElement("div");
  commentLabel.className = "manual-comment-label";
  commentLabel.textContent = "감사 코멘트 (자동 생성됨 - 필요하면 직접 수정할 수 있습니다. 위에서 NG로 판정하면 비어있으면 안 됩니다):";
  content.appendChild(commentLabel);
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
    if (record.cilId == null) {
      // Reference 계열 파일 중 CIL/RDL에 등재가 안 된 것 - 반영할 codebeamer 항목 자체가
      // 없으니 체크박스를 꺼서 반영 대상이 아님을 보여준다(pushAllResults도 별도로 막음).
      checkbox.checked = false;
      checkbox.disabled = true;
      checkbox.title = "CIL/Reference Document List에 등재되지 않아 반영 대상이 아닙니다";
    } else {
      checkbox.checked = !excludedCilIds.has(record.cilId);
    }
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

    // 강제(🙋/📝) 대상이 없어도 모든 트래커에 "선택 사항" 직접 판정 수정 창을 만들어둔다 -
    // 기본은 접혀있고, 사람이 원할 때만 아래 토글 버튼으로 펼쳐서 자동 판정을 바꿀 수 있다.
    const manualRow = createManualRow(record, manualFlags);
    itemsBody.appendChild(manualRow);
    if (manualFlags.length === 0) {
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "manual-toggle-btn";
      toggleBtn.textContent = "✏ 직접 판정 수정";
      toggleBtn.addEventListener("click", () => {
        manualRow.classList.remove("collapsed");
        toggleBtn.remove();
      });
      badgesCell.appendChild(toggleBtn);
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

const guidelineToggleBtn = document.getElementById("guidelineToggleBtn");
const guidelinePanel = document.getElementById("guidelinePanel");
const guidelineCloseBtn = document.getElementById("guidelineCloseBtn");
guidelineToggleBtn.addEventListener("click", () => guidelinePanel.classList.toggle("hidden"));
guidelineCloseBtn.addEventListener("click", () => guidelinePanel.classList.add("hidden"));

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
    // ""(필수인데 아직 선택 안 함)은 여전히 "직접확인 필요" amber로 남겨두고, "0"(사람이 N/A로
    // 명시적 판정)만 na 회색으로 바꾼다 - 안 그러면 "아직 안 고름"과 "직접 N/A로 판정함"이
    // 똑같아 보인다. "auto"(선택 사항 - 자동 판정 유지)는 원래 배지 색으로 되돌린다.
    const value = e.target.value;
    const kind = value === "2" ? "ng" : value === "1" ? "ok" : value === "0" ? "na"
      : value === "auto" ? (e.target.dataset.autoKind || "na") : "manual";
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
    newTrackers = [],
    changedTrackers = [],
    versionCheckFailures = [],
    incompleteFetchTrackers = [],
    manualStatusCheckTrackers = [],
    docHistoryManualCheckTrackers = [],
    crIdManualCheckTrackers = [],
    noTrackerManualCheckTrackers = [],
    fetchFailedTrackers = [],
    unregisteredReferenceFiles = [],
    unchangedSinceApprovalTrackers = [],
  } = data;

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
      // 위키 표 마크업은 형식이 계속 달라져서 여기서 파싱한 원본을 그대로 보여주는 건
      // 사람이 읽기 힘들다 - 그 대신 codebeamer로 바로 이동하는 링크 두 개(대상 산출물
      // 자신 / 그 버전을 기재한 리뷰레포트)를 줘서, 실제 렌더링된 화면에서 직접 보고
      // 판단할 수 있게 한다.
      const linksRow = document.createElement("div");
      linksRow.className = "version-fail-links";
      if (f.targetPaItemId) {
        const link = document.createElement("a");
        link.className = "version-fail-link";
        link.href = `https://codebeamer.slworld.com/cb/issue/${f.targetPaItemId}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "🔗 대상 산출물에서 직접 확인";
        linksRow.appendChild(link);
      }
      if (f.reviewReportPaItemId) {
        const link = document.createElement("a");
        link.className = "version-fail-link";
        link.href = `https://codebeamer.slworld.com/cb/issue/${f.reviewReportPaItemId}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "🔗 리뷰레포트 PA 항목에서 직접 확인";
        linksRow.appendChild(link);
      }
      row.appendChild(linksRow);
      return row;
    });
    versionFailWrap.classList.remove("hidden");
  }
  if (manualStatusCheckTrackers.length) {
    // 이 목록은 이름만 들고 있어서, 대상 산출물 링크용 PA 항목 ID는 감사 레코드에서 찾는다.
    renderWarnList(manualStatusCheckList, manualStatusCheckTrackers, (name) => {
      const row = simpleRow(name);
      const paItemId = auditRecords.find((r) => r.trackerName === name)?.paItemId;
      if (paItemId) {
        const link = document.createElement("a");
        link.className = "version-fail-link";
        link.href = `https://codebeamer.slworld.com/cb/issue/${paItemId}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "🔗 대상 산출물에서 직접 확인";
        const linksRow = document.createElement("div");
        linksRow.className = "version-fail-links";
        linksRow.appendChild(link);
        row.appendChild(linksRow);
      }
      return row;
    });
    manualStatusCheckWrap.classList.remove("hidden");
  }
  // 재시도로 다시 그려질 때 줄어들 수 있어서 비어있으면 다시 숨긴다.
  if (unchangedSinceApprovalTrackers.length) {
    renderWarnList(unchangedSinceApprovalList, unchangedSinceApprovalTrackers, (name) => simpleRow(name));
    unchangedSinceApprovalWrap.classList.remove("hidden");
  } else {
    unchangedSinceApprovalWrap.classList.add("hidden");
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
      if (f.paItemId) {
        const link = document.createElement("a");
        link.className = "version-fail-link";
        link.href = `https://codebeamer.slworld.com/cb/issue/${f.paItemId}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "🔗 대상 산출물에서 직접 확인";
        const linksRow = document.createElement("div");
        linksRow.className = "version-fail-links";
        linksRow.appendChild(link);
        row.appendChild(linksRow);
      }
      return row;
    });
    docHistoryManualCheckWrap.classList.remove("hidden");
  }
  if (crIdManualCheckTrackers.length) {
    renderWarnList(crIdManualCheckList, crIdManualCheckTrackers, (f) => {
      const row = document.createElement("div");
      row.className = "row";
      const name = document.createElement("div");
      name.textContent = f.trackerName;
      row.appendChild(name);
      const reason = document.createElement("div");
      reason.className = "version-fail-reason";
      reason.textContent = f.reason;
      row.appendChild(reason);
      if (f.paItemId) {
        const link = document.createElement("a");
        link.className = "version-fail-link";
        link.href = `https://codebeamer.slworld.com/cb/issue/${f.paItemId}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "🔗 대상 산출물에서 직접 확인";
        const linksRow = document.createElement("div");
        linksRow.className = "version-fail-links";
        linksRow.appendChild(link);
        row.appendChild(linksRow);
      }
      return row;
    });
    crIdManualCheckWrap.classList.remove("hidden");
  }
  if (noTrackerManualCheckTrackers.length) {
    renderWarnList(noTrackerManualCheckList, noTrackerManualCheckTrackers, (name) => simpleRow(name));
    noTrackerManualCheckWrap.classList.remove("hidden");
  }
  if (unregisteredReferenceFiles.length) {
    renderWarnList(unregisteredReferenceFilesList, unregisteredReferenceFiles, (name) => simpleRow(name));
    unregisteredReferenceFilesWrap.classList.remove("hidden");
  }
  // 이 둘은 재시도 버튼으로 다시 그려질 수 있어서(성공하면 줄어듦), 비어있으면 다시 숨긴다 -
  // 다른 목록들은 한 감사 실행 안에서 줄어들 일이 없어서 else 분기가 없다.
  if (incompleteFetchTrackers.length) {
    renderWarnList(incompleteFetchList, incompleteFetchTrackers, (name) => simpleRow(name));
    incompleteFetchWrap.classList.remove("hidden");
  } else {
    incompleteFetchWrap.classList.add("hidden");
  }
  if (fetchFailedTrackers.length) {
    renderWarnList(fetchFailedList, fetchFailedTrackers, (name) => simpleRow(name));
    fetchFailedWrap.classList.remove("hidden");
  } else {
    fetchFailedWrap.classList.add("hidden");
  }
}

function setControlsEnabled(enabled) {
  applyBtn.disabled = !enabled;
  cancelBtn.disabled = !enabled;
  selectAllBtn.disabled = !enabled;
  selectNoneBtn.disabled = !enabled;
  itemsBody.querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.disabled = !enabled));
}

// "직접확인 필요"/"직접 판정 수정" 입력창(.manual-row) 하나당 그 위 트래커 행, 고른 판정들
// (규칙별로 값+필수 여부), 코멘트를 모아 반환한다.
function collectManualRowInputs() {
  return Array.from(itemsBody.querySelectorAll("tr.manual-row")).map((manualRow) => {
    const mainRow = manualRow.previousElementSibling;
    const verdicts = {};
    manualRow.querySelectorAll(".manual-verdict-select").forEach((select) => {
      // value: 필수 항목은 ""(안 고름)|"0"(N/A)|"1"(OK)|"2"(NG), 선택 사항은 "auto"(안 건드림)도 추가.
      verdicts[select.dataset.rule] = { value: select.value, required: select.dataset.required === "true" };
    });
    const comment = manualRow.querySelector(".manual-comment-input").value.trim();
    return { cilId: Number(manualRow.dataset.cilId), mainRow, manualRow, verdicts, comment };
  });
}

// 반영 대상(체크된 것)에 한해서만 검증한다 - 체크 해제해서 이번엔 안 올릴 항목까지 억지로
// 채우게 하면 안 되므로. 선택 사항(필수 아님)은 안 건드리고 "auto"로 남겨둬도 문제 없다 -
// 필수 항목이 남아있거나, NG로 판정(필수든 선택이든)했는데 코멘트가 없을 때만 막는다.
function validateManualInputs(excludedCilIds) {
  const problems = [];
  for (const entry of collectManualRowInputs()) {
    entry.manualRow.classList.remove("problem");
    if (excludedCilIds.has(entry.cilId)) continue;

    const trackerName = entry.mainRow.querySelector(".col-name").textContent;
    const infos = Object.values(entry.verdicts);
    if (infos.some((v) => v.required && v.value === "")) {
      problems.push({ trackerName, reason: "직접확인 판정을 다 선택해주세요", row: entry.manualRow });
      continue;
    }
    if (infos.some((v) => v.value === "2") && !entry.comment) {
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

// 검증을 통과한 뒤, 사람이 고른 직접확인 판정/코멘트를 실제 record에 합쳐 넣는다. 코멘트
// textarea는 이제 "추가로 덧붙이는 글"이 아니라 자동 코멘트로 미리 채워진 걸 그대로 쓰거나
// 직접 고친 최종 코멘트라서, 그대로 덮어쓴다(createManualFieldRow의 change 리스너가 이미
// 규칙별 자동 사유를 넣고 빼는 걸 처리해뒀다).
function applyManualInputsToRecords(excludedCilIds) {
  for (const entry of collectManualRowInputs()) {
    if (excludedCilIds.has(entry.cilId)) continue;
    const record = auditRecords.find((r) => r.cilId === entry.cilId);
    if (!record) continue;

    for (const [rule, info] of Object.entries(entry.verdicts)) {
      if (info.value === "auto") continue; // 선택 사항인데 안 건드림 - 자동 판정값 그대로 둠
      record[rule] = info.value === "1" ? 1 : info.value === "2" ? 2 : null; // "0"(N/A)과 ""는 둘 다 null
    }
    record.comment = entry.comment;
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
    // 반영이 실제로 성공했을 때만 "가장 최근 반영한 감사" 기준점을 갱신한다 - 감사만 돌리고
    // 반영 안 한 경우까지 이 기준점이 움직이면, 다음 감사의 "🆕/🔄" 안내가 보고도 안 한
    // 감사 대비로 비교돼버린다.
    await updateAppliedSnapshot(projectName, auditRecords);
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

// 조회 실패했거나(fetchFailedTrackers) 불완전했던(incompleteFetchTrackers) 트래커들만
// 다시 조회해서(collectAuditData의 onlyTrackerNames로 범위를 좁힘) 결과에 반영한다 - 전체
// 재감사 없이 그 트래커들만 다시 시도. 규칙 검사(runAudit)는 합쳐진 전체 레코드로 다시
// 돌린다 - 네트워크 호출 없는 순수 로컬 계산이라 가볍고, Test Result/Report 같은 짝 트래커
// 대조가 다른 레코드까지 봐야 정확하기 때문이다.
// replaceExisting: 조회 실패는 애초에 레코드가 아예 없어서(mapWithConcurrency가 null 반환)
// 그냥 추가만 하면 되지만, 조회 불완전은 이미 (불완전한 데이터로 만들어진) 레코드가 있으므로
// 그 트래커분만 새로 받은 걸로 갈아끼워야 한다.
async function retryTrackers(namesToRetry, { replaceExisting, button, idleLabel }) {
  if (namesToRetry.length === 0) return;

  const { credentials } = await chrome.storage.session.get("credentials");
  if (!credentials) {
    statusEl.textContent = "로그인이 만료되었습니다. side panel에서 다시 로그인해주세요.";
    return;
  }
  const client = createClient({ baseUrl: BASE_URL, baseUrlV3: BASE_URL_V3, ...credentials });

  button.disabled = true;
  button.textContent = "재시도 중...";
  try {
    const previousSnapshot = await loadHistorySnapshot(projectName);
    const docHistoryCheckpoints = {};
    const docHistoryCheckpointsById = {};
    for (const [name, entry] of Object.entries(previousSnapshot)) {
      docHistoryCheckpoints[name] = entry.docHistoryCheckedVersion;
      if (entry.trackerId) docHistoryCheckpointsById[entry.trackerId] = entry.docHistoryCheckedVersion;
    }

    const { records: retriedRecords, fetchFailedTrackers: stillFailed } = await collectAuditData(client, {
      projectName, trackerCil, trackerNcl, onlyTrackerNames: namesToRetry, onProgress: handleCollectionProgress,
      docHistoryCheckpoints, docHistoryCheckpointsById, includeReferenceFiles: false,
    });

    auditRecords = replaceExisting
      ? [...auditRecords.filter((r) => !namesToRetry.includes(r.trackerName)), ...retriedRecords]
      : [...auditRecords, ...retriedRecords];

    const {
      records: auditedRecords, versionCheckFailures, incompleteFetchTrackers, manualStatusCheckTrackers,
      docHistoryManualCheckTrackers, crIdManualCheckTrackers, noTrackerManualCheckTrackers, unchangedSinceApprovalTrackers,
    } = runAudit(auditRecords, { cadence, anchor, periodicTrackers: PERIODIC_TRACKERS });
    auditRecords = auditedRecords;

    // runNewAudit과 동일한 이유로, docHistoryCheckedVersion 체크포인트 갱신(diffAndUpdateHistory)과
    // "🆕/🔄" 안내용 비교(diffAgainstAppliedSnapshot)를 분리한다.
    await diffAndUpdateHistory(projectName, retriedRecords);
    const { newTrackers, changedTrackers } = await diffAgainstAppliedSnapshot(projectName, retriedRecords);

    const excludedCilIds = getExcludedCilIds();
    warningsData = {
      ...warningsData,
      newTrackers: [...(warningsData.newTrackers || []), ...newTrackers],
      changedTrackers: [...(warningsData.changedTrackers || []), ...changedTrackers],
      versionCheckFailures, incompleteFetchTrackers, manualStatusCheckTrackers,
      docHistoryManualCheckTrackers, crIdManualCheckTrackers, noTrackerManualCheckTrackers, unchangedSinceApprovalTrackers,
      fetchFailedTrackers: stillFailed,
    };

    renderWarnings(warningsData);
    renderItemsTable(auditRecords, excludedCilIds);
    await persistReviewState(reviewStatus);

    // 재시도했던 트래커 중, 이번에도 완전히 실패했거나(stillFailed) 여전히 불완전한
    // 상태(incompleteFetchTrackers - 방금 전체 레코드 기준으로 새로 계산된 값)로 남아있는
    // 것만 "여전히 문제있음"으로 센다.
    const stillProblematic = namesToRetry.filter(
      (n) => stillFailed.includes(n) || incompleteFetchTrackers.includes(n)
    );
    statusEl.textContent = stillProblematic.length > 0
      ? `재시도 완료: ${namesToRetry.length - stillProblematic.length}건 성공, ${stillProblematic.length}건 여전히 문제가 있습니다.`
      : `재시도 완료: ${namesToRetry.length}건 모두 정상적으로 조회했습니다.`;
  } catch (e) {
    statusEl.textContent = `재시도 중 오류: ${e.message}`;
  } finally {
    button.disabled = false;
    button.textContent = idleLabel;
  }
}
retryFetchFailedBtn.addEventListener("click", () => retryTrackers(
  [...(warningsData.fetchFailedTrackers || [])],
  { replaceExisting: false, button: retryFetchFailedBtn, idleLabel: "이 트래커들만 재시도" }
));
retryIncompleteFetchBtn.addEventListener("click", () => retryTrackers(
  [...(warningsData.incompleteFetchTrackers || [])],
  { replaceExisting: true, button: retryIncompleteFetchBtn, idleLabel: "이 트래커들만 재시도" }
));

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
  const { records, projectId, fetchFailedTrackers } = await collectAuditData(client, {
    projectName, trackerCil, trackerNcl, onlyTrackerNames, onProgress: handleCollectionProgress,
    docHistoryCheckpoints, docHistoryCheckpointsById,
  });
  currentProjectId = projectId;
  await applyCmRoleGate(client, projectId, username);

  setProgress(60, "감사 규칙 검사 중...");
  const {
    records: auditedRecords, versionCheckFailures, incompleteFetchTrackers, manualStatusCheckTrackers, docHistoryManualCheckTrackers,
    crIdManualCheckTrackers, noTrackerManualCheckTrackers, unregisteredReferenceFiles, unchangedSinceApprovalTrackers,
  } = runAudit(records, {
    cadence, anchor, periodicTrackers: PERIODIC_TRACKERS,
  });
  auditRecords = auditedRecords;

  setProgress(80, "지난 감사와 비교 중...");
  // diffAndUpdateHistory는 docHistoryCheckedVersion 체크포인트 쪽 스냅샷을 갱신하는 용도로
  // 그대로 호출하되(이건 반영 여부와 무관하게 실행할 때마다 전진해야 함), 그 반환값(new/changed)은
  // 더 이상 안 쓴다 - "🆕 새로 등재"/"🔄 변경" 안내는 "가장 최근 반영한 감사" 기준으로 봐야
  // 하므로(감사만 돌리고 반영 안 하면 보고된 게 아님), 반영 성공 시에만 갱신되는 별도 스냅샷과
  // 비교한다(applyBtn 핸들러의 updateAppliedSnapshot 참고).
  await diffAndUpdateHistory(projectName, auditedRecords);
  const { newTrackers, changedTrackers } = await diffAgainstAppliedSnapshot(projectName, auditedRecords);

  warningsData = {
    newTrackers, changedTrackers, versionCheckFailures, incompleteFetchTrackers,
    manualStatusCheckTrackers, docHistoryManualCheckTrackers, crIdManualCheckTrackers, noTrackerManualCheckTrackers, fetchFailedTrackers,
    unregisteredReferenceFiles, unchangedSinceApprovalTrackers,
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
