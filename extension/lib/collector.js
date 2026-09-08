// Python B_Audit_Data_Creation.py의 Audit_Data_Creation()을 그대로 옮긴 것 (Phase 1/PA추출은
// 원본에서도 호출부가 주석 처리되어 실제로 안 쓰이고 있어서 포팅하지 않았고, df_items도
// 이후 어디서도 안 쓰여서 뺐다). Excel 저장 대신 record 배열을 그대로 반환한다.

import { mapWithConcurrency } from "./codebeamerClient.js";
import { parseBaselineData, buildLatestBaselines } from "./baselines.js";
import { extractTargetVersionFromComment, isDateBasedTracker, stripTrailingQualifier, toYYMMDD } from "./wikiTable.js";

const TRAILING_QUALIFIER_RE = /(\s*\([^)]*\))+$/; // 이름 끝의 "(MCU)", "(AP)" 같은 한정자

const BRACKET_TAG_RE = /\[.*\]/;
const BRACKET_TAG_STRIP_RE = /\[.*?\]/g;

function stripBracketTag(name) {
  return (name || "").replace(BRACKET_TAG_STRIP_RE, "").trim();
}

// ── CIL 파싱 ────────────────────────────────────────────────────────────────
function parseCilData(items) {
  return items.map((item) => {
    const workItem = item.workItem;
    let trackerConnected = "X";
    let trackerUri = "";
    if (workItem) {
      trackerConnected = "O";
      trackerUri = (workItem.tracker || {}).uri || "";
    }
    const prItems = item.pRWorkItem || [];
    return {
      cilId: item.id,
      cilUri: item.uri,
      trackerName: item.name,
      trackerConnected,
      trackerUri,
      prIdList: prItems.map((p) => p.name),
      status: (item.status || {}).name,
    };
  });
}

// ── CIL/트래커/카테고리 아우터 조인 ──────────────────────────────────────────
/**
 * CIL 목록과 프로젝트의 트래커/카테고리 목록을 이름으로 아우터 조인한다.
 * - CIL엔 있는데 트래커/카테고리 쪽에 없으면: 그대로(트래커 URI는 CIL의 workItem에서 옴)
 * - 트래커/카테고리엔 있는데 CIL에 없으면: "미등재"로 분리 (감사 대상에서 빠짐)
 * - 둘 다 있으면: 병합, TRACKER_uri가 비어있으면 트래커/카테고리 쪽 uri로 채움
 */
function mergeCilWithTrackers(cilRows, trackers, categories) {
  const tagged = [];
  for (const item of [...trackers, ...categories]) {
    if (BRACKET_TAG_RE.test(item.name || "")) {
      tagged.push({ name: stripBracketTag(item.name), uri: item.uri });
    }
  }

  const mergedByName = new Map();
  for (const cilRow of cilRows) {
    mergedByName.set(cilRow.trackerName, { ...cilRow });
  }
  for (const { name, uri } of tagged) {
    if (mergedByName.has(name)) {
      const row = mergedByName.get(name);
      if (!row.trackerUri) row.trackerUri = uri;
    } else {
      mergedByName.set(name, {
        cilId: null, cilUri: null, trackerName: name, trackerConnected: "X",
        trackerUri: uri, prIdList: [], status: null,
      });
    }
  }

  const all = [...mergedByName.values()];
  const registeredRaw = all.filter((r) => r.cilId != null);
  const unregisteredRaw = all.filter((r) => r.cilId == null);

  const dedupeByUri = (rows) => {
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      if (r.trackerUri && seen.has(r.trackerUri)) continue;
      if (r.trackerUri) seen.add(r.trackerUri);
      out.push(r);
    }
    return out;
  };

  const registered = dedupeByUri(registeredRaw);
  const unregistered = dedupeByUri(unregisteredRaw).map((r) => ({
    trackerName: r.trackerName,
    trackerUri: r.trackerUri,
  }));

  return { registered, unregistered };
}

// ── Review Report 연결 ───────────────────────────────────────────────────────
/**
 * "...Result"/"...Report" 등 트래커명 + " Review Report" 형태의 트래커들을 매칭 키로 삼아
 * Review Report URI 맵을 만든다. "...Result"로 끝나는 이름은 "...Report"로 바꾼 이름도 같은
 * Review Report에 연결한다 (하나의 Review Report가 Result 본체 + 짝 문서를 같이 다루는 경우
 * 대응 - 실제 이름이 있으면 그쪽이 항상 우선한다).
 */
