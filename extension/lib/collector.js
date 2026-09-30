// Python B_Audit_Data_Creation.py의 Audit_Data_Creation()을 그대로 옮긴 것 (Phase 1/PA추출은
// 원본에서도 호출부가 주석 처리되어 실제로 안 쓰이고 있어서 포팅하지 않았고, df_items도
// 이후 어디서도 안 쓰여서 뺐다). Excel 저장 대신 record 배열을 그대로 반환한다.

import { mapWithConcurrency } from "./codebeamerClient.js";
import { parseBaselineData, buildLatestBaselines, buildAllBaselinesByTracker } from "./baselines.js";
import { extractTargetVersionFromComment, isDateBasedTracker, stripTrailingQualifier, normalizeNameForRowMatch, extractProcessTag, matchConfiguredSuffix, toYYMMDD } from "./wikiTable.js";
import { TRACKERS_EXEMPT_FROM_ITEM_LIST, ITEM_LIST_ENTRIES_WITHOUT_TRACKER, ITEM_LIST_ENTRIES_EXCLUDED_FROM_AUDIT, STATUS_NAME_ALIASES, REVIEW_REPORT_ADDITIONAL_TARGETS, TRACKER_NAME_REFERENCE_DOC_LIST } from "./config.js";

// codebeamer에서 읽어온 상태명이 표준 영어명이 아닌 다른 이름(예: 한글 "승인됨")이면
// 규칙 엔진이 인식하는 영어명으로 바꾼다 (STATUS_NAME_ALIASES 참고).
function normalizeStatusName(name) {
  if (!name) return name;
  return STATUS_NAME_ALIASES[name] || name;
}

const TRAILING_QUALIFIER_RE = /(\s*\([^)]*\))+$/; // 이름 끝의 "(MCU)", "(AP)" 같은 한정자

const BRACKET_TAG_RE = /\[.*\]/;
const BRACKET_TAG_STRIP_RE = /\[.*?\]/g;

function stripBracketTag(name) {
  return (name || "").replace(BRACKET_TAG_STRIP_RE, "").trim();
}

// ruleEngine.js의 PR_IN_DESC_RE와 동일한 패턴("PR" 바로 뒤 공백/콜론/하이픈/물결 0~3글자
// 이내에 오는 숫자만 PR 번호로 인식 - 그 이유는 ruleEngine.js 쪽 주석 참고) - 여기서는 규칙
// 판정이 아니라 "문서 이력에 PR 번호가 있는지" 확인용으로 쓴다.
const PR_IN_DESC_RE = /\bPR[\s:\-~]{0,3}(\d+)/gi;

/**
 * checkDocHistoryRule(ruleEngine.js)이 승인/베이스라인 완료 상태라 원래 방식(현재 열려있는
 * PR과 최신 버전 설명 대조)으로는 판정할 수 없을 때 대신 쓰는 보조 확인. "마지막으로 확인해서
 * 문제없었던 지점"(checkpointVersion - 문제가 있었으면 그 지점에서 전진하지 않고 그대로
 * 있음, history.js 참고) 이후 새로 생긴 버전들의 설명에 PR 번호가 하나라도 적혀있는지,
 * 적혀있다면 그 번호가 NC List에 실제 존재하는지만 본다 - 어떤 PR인지, 그 시점에 그 PR이
 * 열려있었는지까지는 안 따진다(자동으로 완벽히 판정하려는 게 아니라, 사람이 직접 확인할
 * 후보를 추리는 용도). 새로 생긴 버전이 여러 개고 그중 문제 있는 게 여러 개면, 첫 번째에서
 * 멈추지 않고 전부 모아서 반환한다(하나씩만 순차로 드러나면 뒤에 있는 문제를 놓치고 지나칠
 * 수 있어서). 문제가 있으면 checkpoint가 전진하지 않으므로, 고쳐질 때까지 다음 감사에서도
 * 같은 지점부터 다시 확인해 계속 안내된다.
 * checkpointVersion을 baseline 목록에서 못 찾으면(첫 확인 등) 최신 버전 하나만 본다. 단,
 * 처음 승인된 baseline(그리고 그 이전)은 무슨 일이 있어도 검사 대상에 넣지 않는다 - 최초
 * 승인은 문제를 고쳐서 된 게 아니라 처음 공식화된 것뿐이라 PR을 적을 이유가 없다(예: 1.0
 * (Approved)가 이 트래커의 baseline 이력 중 첫 baseline이자 첫 승인인 경우, 체크포인트가
 * 없어서 "최신 것 하나만 본다" 폴백에 걸리더라도 1.0은 보지 않는다).
 */
