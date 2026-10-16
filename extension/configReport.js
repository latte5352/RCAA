// audit.html 검토 화면과 별도의 독립된 팝업 창(popup.js의 openAuditWindow와 같은 방식으로 뜸).
// 포스트잇처럼 audit.html 안에 끼워넣었더니 칸이 너무 좁아서, 아예 분리된 창으로 뺐다.
// 데이터는 audit.js가 그때그때 계산해둔 걸 실시간으로 받는 게 아니라, review_state_<project>
// (lib/reviewState.js)에 저장된 걸 읽는다 - 그래야 "직전 감사 결과 보기"로 다시 연 화면에서도
// 똑같이 동작하고(그때 저장된 결과를 그대로 보여줌), 새로 감사를 돌린 직후에도(audit.js가 이
// 창을 열기 직전에 현재 상태를 한 번 저장해준다) 일관되게 동작한다.

import { loadReviewState } from "./lib/reviewState.js";
import {
  diffAgainstAppliedSnapshot, updateAppliedSnapshot, loadPeriodicNgSnapshot, updatePeriodicNgSnapshot,
} from "./lib/history.js";
import { buildStatusChangeGroups, buildPeriodicNgReport, buildReportTitle, buildReportBody, buildNgTableText } from "./lib/configReport.js";
import { submitConfigReportToAlmHub } from "./lib/almHubClient.js";

const params = new URLSearchParams(location.search);
const projectName = params.get("project");

const subtitleEl = document.getElementById("subtitle");
const dateInput = document.getElementById("dateInput");
const refreshBtn = document.getElementById("refreshBtn");
const saveBaselineBtn = document.getElementById("saveBaselineBtn");
const pendingWrap = document.getElementById("pendingWrap");
const pendingList = document.getElementById("pendingList");
const titleBox = document.getElementById("titleBox");
const copyTitleBtn = document.getElementById("copyTitleBtn");
const preview = document.getElementById("preview");
const bodyBox = document.getElementById("bodyBox");
const copyBodyBtn = document.getElementById("copyBodyBtn");
const copyTableBtn = document.getElementById("copyTableBtn");
const almHubSubmitBtn = document.getElementById("almHubSubmitBtn");
const almHubStatus = document.getElementById("almHubStatus");
const bitbucketZone = document.getElementById("bitbucketZone");
const bitbucketHint = document.getElementById("bitbucketHint");
const bitbucketInput = document.getElementById("bitbucketInput");
const bitbucketPreview = document.getElementById("bitbucketPreview");
const bitbucketClearBtn = document.getElementById("bitbucketClearBtn");

let auditRecords = [];
let warningsData = {};
let excludedCilIds = new Set();
let lastNgReport = null;

// audit.js의 getManualCheckFlags를 그대로 옮긴 것 - DOM(manual-row 입력창)에 의존하지 않고
// warningsData + record만 보고 판단하는 순수 로직이라 그대로 재사용 가능하다. 저장된
// review_state의 records는 이미(열기 직전에) 화면에서 고른 직접판정 값까지 반영된 최종본이라,
// 여기서 record[rule]이 null이면 "그 판정이 아직도 안 끝났다"는 뜻 그대로다.
const RULE_LABELS = { saveRule: "저장", versionRule: "버전", docHistoryRule: "이력", statusRule: "상태" };
const ALL_RULE_KEYS = ["saveRule", "versionRule", "docHistoryRule", "statusRule"];

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
    flags.push({ rule: "docHistoryRule", label: "이력", reason: docHistEntry.reason });
  }
  const crIdEntry = (warningsData.crIdManualCheckTrackers || []).find((t) => t.trackerName === record.trackerName);
  if (crIdEntry) {
    flags.push({ rule: "docHistoryRule", label: "이력", reason: crIdEntry.reason });
  }
  if ((warningsData.noTrackerManualCheckTrackers || []).includes(record.trackerName)) {
    const reason = "실제 산출물이 codebeamer 밖(Bitbucket 등)에 있어 자동 판정이 불가능함";
    flags.push({ rule: "saveRule", label: "저장", reason });
    flags.push({ rule: "versionRule", label: "버전", reason });
    flags.push({ rule: "docHistoryRule", label: "이력", reason });
  }
  if ((warningsData.fetchFailedTrackers || []).includes(record.trackerName)) {
    const reason = "네트워크 오류로 조회하지 못해 자동 판정 불가능 - 직접 확인 후 판정 필요";
    for (const rule of ALL_RULE_KEYS) flags.push({ rule, label: RULE_LABELS[rule], reason });
  }
  if ((warningsData.incompleteFetchTrackers || []).includes(record.trackerName)) {
    const reason = "데이터 조회가 불완전해 자동 판정을 신뢰할 수 없음 - 직접 확인 후 판정 필요";
    for (const rule of ALL_RULE_KEYS) flags.push({ rule, label: RULE_LABELS[rule], reason });
  }
  const seenRules = new Set();
  return flags.filter((f) => (seenRules.has(f.rule) ? false : (seenRules.add(f.rule), true)));
}

