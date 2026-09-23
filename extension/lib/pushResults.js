// Python D_Result_Update.py를 그대로 옮긴 것. Excel을 다시 읽어서 CIL_ID로 재조인하던
// 부분은 필요 없다 - record가 처음부터 cilId를 직접 들고 있으므로.

const FIELD_ID_AUDIT_COMMENT = 10016;

// "버저닝 지연" 사유는 첫 Edit은 고정이지만 오늘 기준 경과 영업일은 재감사할 때마다 자연히
// 갱신되므로, 같은 미해결 건이어도 코멘트 전문이 매번 달라진다("...영업일 16일 경과..." ->
// 다음 주엔 "...영업일 23일 경과..."). 같은 이슈인지 판단할 땐 이 부분만 빼고 비교한다 - 그
// 외에 사유 자체가 달라지면(예: 저장 규칙이 계속 NG여도 "File Naming Rule 불일치"였다가
// "파일 2개 등재됨"으로 바뀌면) 같은 규칙이 NG인 건 똑같아도 다른 문제니 다시 NG를 눌러
// 반영해야 한다 - Audit Result에 NG를 누를 때마다 codebeamer가 PR을 자동 발행하므로, 진짜
// 아무 것도 안 달라진 미해결 건일 때만 중복 발행을 막아야 하기 때문이다.
const VOLATILE_VERSIONING_DELAY_RE = /오늘까지 영업일 \d+일 경과/g;

function normalizeForDedup(commentText) {
  return (commentText || "").replace(VOLATILE_VERSIONING_DELAY_RE, "버저닝 지연 중");
}

function existingAuditComment(itemData, fieldId) {
  for (const field of itemData.customFields || []) {
    if (field.fieldId === fieldId) return field.value || "";
  }
  return "";
}

function ngFieldIdSet(customFields, ruleFieldIds) {
  return new Set(
    (customFields || [])
      .filter((f) => ruleFieldIds.includes(f.fieldId) && (f.values || []).some((v) => v.id === 2))
      .map((f) => f.fieldId)
  );
}

/**
 * record 하나(트래커 하나)의 감사 결과를 codebeamer CIL 아이템에 반영한다.
 * @returns {Promise<"updated"|"duplicate_skip"|"fetch_failed">}
 */