function findDocHistoryManualCheckReason(allBaselines, checkpointVersion, validPrNumbers) {
  if (!allBaselines || allBaselines.length === 0) return null;

  const firstApprovedIndex = allBaselines.findIndex((b) => (b.versionType || "").includes("Approved"));

  let sinceIndex;
  if (checkpointVersion) {
    let lastMatchIdx = -1;
    for (let i = 0; i < allBaselines.length; i++) {
      if (allBaselines[i].version === checkpointVersion) lastMatchIdx = i;
    }
    sinceIndex = lastMatchIdx >= 0 ? lastMatchIdx + 1 : allBaselines.length - 1;
  } else {
    sinceIndex = allBaselines.length - 1;
  }
  if (firstApprovedIndex >= 0 && sinceIndex <= firstApprovedIndex) {
    sinceIndex = firstApprovedIndex + 1;
  }

  const newBaselines = allBaselines.slice(sinceIndex);
  const reasons = [];
  for (const b of newBaselines) {
    const desc = b.description || "";
    const prNums = [];
    PR_IN_DESC_RE.lastIndex = 0;
    let m;
    while ((m = PR_IN_DESC_RE.exec(desc)) !== null) prNums.push(m[1]);

    if (prNums.length === 0) {
      reasons.push(`버전 ${b.version ?? "?"} 설명에 PR 번호가 적혀있지 않음`);
      continue;
    }
    const invalid = prNums.filter((n) => !validPrNumbers.has(n));
    if (invalid.length > 0) {
      reasons.push(`버전 ${b.version ?? "?"} 설명에 적힌 PR 번호(${invalid.join(", ")})가 NC List에서 확인되지 않음`);
    }
  }
  return reasons.length > 0 ? reasons.join(" / ") : null;
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
      // workItem이 가리키는 개별 아이템(파일) 자체의 uri - Reference 계열 트래커는 트래커
      // 단위가 아니라 파일 단위로 등재되고, 등재 시점의 파일명이 그대로 붙어서 이후 버전이
      // 올라가도 안 바뀌므로(collectReferenceFileRecords 참고), 트래커 이름/uri가 아니라
      // 이 값으로 등재된 실제 파일을 정확히 찾아야 한다.
      workItemUri: workItem ? workItem.uri || "" : "",
      prIdList: prItems.map((p) => p.name),
      status: (item.status || {}).name,
    };
  });
}

// ── CIL/트래커/카테고리 아우터 조인 ──────────────────────────────────────────
/**
 * CIL 목록과 프로젝트의 트래커/카테고리 목록을 이름으로 아우터 조인한다.
 * - CIL엔 있는데 트래커/카테고리 쪽에 없으면: 그대로(트래커 URI는 CIL의 workItem에서 옴)
 * - 트래커/카테고리엔 있는데 CIL에 없으면: "미등재"로 분리 (감사 대상에서 빠짐) - 단
 *   TRACKERS_EXEMPT_FROM_ITEM_LIST에 있는 이름(NCL, Change Order/Request, Urgent Issue,
 *   CIL 자기 자신 등 원래 Item List 등재 대상이 아닌 트래커, 즉 애초에 형상감사 대상이 아닌
 *   트래커)은 미등재 목록에서 제외한다. Review Report/Audit Report는 보조 트래커라도 Item
 *   List에 등재돼 있어야 하므로 예외 없음.
 * - CIL엔 있는데(cilId 존재) 대응하는 codebeamer 트래커가 없고, ITEM_LIST_ENTRIES_EXCLUDED_
 *   FROM_AUDIT에 있는 이름(Source Code처럼 항상 사람이 직접 확인해야 해서 자동 감사 자체가
 *   불가능한 경우)이면, "등재"쪽에서도 아예 제외한다 - 감사 결과 표/트래커 선택 목록 어디에도
 *   나타나지 않는다.
 * - 이름 매칭은, 먼저 CIL 쪽 이름 앞에 흔히 붙는 "[SUP8_CIL-123456]" 같은 자동 생성 ID
 *   접두어를 트래커 쪽과 마찬가지로 떼어낸 뒤, 공백/하이픈/언더스코어 유무·대소문자 차이는
 *   무시하고 비교한다(normalizeNameForRowMatch - 화면상 거의 안 보이는 "괄호 앞 공백 하나
 *   있고 없고" 같은 차이 때문에 등재된 산출물이 미등재로 잘못 잡히는 걸 막기 위함). 단수/복수,
 *   명사/형용사 등 그 외의 단어 차이(Requirement/Requirements, Function/Functional 등)는
 *   예외 없이 다른 이름으로 취급한다 - 진짜 등재명이 다르면 미등재로 잡혀야 한다는 확인에
 *   따른 것.
 * - 둘 다 있으면: 병합, TRACKER_uri가 비어있으면 트래커/카테고리 쪽 uri로 채움
 */
function normalizeJoinName(name) {
  // CIL 아이템 이름 앞에 "[SUP8_CIL-123456]" 같은 자동 생성 ID 접두어가 붙어있는 경우가
  // 있어서, 트래커/카테고리 쪽과 마찬가지로 대괄호 태그를 뗀다(이미 안 붙어있으면 그대로).
  const base = stripBracketTag(name || "");
  return normalizeNameForRowMatch(base);
}