function simpleRow(text) {
  const row = document.createElement("div");
  row.className = "row";
  row.textContent = text;
  return row;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

// NG 표만 떼어서(제목/상태변경 섹션 없이) HTML로 그린다 - "표만 복사" 버튼과 buildReportHtml
// (전체 내용) 둘 다 이걸 재사용한다.
function buildNgTableHtml(ngReport, { stickyHeader = false } = {}) {
  if (ngReport.ngItems.length === 0) {
    return `<div style="margin:2px 0;">(NG 항목 없음)</div>`;
  }
  const thStyle = `border:1px solid #999;padding:5px 7px;background:#eef1f5;font-weight:700;text-align:left;${stickyHeader ? "position:sticky;top:0;" : ""}`;
  const tdStyle = "border:1px solid #999;padding:5px 7px;text-align:left;vertical-align:top;";
  const th = (text) => `<th style="${thStyle}">${escapeHtml(text)}</th>`;
  const td = (text) => `<td style="${tdStyle}">${escapeHtml(text)}</td>`;

  const parts = ['<table style="border-collapse:collapse;margin-top:8px;font-size:12px;width:100%;">'];
  parts.push(`<thead><tr>${th("Item List")}${th("Process")}${th("WorkItem Status")}${th("PR WorkItem")}${th("Audit Comment")}</tr></thead>`);
  parts.push("<tbody>");
  for (const item of ngReport.ngItems) {
    const cells = [item.trackerName, item.processTag || "-", item.status || "-", item.prWorkItems.join(", ") || "-", item.comment || ""];
    parts.push(`<tr>${cells.map(td).join("")}</tr>`);
  }
  parts.push("</tbody></table>");
  return parts.join("\n");
}

// configReportBodyBox(탭 구분 텍스트)와 같은 내용을, 서식(굵은 제목/구분선/표 테두리)이 살아있는
// HTML로도 만든다. "내용 복사"가 클립보드에 text/html로도 같이 실어서 노션/워드/컨플루언스처럼
// 서식 있는 곳에 붙이면 표/굵은 글씨가 그대로 살아나게 한다 - class가 아니라 전부 인라인
// 스타일로 쓴다(복사되면 스타일시트는 안 따라가므로).
function buildReportHtml(statusReport, ngReport) {
  const h1 = "font-weight:700;color:#00695c;margin:14px 0 4px;";
  const h2 = "font-weight:700;color:#333;margin:10px 0 2px;";
  const groupTitle = "font-weight:700;color:#444;margin-top:8px;";
  const itemLine = "padding-left:16px;color:#555;";
  const line = "margin:2px 0;";

  const parts = [`<div style="${h1}margin-top:0;">1.형상 상태 보고</div>`];
  parts.push(`<div style="${line}">[형상 상태 변경 현황]</div>`);
  parts.push(`<div style="${line}">전체 상태 변경: ${statusReport.totalCount}건</div>`);

  const renderGroups = (groups, title) => {
    const total = groups.reduce((sum, g) => sum + g.items.length, 0);
    parts.push(`<div style="${h2}">${title}: ${total}건</div>`);
    for (const g of groups) {
      const label = g.from === "N/A" ? `Status N/A → ${escapeHtml(g.to)}` : `${escapeHtml(g.from)} → ${escapeHtml(g.to)}`;
      parts.push(`<div style="${groupTitle}">${label}: ${g.items.length}건</div>`);
      for (const item of g.items) {
        parts.push(`<div style="${itemLine}">${escapeHtml(item.trackerName)} - ${escapeHtml(item.processTag || "-")}</div>`);
      }
    }
  };
  renderGroups(statusReport.forwardGroups, "진행·승인 방향 변경");
  renderGroups(statusReport.reopenGroups, "재검토·재오픈 방향 변경");

  parts.push(`<div style="${h1}">2.주기적 형상 감사</div>`);
  parts.push(`<div style="${line}">신규 NG: ${ngReport.newNgCount}건</div>`);
  parts.push(`<div style="${line}">해결·삭제 NG: ${ngReport.resolvedNgCount}건</div>`);
  parts.push(`<div style="${line}">지속 NG: ${ngReport.persistentNgCount}건</div>`);
  parts.push(`<div style="${line}">현재 총 NG: ${ngReport.totalNgCount}건</div>`);
  parts.push(`<div style="${line}">관련 산출물 및 NG 사항은 다음과 같습니다.</div>`);
  parts.push(buildNgTableHtml(ngReport, { stickyHeader: true }));

  return parts.join("\n");
}

function todayDateInputValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function flashCopyButton(btn, originalText) {
  btn.textContent = "복사됨!";
  setTimeout(() => { btn.textContent = originalText; }, 1200);
}

async function writeRichClipboard(plainText, htmlText) {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([plainText], { type: "text/plain" }),
        "text/html": new Blob([htmlText], { type: "text/html" }),
      }),
    ]);
  } catch (e) {
    await navigator.clipboard.writeText(plainText);
  }
}