function buildReviewReportJoinMap(mergedRows) {
  const reviewRows = mergedRows
    .filter((r) => (r.trackerName || "").includes(" Review Report"))
    .map((r) => ({ joinKey: r.trackerName.replaceAll(" Review Report", ""), uri: r.trackerUri }));

  const map = new Map();
  for (const { joinKey, uri } of reviewRows) {
    if (!map.has(joinKey)) map.set(joinKey, uri);
  }
  for (const { joinKey, uri } of reviewRows) {
    // "...Test Result Review Report (MCU)"처럼 괄호 한정자가 Review Report 뒤(전체 이름 맨 끝)에
    // 붙는 경우, " Review Report"만 떼면 joinKey가 "...Test Result (MCU)"가 되어 "Result"로
    // 안 끝난다. 한정자를 떼고 "Result"로 끝나는지 확인한 뒤, Result->Report로 바꾸고
    // 한정자를 다시 붙인다 (한정자를 계속 유지해야 MCU/AP 등 변형이 여러 개일 때 엉뚱한 것과
    // 안 섞인다 - C_Audit.py의 같은 종류 매칭과 동일한 방식).
    const qualifierMatch = TRAILING_QUALIFIER_RE.exec(joinKey);
    const qualifierSuffix = qualifierMatch ? qualifierMatch[0] : "";
    const baseWithoutQualifier = stripTrailingQualifier(joinKey);
    if (baseWithoutQualifier.endsWith("Result")) {
      const companionKey = baseWithoutQualifier.replace(/Result$/, "Report") + qualifierSuffix;
      if (!map.has(companionKey)) map.set(companionKey, uri);
    }
  }
  return map;
}

// ── NCL(PR) 매칭 ─────────────────────────────────────────────────────────────
async function fetchNclRelations(client, item) {
  const itemName = item.name;
  const itemStatus = (item.status || {}).name || "";
  const results = [];
  const resp = await client.getJsonSoft(`${client.baseUrlV3}/items/${item.id}/relations`);
  if (resp.ok && resp.json) {
    const incoming = resp.json.incomingAssociations || [];
    if (incoming.length === 0) {
      results.push({ pr: itemName, cilId: null, status: itemStatus });
    } else {
      for (const assoc of incoming) {
        const revisionId = (assoc.itemRevision || {}).id;
        if (revisionId) results.push({ pr: itemName, cilId: revisionId, status: itemStatus });
      }
    }
  }
  return results;
}

function buildNclPrMap(allRelations) {
  const prNumRe = /(\d+)/;
  const byCilId = new Map();
  for (const r of allRelations) {
    if (r.status === "Closed" || r.cilId == null) continue;
    const m = prNumRe.exec(String(r.pr));
    const prNum = m ? m[1] : "";
    if (!byCilId.has(r.cilId)) byCilId.set(r.cilId, []);
    byCilId.get(r.cilId).push(prNum);
  }
  const result = new Map();
  for (const [cilId, nums] of byCilId) result.set(cilId, nums.join(", "));
  return result;
}

// ── 이벤트성 워크플로우 판별 (캐시) ──────────────────────────────────────────
function makeEventBasedChecker(client) {
  const cache = new Map();
  return async function isEventbasedWorkflow(trackerUri) {
    if (cache.has(trackerUri)) return cache.get(trackerUri);
    const trackerId = trackerUri.replace(/\/$/, "").split("/").pop();
    let result = false;
    try {
      const schema = await client.getJson(`${client.baseUrl}/tracker/${trackerId}/schema`);
      const statuses = ((schema.properties || {}).status || {}).enum || [];
      result = statuses.some((s) => s.name === "Create Date");
    } catch (e) {
      result = false;
    }
    cache.set(trackerUri, result);
    return result;
  };
}