function mergeCilWithTrackers(cilRows, trackers, categories) {
  const tagged = [];
  // 대괄호 태그 없는 트래커(Reference 계열 - collectReferenceFileRecords가 파일 단위로 따로
  // 처리)의 uri를 모아둔다. CIL/RDL 항목의 workItem이 이런 트래커 안의 파일 하나를 직접
  // 가리키면(parseCilData가 채운 trackerUri), 그 항목 자체의 trackerName은 트래커명이 아니라
  // 등재 시점 파일명이라 표준 4규칙 감사에 트래커인 것처럼 섞여 들어가면 안 되므로, 아래에서
  // registered/unregistered 양쪽 다 제외한다.
  const untaggedTrackerUris = new Set();
  for (const item of [...trackers, ...categories]) {
    if (BRACKET_TAG_RE.test(item.name || "")) {
      tagged.push({ name: stripBracketTag(item.name), uri: item.uri, processTag: extractProcessTag(item.name) });
    } else if (item.uri) {
      untaggedTrackerUris.add(item.uri);
    }
  }

  const mergedByName = new Map();
  for (const cilRow of cilRows) {
    mergedByName.set(normalizeJoinName(cilRow.trackerName), { ...cilRow, processTag: extractProcessTag(cilRow.trackerName) });
  }
  for (const { name, uri, processTag } of tagged) {
    const joinName = normalizeJoinName(name);
    if (mergedByName.has(joinName)) {
      const row = mergedByName.get(joinName);
      if (!row.trackerUri) row.trackerUri = uri;
      if (!row.processTag && processTag) row.processTag = processTag;
    } else {
      mergedByName.set(joinName, {
        cilId: null, cilUri: null, trackerName: name, trackerConnected: "X",
        trackerUri: uri, prIdList: [], status: null, processTag,
      });
    }
  }

  const all = [...mergedByName.values()].filter((r) => !untaggedTrackerUris.has(r.trackerUri));
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

  const registered = dedupeByUri(registeredRaw).filter(
    (r) => matchConfiguredSuffix(stripBracketTag(r.trackerName), ITEM_LIST_ENTRIES_EXCLUDED_FROM_AUDIT) === null
  );
  const unregistered = dedupeByUri(unregisteredRaw)
    .filter((r) => matchConfiguredSuffix(r.trackerName, TRACKERS_EXEMPT_FROM_ITEM_LIST) === null)
    .map((r) => ({
      trackerName: r.trackerName,
      trackerUri: r.trackerUri,
    }));

  // CIL(Item List)엔 등재돼 있지만 트래커 URI를 못 채운 항목 - 대응하는 codebeamer 트래커를
  // 이름으로 못 찾았다는 뜻이다(이름이 살짝 다르거나, 트래커 자체가 없거나). ITEM_LIST_ENTRIES_
  // WITHOUT_TRACKER에 있는 이름(Source Code 등)은 원래 트래커가 없는 게 정상이라 제외한다.
  // 이 목록은 예전엔 완전히 조용히 무시됐는데(registered에는 남아있지만 uri가 없어서
  // processTrackerRow가 그냥 null을 반환해 결과에서 사라짐), 이제 side panel이 감사 시작 전에
  // 이 목록으로 이름 불일치를 미리 잡아서 막는다(checkNameMatchIssues 참고).
  // Source Code처럼 하드웨어/소프트웨어 구성별로 "(BSP)(MCU)", "(APP)(AP)" 같은 괄호 한정자가
  // 뒤에 붙는 경우가 있어서, 매칭 전에 그 한정자부터 뗀다 - 안 그러면 "Source Code (BSP)(MCU)"가
  // "Source Code"로 안 끝나는 걸로 보여 정상 항목까지 이름 불일치로 잘못 잡힌다.
  const cilOnlyEntries = registered
    .filter((r) => !r.trackerUri && matchConfiguredSuffix(stripTrailingQualifier(stripBracketTag(r.trackerName)), ITEM_LIST_ENTRIES_WITHOUT_TRACKER) === null)
    .map((r) => ({ trackerName: r.trackerName, cilId: r.cilId }));

  return { registered, unregistered, cilOnlyEntries };
}

// ── Review Report 연결 ───────────────────────────────────────────────────────
/**
 * "...Result"/"...Report" 등 트래커명 + " Review Report" 형태의 트래커들을 매칭 키로 삼아
 * Review Report URI 맵을 만든다. "...Result"로 끝나는 이름은 "...Report"로 바꾼 이름도 같은
 * Review Report에 연결한다 (하나의 Review Report가 Result 본체 + 짝 문서를 같이 다루는 경우
 * 대응 - 실제 이름이 있으면 그쪽이 항상 우선한다).
 */