async function renderReport() {
  const reportDate = dateInput.value ? new Date(`${dateInput.value}T00:00:00`) : new Date();

  // newTrackers/changedTrackers는 매번 다시 비교한다 - "비교 기준으로 저장" 버튼으로 기준점이
  // 바뀔 수 있어서, 한 번 계산해두고 캐시하면 저장 직후에도 옛날 값을 보여주게 된다.
  const { newTrackers, changedTrackers } = await diffAgainstAppliedSnapshot(projectName, auditRecords);
  const statusReport = buildStatusChangeGroups(auditRecords, newTrackers, changedTrackers);
  const previousNgNames = await loadPeriodicNgSnapshot(projectName);
  const ngReport = buildPeriodicNgReport(auditRecords, excludedCilIds, previousNgNames, getManualCheckFlags);

  lastNgReport = ngReport;
  titleBox.value = buildReportTitle(reportDate);
  bodyBox.value = buildReportBody(reportDate, statusReport, ngReport);
  preview.innerHTML = buildReportHtml(statusReport, ngReport);

  pendingWrap.classList.toggle("hidden", ngReport.pendingItems.length === 0);
  pendingList.innerHTML = "";
  for (const item of ngReport.pendingItems) {
    pendingList.appendChild(simpleRow(`${item.trackerName} (${item.processTag || "-"}) - ${item.reasons.join(", ")}`));
  }
}

async function init() {
  if (!projectName) {
    subtitleEl.textContent = "프로젝트 정보가 없습니다 - audit.html에서 다시 열어주세요.";
    return;
  }
  const state = await loadReviewState(projectName);
  if (!state) {
    subtitleEl.textContent = `${projectName} - 저장된 감사 결과가 없습니다. 먼저 감사를 실행해주세요.`;
    return;
  }
  auditRecords = state.records || [];
  warningsData = state.warnings || {};
  excludedCilIds = new Set(state.excludedCilIds || []);

  const when = state.savedAt ? new Date(state.savedAt).toLocaleString("ko-KR") : "알 수 없음";
  subtitleEl.textContent = `${projectName} · 감사 결과 저장 시각: ${when}`;

  dateInput.value = todayDateInputValue();
  await renderReport();
}

refreshBtn.addEventListener("click", renderReport);
dateInput.addEventListener("change", renderReport);

// 테스트 중엔 codebeamer에 반영하지 않고도 "직전엔 어땠는지" 기준점을 직접 저장해보고 싶을 수
// 있어서, 반영과 완전히 분리된 별도 버튼으로 지금 보고 있는 결과를 그대로 비교
// 기준점(applied_snapshot/periodic_ng_snapshot)에 저장한다 - codebeamer는 전혀 건드리지 않는다.
saveBaselineBtn.addEventListener("click", async () => {
  await updateAppliedSnapshot(projectName, auditRecords);
  const { currentNgNames } = buildPeriodicNgReport(auditRecords, excludedCilIds, new Set(), getManualCheckFlags);
  await updatePeriodicNgSnapshot(projectName, currentNgNames);
  await renderReport();
  flashCopyButton(saveBaselineBtn, "현재 상태를 비교 기준으로 저장 (테스트용 - codebeamer엔 반영 안 됨)");
});

copyTitleBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(titleBox.value);
  flashCopyButton(copyTitleBtn, "제목 복사");
});