// ── 트래커 한 행(row) 처리 (process_row_parallel 상당) ───────────────────────
async function processTrackerRow(client, mergedRow, ctx) {
  const uri = mergedRow.trackerUri;
  if (!uri) return null; // 이름 매칭으로도 트래커를 못 찾은 경우에만 패스

  const rrUri = ctx.reviewReportUriMap.get(mergedRow.trackerName) || null;

  const tracker = await client.getJson(`https://codebeamer.slworld.com/cb/rest${uri}`);
  const trackerItemResult = await client.fetchAllItems(`https://codebeamer.slworld.com/cb/rest${uri}/items`);
  const itemFetchIncomplete = trackerItemResult.incomplete;
  const tName = tracker.name || "";

  let rrData = { num: "해당없음", time: "해당없음", status: "해당없음", isUpload: "해당없음", targetVersion: "", versionCheckFailReason: "" };
  if (rrUri) {
    const rrResp = await client.fetchAllItems(`https://codebeamer.slworld.com/cb/rest${rrUri}/items`);
    const rrItems = rrResp.items;
    if (rrItems.length > 0) {
      const paItem = rrItems.find((it) => ((it.type || {}).name) === "Primary Attribute") || null;
      const rrStatus = paItem ? (paItem.status || {}).name || "" : "";

      let targetVersion = "";
      let versionCheckFailReason = "리뷰레포트 PA 아이템 없음";
      if (paItem) {
        const commentsResp = await client.getJsonSoft(`https://codebeamer.slworld.com/cb/rest/v3/items/${paItem.id}/comments`);
        if (commentsResp.ok) {
          const comments = commentsResp.json || [];
          const combinedText = comments
            .filter((c) => c && typeof c === "object")
            .map((c) => c.comment || "")
            .join(" ");
          const extracted = extractTargetVersionFromComment(combinedText, tName);
          targetVersion = extracted.value || "";
          versionCheckFailReason = extracted.failReason || "";
        } else {
          versionCheckFailReason = "리뷰 코멘트 조회 실패";
        }
      }

      // Review Report 트래커도 OK/NG/Review Closed 같은 리뷰 상태 enum 없이 Released/Read Only +
      // Create Date 워크플로우를 쓰는 경우가 있다. 그런 경우엔 OK/NG로는 절대 안 잡히니
      // Released/Read Only에 도달했으면 업로드된 것으로 본다.
      const isReviewStatusUpload = ["OK", "NG", "Review Closed"].includes(rrStatus);
      const isReleasedUpload = ["Released", "Read Only"].includes(rrStatus) && (await ctx.isEventbasedWorkflow(rrUri));

      rrData = {
        num: rrItems.length,
        time: rrItems[0].submittedAt || "",
        status: rrStatus,
        isUpload: isReviewStatusUpload || isReleasedUpload,
        targetVersion,
        versionCheckFailReason,
      };
    } else {
      rrData = { num: 0, time: "", status: "", isUpload: false, targetVersion: "", versionCheckFailReason: "" };
    }
  }

  const items = trackerItemResult.items;
  let paItemObj = items.find((it) => ((it.type || {}).name) === "Primary Attribute") || null;
  if (!paItemObj) {
    // Test Result/Review Result처럼 'Primary Attribute' 타입이 아예 없는 트래커는, 부모가 없는
    // (codebeamer 화면상 Parent가 "--") 최상위 워크아이템들이 그 트래커의 대표 후보다. 이런
    // 트래커는 실행(회차)마다 별도의 최상위 아이템이 쌓일 수 있어서, 그중 가장 최근 회차
    // (= id가 가장 큰 것, codebeamer 아이템 id는 생성 순으로 증가함)를 현재 상태로 본다.
    const parentlessItems = items.filter((it) => !it.parent);
    paItemObj = parentlessItems.reduce(
      (max, it) => ((it.id || 0) > (max ? max.id || 0 : -Infinity) ? it : max),
      null
    );
  }
  const paId = paItemObj ? paItemObj.id : null;

  let paHistory = null;
  if (paId) {
    paHistory = await client.getJson(`https://codebeamer.slworld.com/cb/rest/item/${paId}/history`);
  }

  const tType = (tracker.type || {}).name || "";
  const base = ctx.latestBaselines.get(tName) || {};

  // 히스토리에서 상태 변경 기록을 못 찾는 트래커가 있어서, 히스토리를 추론하는 대신 PA
  // 아이템 자체의 현재 status 필드를 그대로 쓴다 (리뷰레포트 상태와 동일한 방식)
  const currentStatus = paItemObj ? (paItemObj.status || {}).name : null;

  const isDateBased = isDateBasedTracker(mergedRow.trackerName);
  const dateBasedClosedDate = isDateBased && paItemObj ? toYYMMDD(paItemObj.closedAt) : "";

  const hInfo = { first: "", last: "", status: currentStatus || "Open", waiting: null, createDateCurrent: false };
  if (Array.isArray(paHistory) && paHistory.length > 0) {
    hInfo.first = paHistory[0].submittedAt || "";
    hInfo.last = paHistory[paHistory.length - 1].submittedAt || "";
    if (rrData.num !== "해당없음") {
      if (["Open", "In Review"].includes(hInfo.status)) hInfo.waiting = true;
      else if (["Waiting for Approval", "Approved"].includes(hInfo.status)) hInfo.waiting = false;
      else hInfo.waiting = null;
    }
    // Create Date는 누르는 즉시 이전 상태로 자동 복귀("back")하므로, 가장 최근 히스토리
    // 항목이 "back" 전이였는지로 "마지막으로 한 일이 Create Date였는지"를 판정한다.
    const lastTransition = paHistory[paHistory.length - 1].transition || {};
    hInfo.createDateCurrent = lastTransition.name === "back";
  }

  return {
    cilId: mergedRow.cilId,
    trackerName: tName,
    trackerType: tType,
    itemCount: items.length,
    fileName: tType === "Document" && items.length > 0 ? items[0].fileName || "" : "",
    firstEdit: hInfo.first,
    lastEdit: hInfo.last,
    status: hInfo.status,
    currentVersion: base.version || "미업로드",
    prId: ctx.prMap.get(mergedRow.cilId) || "",
    versioning: base.createdAt || "",
    verDesc: base.description || "",
    reviewReportItemCount: rrData.num,
    reviewReportStatus: rrData.status,
    reviewReportUploaded: rrData.isUpload,
    waitingBeforeApproval: hInfo.waiting,
    reviewReportLastUpload: rrData.time,
    owner: base.owner || "",
    createDateCurrent: hInfo.createDateCurrent,
    targetVersion: rrData.targetVersion,
    versionCheckFailReason: rrData.versionCheckFailReason,
    isEventBased: await ctx.isEventbasedWorkflow(uri),
    testResultClosedDate: dateBasedClosedDate,
    itemFetchIncomplete,
  };
}