export async function pushRecordResult(client, record) {
  const itemId = record.cilId;
  const itemUrl = `https://codebeamer.slworld.com/cb/rest/v3/items/${itemId}`;
  const commentText = record.comment || "이상 없음";

  // codebeamer에서 이 네 필드의 "--"(해당 없음)는 별도 선택지 ID가 아니라 필드 자체가
  // customFields에 없는 상태다(값 1=OK, 2=NG만 실제로 존재 - 확인 완료). 그래서 규칙이
  // null(N/A - 아직 자동 판정 못 했거나 대상이 아님)이면 그 필드를 아예 반영 데이터에서
  // 빼서 codebeamer에 있는 값(없으면 "--", 있으면 예전 값)을 그대로 둔다 - 예전처럼 무조건
  // 1(OK)로 덮어쓰면 사람이 확인도 안 한 걸 OK로 잘못 보고하게 된다.
  const RULE_FIELD_IDS = [1016, 1011, 1012, 1013];
  const choiceUpdates = {};
  if (record.saveRule != null) choiceUpdates[1016] = record.saveRule;
  if (record.versionRule != null) choiceUpdates[1011] = record.versionRule;
  if (record.docHistoryRule != null) choiceUpdates[1012] = record.docHistoryRule;
  if (record.statusRule != null) choiceUpdates[1013] = record.statusRule;

  let itemData;
  try {
    itemData = await client.getJson(itemUrl);
  } catch (e) {
    console.error(`[${itemId}] 조회 실패:`, e);
    return "fetch_failed";
  }

  const targetIds = new Set([...Object.keys(choiceUpdates).map(Number), FIELD_ID_AUDIT_COMMENT]);
  const updatedCustomFields = [];
  for (const f of itemData.customFields || []) {
    if (f.fieldId === 1009) continue; // Configuration Status는 수정 불가 - 에러 방지를 위해 건너뜀
    if (!targetIds.has(f.fieldId)) updatedCustomFields.push(f);
  }
  for (const [fieldIdStr, valueId] of Object.entries(choiceUpdates)) {
    updatedCustomFields.push({
      fieldId: Number(fieldIdStr),
      type: "ChoiceFieldValue",
      values: [{ id: valueId, type: "ChoiceOptionReference" }],
    });
  }
  updatedCustomFields.push({ fieldId: FIELD_ID_AUDIT_COMMENT, type: "TextFieldValue", value: commentText });

  // "4개 규칙 중 하나라도 NG면 전체 NG"는 이번에 새로 판정한 값(choiceUpdates)만 봐서는 안
  // 된다 - 이번에 어떤 규칙이 N/A(null)라서 안 건드리면, codebeamer에 그대로 남아있는 예전
  // 값(예: 지난 감사의 NG)을 놓치고 "이번엔 NG가 없으니 전체 OK"로 잘못 반영하게 된다. 그래서
  // 이번에 실제로 codebeamer에 남게 될 최종 병합 결과(updatedCustomFields)를 기준으로 판단한다.
  const finalNgFieldIds = ngFieldIdSet(updatedCustomFields, RULE_FIELD_IDS);
  const isNgFound = finalNgFieldIds.size > 0;

  // Audit Result를 NG로 누르면 codebeamer에서 PR이 자동 발행된다. 그래서 지난 반영과 사유
  // (코멘트 전문, 경과일 등 변동분은 제외하고)가 완전히 같은 NG면 - 이미 그 문제로 PR이
  // 발행돼 처리 중일 것이므로 - Audit Result를 포함해 아무것도 다시 건드리지 않고 그대로 둔다.
  // 사유가 조금이라도 달라지면(새 NG가 추가/해결돼 조합이 바뀌었든, 같은 규칙이어도 구체적인
  // 사유 자체가 바뀌었든) 다른 문제로 보고 다시 NG를 눌러 반영한다.
  const existingComment = existingAuditComment(itemData, FIELD_ID_AUDIT_COMMENT);
  if (isNgFound && normalizeForDedup(existingComment) === normalizeForDedup(commentText)) {
    return "duplicate_skip";
  }

  const basePayload = {
    name: itemData.name,
    description: itemData.description,
    priority: itemData.priority,
    customFields: updatedCustomFields,
    subjects: itemData.subjects || [],
    endDate: itemData.endDate,
  };

  // 원본과 동일한 순서로 PUT 두 번: 먼저 'Open'으로, 그다음 NG/OK로. 첫 PUT의 status 필드가
  // { status: { id, name, type } }로 이중 감싸진 모양인 것도 원본 그대로다 - 실제 운영에서
  // 문제없이 쓰이고 있는 형태라 임의로 "바로잡지" 않는다 (최종 상태를 정하는 건 두 번째 PUT).
  await client.putJson(itemUrl, {
    ...basePayload,
    status: { status: { id: 5, name: "Open", type: "ChoiceOptionReference" } },
  });

  await client.putJson(itemUrl, {
    ...basePayload,
    status: { id: isNgFound ? 3 : 2, name: isNgFound ? "NG" : "OK", type: "ChoiceOptionReference" },
  });

  return "updated";
}

/**
 * 여러 record를 순서대로(원본과 동일하게 동시 실행 없이) 반영한다.
 * @returns {Promise<{updated:number, duplicateSkipped:number, duplicateSkippedTrackers:string[], fetchFailed:number}>}
 */
export async function pushAllResults(client, records, excludedCilIds = new Set(), onProgress = null) {
  const summary = { updated: 0, duplicateSkipped: 0, duplicateSkippedTrackers: [], fetchFailed: 0 };

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (excludedCilIds.has(record.cilId)) continue;

    const result = await pushRecordResult(client, record);
    if (result === "duplicate_skip") {
      summary.duplicateSkipped += 1;
      summary.duplicateSkippedTrackers.push(record.trackerName);
    } else if (result === "fetch_failed") {
      summary.fetchFailed += 1;
    } else if (result === "updated") {
      summary.updated += 1;
    }

    if (onProgress) onProgress(i + 1, records.length, record);
  }

  return summary;
}