function buildReviewReportJoinMap(mergedRows) {
  // r.trackerName은 CIL 쪽에서 온 이름일 수 있어서 "[SUP8_CIL-123456]" 같은 자동 생성 ID
  // 접두어가 붙어있을 수 있다 - 조인 키를 만들기 전에 트래커/카테고리 쪽과 마찬가지로 뗀다
  // (안 떼면 이 트래커명으로 만든 조인 키가 실제 조회 시점의 이름과 안 맞아서 매칭이 조용히
  // 실패한다).
  const reviewRows = mergedRows
    .map((r) => ({ ...r, trackerName: stripBracketTag(r.trackerName || "") }))
    .filter((r) => r.trackerName.includes(" Review Report"))
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

    // 하나의 Review Report가 자기 이름과 다른 문서까지 같이 검토하는 경우
    // (REVIEW_REPORT_ADDITIONAL_TARGETS 참고) - 그 문서들도 같은 한정자를 붙여서 연결한다.
    // REVIEW_REPORT_ADDITIONAL_TARGETS의 키는 차종 코드가 없는 "순수한" 트래커명이라, 여기
    // baseWithoutQualifier 앞에 차종 코드가 붙어있을 수 있어 완전 일치 대신 접미사로 찾는다
    // (matchConfiguredSuffix). 매칭되고 남은 앞부분(차종 코드, 있으면)은 오른쪽 문서 이름들
    // 앞에도 그대로 붙여서, 같은 차종의 문서로 연결되게 한다.
    const additionalTargetsKey = matchConfiguredSuffix(baseWithoutQualifier, Object.keys(REVIEW_REPORT_ADDITIONAL_TARGETS));
    if (additionalTargetsKey) {
      const prefix = baseWithoutQualifier.slice(0, baseWithoutQualifier.length - additionalTargetsKey.length);
      const additionalTargets = REVIEW_REPORT_ADDITIONAL_TARGETS[additionalTargetsKey];
      for (const target of additionalTargets) {
        const targetKey = prefix + target + qualifierSuffix;
        if (!map.has(targetKey)) map.set(targetKey, uri);
      }
    }
  }
  return map;
}

// ── NCL(PR) 매칭 ─────────────────────────────────────────────────────────────
// checkDocHistoryRule이 "이 문서에 실제로 연결된 열려있는 PR"을 대조하는 대신 "버전 이력에
// PR 번호가 하나라도 적혀있고 그게 NC List에 존재하는지"만 보는 방식으로 바뀌면서(더 이상
// record.prId를 아무도 안 씀), 이 아래 NCL 항목별 Related Item 개별 조회(그 무거운 50초짜리
// 병목의 원인)가 전부 필요 없어졌다. 나중에 다시 "실제로 연결된 PR" 기준 대조가 필요해지면
// 이 주석을 풀면 된다 - 지우지 않고 남겨둔다.
// async function fetchNclRelations(client, item) {
//   const itemName = item.name;
//   const itemStatus = (item.status || {}).name || "";
//   const results = [];
//   const resp = await client.getJsonSoft(`${client.baseUrlV3}/items/${item.id}/relations`);
//   if (resp.ok && resp.json) {
//     const incoming = resp.json.incomingAssociations || [];
//     if (incoming.length === 0) {
//       results.push({ pr: itemName, cilId: null, status: itemStatus });
//     } else {
//       for (const assoc of incoming) {
//         const revisionId = (assoc.itemRevision || {}).id;
//         if (revisionId) results.push({ pr: itemName, cilId: revisionId, status: itemStatus });
//       }
//     }
//   }
//   return results;
// }
//
// function buildNclPrMap(allRelations) {
//   const prNumRe = /(\d+)/;
//   const byCilId = new Map();
//   for (const r of allRelations) {
//     if (r.status === "Closed" || r.cilId == null) continue;
//     const m = prNumRe.exec(String(r.pr));
//     const prNum = m ? m[1] : "";
//     if (!byCilId.has(r.cilId)) byCilId.set(r.cilId, []);
//     byCilId.get(r.cilId).push(prNum);
//   }
//   const result = new Map();
//   for (const [cilId, nums] of byCilId) result.set(cilId, nums.join(", "));
//   return result;
// }

// codebeamer URI 맨 끝의 숫자 ID를 뽑는다. 트래커명과 달리 이름이 바뀌어도 안 변하는
// 고유값이라, 트래커명 변경으로 문서 이력 체크포인트가 리셋되지 않게 하는 용도로도 쓴다
// (history.js의 findPreviousEntry 참고).
function trackerIdFromUri(uri) {
  return (uri || "").replace(/\/$/, "").split("/").pop();
}