/**
 * 감사 대상 데이터 전체를 codebeamer에서 수집한다.
 * @returns {{records: Array, unregisteredTrackers: Array<{trackerName, trackerUri}>}}
 */
export async function collectAuditData(client, { projectName, trackerCil, trackerNcl }) {
  const projectsResp = await client.getJson(`${client.baseUrl}/projects/page/1`);
  const project = (projectsResp.projects || []).find((p) => (p.name || "").includes(projectName));
  if (!project) throw new Error(`프로젝트를 찾을 수 없습니다: ${projectName}`);
  const userUri = `${client.baseUrl}${project.uri}`;

  const allTrackers = await client.getJson(`${userUri}/trackers`);
  const allCategories = await client.getJson(`${userUri}/categories`);

  // CIL 트래커 조회
  const cilTracker = allTrackers.find((t) => t.name === trackerCil);
  if (!cilTracker) throw new Error(`CIL 트래커를 찾을 수 없습니다: ${trackerCil}`);
  const cilItemsResult = await client.fetchAllItems(`${client.baseUrl}${cilTracker.uri}/items`);
  const cilRows = parseCilData(cilItemsResult.items);

  const { registered, unregistered } = mergeCilWithTrackers(cilRows, allTrackers, allCategories);
  const reviewReportUriMap = buildReviewReportJoinMap(registered);

  // 베이스라인
  const projectId = userUri.split("/").pop();
  const baselinesResp = await client.getJson(`https://codebeamer.slworld.com/cb/rest/projects/${projectId}/baselines`);
  const baselineRows = parseBaselineData(baselinesResp);
  const latestBaselines = buildLatestBaselines(baselineRows);

  // NCL(PR 매칭)
  const nclTracker = allTrackers.find((t) => t.name === trackerNcl);
  let prMap = new Map();
  if (nclTracker) {
    const nclItemsResult = await client.fetchAllItems(`${client.baseUrl}${nclTracker.uri}/items`);
    const allRelations = await mapWithConcurrency(nclItemsResult.items, 20, (item) => fetchNclRelations(client, item));
    prMap = buildNclPrMap(allRelations.flat());
  }

  const isEventbasedWorkflow = makeEventBasedChecker(client);
  const ctx = { reviewReportUriMap, latestBaselines, prMap, isEventbasedWorkflow };

  const results = await mapWithConcurrency(registered, 15, (row) => processTrackerRow(client, row, ctx));
  const records = results.filter((r) => r !== null);

  return { records, unregisteredTrackers: unregistered };
}