// "내용 복사"와 "ALM Hub에 올리기"가 같이 쓴다 - Bitbucket 스크린샷을 붙여뒀으면 보고서
// 본문 HTML 끝에 그대로 이어붙인다.
function buildContentHtmlWithScreenshot() {
  let html = preview.innerHTML;
  if (!bitbucketPreview.classList.contains("hidden") && bitbucketPreview.src) {
    html += [
      '<div style="margin-top:14px;">',
      '<div style="font-weight:700;color:#00695c;margin-bottom:6px;">Bitbucket 감사 결과 스크린샷</div>',
      `<img src="${bitbucketPreview.src}" style="max-width:100%;border:1px solid #ccc;border-radius:4px;">`,
      "</div>",
    ].join("");
  }
  return html;
}

copyBodyBtn.addEventListener("click", async () => {
  await writeRichClipboard(bodyBox.value, buildContentHtmlWithScreenshot());
  flashCopyButton(copyBodyBtn, "내용 복사");
});

copyTableBtn.addEventListener("click", async () => {
  if (!lastNgReport) return;
  await writeRichClipboard(buildNgTableText(lastNgReport), buildNgTableHtml(lastNgReport));
  flashCopyButton(copyTableBtn, "NG 표만 복사");
});

function showAlmHubStatus(text, isError) {
  almHubStatus.textContent = text;
  almHubStatus.classList.remove("hidden", "ok", "err");
  almHubStatus.classList.add(isError ? "err" : "ok");
}

// ALM Hub(SUP.8 탭 수기 입력 칸)에 자동으로 올린다 - codebeamer와 같은 계정이라고 하셔서
// side panel 로그인 때 저장해둔 codebeamer 자격증명을 그대로 재사용한다(따로 입력 안 받음).
// 쓰기 직전 조회한 버전 번호가 그 사이 바뀌어 충돌날 수 있어 lib/almHubClient.js가 내부적으로
// 한 번 재시도하는데, 그래도 실패하면 자동화를 포기하고 직접 복사해서 올리시라고 안내한다
// (이 페이지의 "제목 복사"/"내용 복사" 버튼으로 바로 가능하므로 별도 창 없이 안내만 한다).
almHubSubmitBtn.addEventListener("click", async () => {
  const { credentials } = await chrome.storage.session.get("credentials");
  if (!credentials) {
    showAlmHubStatus("codebeamer 로그인 정보가 없습니다. side panel에서 다시 로그인해주세요.", true);
    return;
  }

  almHubSubmitBtn.disabled = true;
  showAlmHubStatus("ALM Hub에 올리는 중...", false);
  try {
    await submitConfigReportToAlmHub({
      username: credentials.username,
      password: credentials.password,
      projectName,
      title: titleBox.value,
      contentHtml: buildContentHtmlWithScreenshot(),
    });
    showAlmHubStatus("✓ ALM Hub SUP.8 탭 수기 입력 칸에 등록 완료했습니다.", false);
  } catch (e) {
    showAlmHubStatus(
      `ALM Hub 자동 등록 실패(재시도 포함): ${e.message} — 위 "제목 복사"/"내용 복사" 버튼으로 직접 올려주세요.`,
      true
    );
  } finally {
    almHubSubmitBtn.disabled = false;
  }
});

// Bitbucket 감사 결과 스크린샷 - 저장은 안 하고(용량 문제도 있고, 매 감사마다 새로 찍는
// 스크린샷이라 다음에 볼 이유가 없음) 이 창이 떠있는 동안만 메모리에 들고 있는다.
function attachBitbucketScreenshot(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    bitbucketPreview.src = reader.result;
    bitbucketPreview.classList.remove("hidden");
    bitbucketClearBtn.classList.remove("hidden");
    bitbucketHint.classList.add("hidden");
  };
  reader.readAsDataURL(file);
}

bitbucketZone.addEventListener("click", () => bitbucketInput.click());
bitbucketInput.addEventListener("change", () => attachBitbucketScreenshot(bitbucketInput.files[0]));
bitbucketClearBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  bitbucketInput.value = "";
  bitbucketPreview.src = "";
  bitbucketPreview.classList.add("hidden");
  bitbucketClearBtn.classList.add("hidden");
  bitbucketHint.classList.remove("hidden");
});
document.addEventListener("paste", (e) => {
  const imageItem = Array.from(e.clipboardData?.items || []).find((item) => item.type.startsWith("image/"));
  if (!imageItem) return;
  e.preventDefault();
  attachBitbucketScreenshot(imageItem.getAsFile());
});

init();