// ── 이벤트성 워크플로우 판별 (캐시) ──────────────────────────────────────────
function makeEventBasedChecker(client) {
  const cache = new Map();
  return async function isEventbasedWorkflow(trackerUri) {
    if (cache.has(trackerUri)) return cache.get(trackerUri);
    const trackerId = trackerIdFromUri(trackerUri);
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
  if (!uri) {
    // 트래커/카테고리 이름 매칭에 실패한 일반적인 경우(진짜 있는 트래커인데 표기가 달라서 못
    // 찾은 것)는 그냥 조용히 빼고(null), "미등재" 경고 쪽에서 이미 다뤄지게 둔다 - 거기서
    // 이름을 고쳐서 매칭시키는 게 맞는 방향이다. ITEM_LIST_ENTRIES_EXCLUDED_FROM_AUDIT에 있는
    // 이름(Source Code 등)은 mergeCilWithTrackers의 registered 필터링 단계에서 이미 걸러져서
    // 여기까지 오지 않는다. ITEM_LIST_ENTRIES_WITHOUT_TRACKER에 있는 이름만, "정상(이상 없음)"도
    // "미등재"도 아닌, 사람이 직접 확인해야 하는 항목으로 남긴다(ruleEngine.js의 runAudit이
    // noLinkedTracker를 보고 안내 코멘트를 채운다).
    if (matchConfiguredSuffix(stripBracketTag(mergedRow.trackerName), ITEM_LIST_ENTRIES_WITHOUT_TRACKER) === null) return null;
    return {
      cilId: mergedRow.cilId,
      trackerName: mergedRow.trackerName,
      trackerId: "", // 연결된 트래커가 없어 URI 자체가 없음 - ID 기반 체크포인트 복구 대상 아님
      trackerType: "",
      itemCount: 0,
      fileName: "",
      paItemName: "",
      paItemId: null,
      firstEdit: "",
      lastEdit: "",
      status: null,
      currentVersion: "미업로드",
      validPrNumbers: new Set(),
      versioning: "",
      verDesc: "",
      reviewReportItemCount: "해당없음",
      reviewReportStatus: "",
      reviewReportUploaded: "해당없음",
      waitingBeforeApproval: null,
      reviewReportLastUpload: "",
      owner: "",
      createDateCurrent: false,
      targetVersion: "",
      versionCheckFailReason: "",
      versionCheckPaItemId: null,
      isEventBased: false,
      testResultClosedDate: "",
      itemFetchIncomplete: false,
      noLinkedTracker: true,
    };
  }

  // mergedRow.trackerName도 CIL 쪽 원본 이름(ID 접두어 포함 가능)이라, 조인 맵 만들 때와
  // 똑같이 대괄호 태그를 떼고 찾아야 한다 - 안 그러면 실제로 연결된 Review Report가 있어도
  // 조용히 못 찾는다.
  const rrUri = ctx.reviewReportUriMap.get(stripBracketTag(mergedRow.trackerName)) || null;
  const trackerId = trackerIdFromUri(uri);

  const tracker = await client.getJson(`https://codebeamer.slworld.com/cb/rest${uri}`);
  const trackerItemResult = await client.fetchAllItems(`https://codebeamer.slworld.com/cb/rest${uri}/items`);
  const itemFetchIncomplete = trackerItemResult.incomplete;
  const tName = tracker.name || "";

  let rrData = { num: "해당없음", time: "해당없음", status: "해당없음", isUpload: "해당없음", targetVersion: "", versionCheckFailReason: "", versionCheckPaItemId: null };
  if (rrUri) {
    const rrResp = await client.fetchAllItems(`https://codebeamer.slworld.com/cb/rest${rrUri}/items`);
    const rrItems = rrResp.items;
    if (rrItems.length > 0) {
      const paItem = rrItems.find((it) => ((it.type || {}).name) === "Primary Attribute") || null;
      const rrStatus = paItem ? normalizeStatusName((paItem.status || {}).name) || "" : "";

      let targetVersion = "";
      let versionCheckFailReason = "리뷰레포트 PA 아이템 없음";
      // 판정 실패 시 사람이 codebeamer에서 직접 열어볼 수 있게 이 리뷰레포트 PA 아이템의
      // ID를 같이 실어 보낸다(audit.js가 "리뷰레포트 PA 항목에서 직접 확인" 링크로 씀).
      const versionCheckPaItemId = paItem ? paItem.id : null;
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
        versionCheckPaItemId,
      };
    } else {
      rrData = { num: 0, time: "", status: "", isUpload: false, targetVersion: "", versionCheckFailReason: "", versionCheckPaItemId: null };
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
  const currentStatus = paItemObj ? normalizeStatusName((paItemObj.status || {}).name) : null;

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
    trackerId,
    trackerType: tType,
    itemCount: items.length,
    fileName: tType === "Document" && items.length > 0 ? items[0].fileName || "" : "",
    paItemName: paItemObj ? paItemObj.name || "" : "",
    // 대상 산출물(이 트래커) 자신의 PA 아이템 ID - "리뷰 대상 버전 자동 확인 불가" 안내에서
    // 리뷰레포트 PA 항목 링크뿐 아니라, 실제로 버전을 확인해야 할 대상 문서 자체로도 바로
    // 이동할 수 있게 audit.js가 링크로 쓴다.
    paItemId: paId,
    firstEdit: hInfo.first,
    lastEdit: hInfo.last,
    status: hInfo.status,
    currentVersion: base.version || "미업로드",
    validPrNumbers: ctx.validPrNumbers,
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
    versionCheckPaItemId: rrData.versionCheckPaItemId,
    isEventBased: await ctx.isEventbasedWorkflow(uri),
    testResultClosedDate: dateBasedClosedDate,
    itemFetchIncomplete,
    docHistoryManualCheckReason: findDocHistoryManualCheckReason(
      ctx.allBaselinesByTracker.get(tName),
      // 이름으로 먼저 찾고, 없으면(트래커명이 바뀐 경우) ID로 찾은 체크포인트로 대체한다 -
      // 이름 변경만으로 "지금까지 확인한 지점"을 잃어버려 처음부터 다시 확인하지 않도록.
      ctx.docHistoryCheckpoints[tName] ?? ctx.docHistoryCheckpointsById[trackerId],
      ctx.validPrNumbers
    ),
    // 문서 이력 기술 규칙(PR 기재 확인)은 이 트래커가 한 번이라도 승인/베이스라인까지 간
    // 적이 있어야 적용한다 - 첫 승인 전 초기 버전들(1.0, 1.1 등)은 아직 정식 PR 추적
    // 대상이 아니라서, 그 이전 버전 설명에 PR이 없다고 잡으면 안 된다는 확인에 따른 것.
    // baseline 이력 중 승인 스탬프(versionType에 "Approved" 포함)가 하나라도 있으면 true.
    hasEverBeenApproved: (ctx.allBaselinesByTracker.get(tName) || []).some(
      (b) => (b.versionType || "").includes("Approved")
    ),
  };
}

// CIL/트래커/카테고리를 조인해서 프로젝트의 감사 대상 트래커 행(processTrackerRow 전 단계)을
// 만든다. collectAuditData와 listRegisteredTrackerNames가 이 앞부분을 공유한다 - 트래커
// 이름만 필요한 side panel의 트래커 선택 목록도, 이 무거운 per-tracker 조회(processTrackerRow)
// 전까지만 실행하면 충분히 가볍게 얻을 수 있다.
async function loadMergedTrackerRows(client, { projectName, trackerCil, onProgress = null }) {
  onProgress?.({ phase: "프로젝트 정보 조회 중..." });
  const projectsResp = await client.getJson(`${client.baseUrl}/projects/page/1`);
  const project = (projectsResp.projects || []).find((p) => (p.name || "").includes(projectName));
  if (!project) throw new Error(`프로젝트를 찾을 수 없습니다: ${projectName}`);
  const userUri = `${client.baseUrl}${project.uri}`;

  onProgress?.({ phase: "트래커/카테고리 목록 조회 중..." });
  const allTrackers = await client.getJson(`${userUri}/trackers`);
  const allCategories = await client.getJson(`${userUri}/categories`);

  // CIL 트래커 조회
  const cilTracker = allTrackers.find((t) => t.name === trackerCil);
  if (!cilTracker) throw new Error(`CIL 트래커를 찾을 수 없습니다: ${trackerCil}`);
  onProgress?.({ phase: "Configuration Item List 조회 중..." });
  const cilItemsResult = await client.fetchAllItems(`${client.baseUrl}${cilTracker.uri}/items`, {
    onPage: (page, itemCount) => onProgress?.({ phase: `Configuration Item List 조회 중... (${itemCount}건)` }),
  });
  let cilRows = parseCilData(cilItemsResult.items);

  // Reference Document List: CIL과 별개로 참고 문서를 등재하는 프로젝트가 있어서, 있으면
  // CIL 목록과 합쳐서 같이 등재 여부 매칭에 쓴다. 없는 프로젝트도 많아서 CIL과 달리 없어도
  // 에러 내지 않는다.
  const refDocTracker = allTrackers.find((t) => t.name === TRACKER_NAME_REFERENCE_DOC_LIST);
  if (refDocTracker) {
    onProgress?.({ phase: "Reference Document List 조회 중..." });
    const refDocItemsResult = await client.fetchAllItems(`${client.baseUrl}${refDocTracker.uri}/items`, {
      onPage: (page, itemCount) => onProgress?.({ phase: `Reference Document List 조회 중... (${itemCount}건)` }),
    });
    cilRows = [...cilRows, ...parseCilData(refDocItemsResult.items)];
  }

  const { registered, unregistered, cilOnlyEntries } = mergeCilWithTrackers(cilRows, allTrackers, allCategories);

  return { userUri, allTrackers, allCategories, cilRows, registered, unregistered, cilOnlyEntries };
}

/**
 * side panel의 트래커 선택 목록용 - 프로젝트에 등재된 트래커 이름만 가볍게 가져온다(무거운
 * per-tracker 조회 전이라 저렴함). 이름 불일치(트래커는 있는데 Item List엔 없음 / Item
 * List엔 있는데 트래커를 못 찾음) 목록도 같이 반환한다 - 감사를 시작하기 전에 이걸로 먼저
 * 막아야(popup.js) 이름이 안 맞아서 감사도 반영도 안 되는 산출물이 조용히 빠지는 걸 방지한다.
 * @returns {Promise<{trackerNames: Array<{name: string, processTag: string}>, unregisteredTrackers: Array<{trackerName, trackerUri}>, cilOnlyEntries: Array<{trackerName, cilId}>}>}
 */
export async function listRegisteredTrackerNames(client, { projectName, trackerCil }) {
  const { registered, unregistered, cilOnlyEntries } = await loadMergedTrackerRows(client, { projectName, trackerCil });
  const trackerNames = registered
    .map((r) => ({ name: r.trackerName, processTag: r.processTag || "" }))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return { trackerNames, unregisteredTrackers: unregistered, cilOnlyEntries };
}

// Reference 계열(대괄호 태그 없는) 트래커/카테고리 - 차종 코드 등 정해진 이름 형식이 없는
// 참고 문서라 CIL 등재도 트래커 단위가 아니라 그 안의 파일(아이템) 단위로 이뤄진다(등재 시점
// 파일명이 이후 버전이 올라가도 안 바뀌어서 트래커명과도 어긋남 - workItemUri로 매칭하는 이유).
// 그래서 표준 4규칙 감사(processTrackerRow)를 태우지 않고, 파일마다 CIL/Reference Document
// List에 연결된 항목이 있는지만 따로 확인한다 - 결과는 runAudit이 저장 규칙 하나로만 판정하고
// 나머지 3규칙은 N/A로 둔다(getManualCheckFlags 등 기존 트래커명 기반 안내 목록과는 무관하게
// 조용히 지나간다 - 파일명이 그 목록들의 트래커명과 겹칠 일이 없어서).
async function collectReferenceFileRecords(client, { allTrackers, allCategories, cilRows, onProgress = null }) {
  const referenceTrackers = [...allTrackers, ...allCategories].filter((t) => !BRACKET_TAG_RE.test(t.name || ""));
  if (referenceTrackers.length === 0) return [];

  const cilRowByWorkItemUri = new Map();
  for (const row of cilRows) {
    if (row.workItemUri) cilRowByWorkItemUri.set(row.workItemUri, row);
  }

  const records = [];
  for (const tracker of referenceTrackers) {
    onProgress?.({ phase: `${tracker.name} 내부 파일 조회 중...` });
    let items;
    try {
      const result = await client.fetchAllItems(`${client.baseUrl}${tracker.uri}/items`, {});
      items = result.items;
    } catch (e) {
      console.error(`[${tracker.name}] Reference 파일 목록 조회 실패:`, e);
      continue;
    }
    for (const item of items) {
      const matched = cilRowByWorkItemUri.get(item.uri);
      records.push({
        cilId: matched ? matched.cilId : null,
        trackerName: item.name,
        isReferenceFile: true,
        referenceFileRegistered: !!matched,
      });
    }
  }
  // phase 메시지는 트래커별 조회처럼 "끝났다"는 신호가 따로 없어서, 이 단계가 다 끝난 뒤에도
  // 화면 로그의 마지막 줄이 계속 "조회 중..." 애니메이션으로 남아있게 된다 - 명시적으로 완료를
  // 알려서 멈추게 한다.
  onProgress?.({ done: true, doneText: `✓ Reference 파일 조회 완료 (${referenceTrackers.length}개 트래커)` });
  return records;
}

/**
 * 감사 대상 데이터를 codebeamer에서 수집한다. onlyTrackerNames를 주면(비어있지 않은 배열)
 * 등재된 트래커 중 그 이름들만 실제 조회(processTrackerRow)하고, 나머지는 건드리지 않는다 -
 * 특정 트래커만 골라서 감사할 때 불필요한 codebeamer 호출을 줄이기 위함이다. 리뷰레포트
 * 조인맵/베이스라인/PR맵은 트래커 간에 서로 참조할 수 있어 항상 프로젝트 전체 기준으로 만든다.
 * onProgress를 주면 두 가지 형태로 불러준다 - 화면에 진행 로그를 실시간으로 찍어 대기 시간을
 * 덜 답답하게 하기 위함이다.
 * - { phase: string }: per-tracker 조회 루프 전, 프로젝트/트래커 목록/CIL/베이스라인/NCL 등을
 *   순차로 조회하는 동안 각 단계가 시작될 때(페이지네이션이 있는 조회는 페이지마다) 불러준다.
 * - { trackerName, status: "start"|"done", completed, total }: 트래커 하나씩 조회를
 *   시작/완료할 때마다 불러준다.
 * @returns {{records: Array, unregisteredTrackers: Array<{trackerName, trackerUri}>, projectId: string, fetchFailedTrackers: string[]}}
 */
export async function collectAuditData(client, { projectName, trackerCil, trackerNcl, onlyTrackerNames = null, onProgress = null, docHistoryCheckpoints = {}, docHistoryCheckpointsById = {}, includeReferenceFiles = true }) {
  const { userUri, allTrackers, allCategories, cilRows, registered, unregistered } = await loadMergedTrackerRows(client, { projectName, trackerCil, onProgress });
  const reviewReportUriMap = buildReviewReportJoinMap(registered);

  const targetRows = onlyTrackerNames && onlyTrackerNames.length
    ? registered.filter((r) => onlyTrackerNames.includes(r.trackerName))
    : registered;

  // 베이스라인
  const projectId = userUri.split("/").pop();
  onProgress?.({ phase: "베이스라인 조회 중..." });
  const baselinesResp = await client.getJson(`https://codebeamer.slworld.com/cb/rest/projects/${projectId}/baselines`);
  const baselineRows = parseBaselineData(baselinesResp);
  const latestBaselines = buildLatestBaselines(baselineRows);
  const allBaselinesByTracker = buildAllBaselinesByTracker(baselineRows);

  // NCL(PR 매칭) - 이제 "NC List에 실제 존재하는 PR 번호" 집합만 필요하다(문서 이력에 적힌
  // PR 번호가 유효한지 대조용). 예전엔 각 PR이 어느 CIL 항목에 연결됐는지(Related Item)까지
  // 개별로 조회했는데(그 50초짜리 병목), checkDocHistoryRule이 더 이상 그 대조를 안 해서
  // 필요 없어졌다 - 아래 fetchNclRelations/buildNclPrMap 호출은 주석 처리, 필요해지면 복구.
  const nclTracker = allTrackers.find((t) => t.name === trackerNcl);
  const validPrNumbers = new Set();
  if (nclTracker) {
    onProgress?.({ phase: "NCL(부적합 목록) 항목 조회 중..." });
    const nclItemsResult = await client.fetchAllItems(`${client.baseUrl}${nclTracker.uri}/items`, {
      onPage: (page, itemCount) => onProgress?.({ phase: `NCL(부적합 목록) 항목 조회 중... (${itemCount}건)` }),
    });
    for (const item of nclItemsResult.items) {
      const m = /(\d+)/.exec(item.name || "");
      if (m) validPrNumbers.add(m[1]);
    }
    // onProgress?.({ phase: "NCL-CIL 연결 관계 조회 중..." });
    // const allRelations = await mapWithConcurrency(nclItemsResult.items, 20, (item) => fetchNclRelations(client, item));
    // prMap = buildNclPrMap(allRelations.flat());
  }

  onProgress?.({ phase: `감사 대상 트래커 ${targetRows.length}개 조회 시작...` });
  const isEventbasedWorkflow = makeEventBasedChecker(client);
  const ctx = { reviewReportUriMap, latestBaselines, allBaselinesByTracker, docHistoryCheckpoints, docHistoryCheckpointsById, validPrNumbers, isEventbasedWorkflow };

  // processTrackerRow 안의 client.getJson/putJson은 순수 네트워크 오류(fetch 자체 실패 -
  // HTTP 에러 코드가 아니라 연결이 끊긴 경우)를 못 잡고 그대로 던진다. 트래커 하나가 이렇게
  // 실패했다고 감사 전체를 중단시키면 안 되므로, 여기서 트래커 단위로 잡아서 그 트래커만
  // "조회 실패"로 건너뛰고 나머지는 계속 진행한다. 실패한 트래커명은 따로 모아뒀다가
  // audit.js가 "재시도" 버튼으로 그 트래커들만 다시 조회할 수 있게 반환한다.
  let completed = 0;
  const fetchFailedTrackers = [];
  const results = await mapWithConcurrency(targetRows, 15, async (row) => {
    onProgress?.({ trackerName: row.trackerName, status: "start", completed, total: targetRows.length });
    let result;
    try {
      result = await processTrackerRow(client, row, ctx);
    } catch (e) {
      console.error(`[${row.trackerName}] 조회 실패:`, e);
      fetchFailedTrackers.push(row.trackerName);
      // 상세 데이터는 하나도 못 가져왔지만, CIL에서 이미 확보해둔 cilId/트래커명은 그대로
      // 있다 - 이 값들로 가짜 행을 만들어서(noLinkedTracker placeholder와 같은 패턴) 표에는
      // 보이게 하고, 4개 규칙 전부 사람이 직접 판정해야만 반영할 수 있게 강제한다
      // (getManualCheckFlags/audit.js 참고). cilId가 진짜 codebeamer 아이템을 가리키므로
      // 사람이 판정을 채우면 정상적으로 반영된다.
      result = {
        cilId: row.cilId,
        trackerName: row.trackerName,
        trackerId: "",
        trackerType: "",
        itemCount: 0,
        fileName: "",
        paItemName: "",
        paItemId: null,
        firstEdit: "",
        lastEdit: "",
        status: null,
        currentVersion: "미업로드",
        validPrNumbers: ctx.validPrNumbers,
        versioning: "",
        verDesc: "",
        reviewReportItemCount: "해당없음",
        reviewReportStatus: "",
        reviewReportUploaded: "해당없음",
        waitingBeforeApproval: null,
        reviewReportLastUpload: "",
        owner: "",
        createDateCurrent: false,
        targetVersion: "",
        versionCheckFailReason: "",
        versionCheckPaItemId: null,
        isEventBased: false,
        testResultClosedDate: "",
        itemFetchIncomplete: false,
        fetchFailed: true,
      };
    }
    completed += 1;
    onProgress?.({ trackerName: row.trackerName, status: "done", completed, total: targetRows.length });
    return result;
  });
  const records = results.filter((r) => r !== null);

  // Reference 계열 파일 단위 등재 확인은 재시도(특정 트래커만 다시 조회) 흐름에서는 뺀다 -
  // 파일 레코드는 트래커명이 아니라 파일명 단위라 namesToRetry 기준 교체/중복 제거 로직과
  // 안 맞아서, 재시도 때마다 다시 돌리면 표에 같은 파일이 중복으로 쌓인다.
  const referenceFileRecords = includeReferenceFiles
    ? await collectReferenceFileRecords(client, { allTrackers, allCategories, cilRows, onProgress })
    : [];

  return { records: [...records, ...referenceFileRecords], unregisteredTrackers: unregistered, projectId, fetchFailedTrackers };
}
