// Python D_Result_Update.py를 그대로 옮긴 것. Excel을 다시 읽어서 CIL_ID로 재조인하던
// 부분은 필요 없다 - record가 처음부터 cilId를 직접 들고 있으므로.

const FIELD_ID_AUDIT_COMMENT = 10016;

// "버저닝 지연" 사유는 첫 Edit은 고정이지만 버저닝 날짜/경과 영업일은 재감사할 때마다 자연히
// 갱신되므로, 같은 미해결 건이어도 코멘트 전문이 매번 달라진다. 같은 이슈인지 판단할 땐 이
// 부분을 빼고 비교한다 (원본 D_Result_Update.py의 _normalize_for_dedup과 동일).
const VOLATILE_VERSIONING_DELAY_RE = /버저닝 \d{4}-\d{2}-\d{2}, 영업일 \d+일 경과/g;

function normalizeForDedup(commentText) {
  return (commentText || "").replace(VOLATILE_VERSIONING_DELAY_RE, "버저닝 지연 중");
}

function existingAuditComment(itemData, fieldId) {
  for (const field of itemData.customFields || []) {
    if (field.fieldId === fieldId) return field.value || "";
  }
  return "";
}

/**
 * record 하나(트래커 하나)의 감사 결과를 codebeamer CIL 아이템에 반영한다.
 * @returns {Promise<"updated"|"duplicate_skip"|"fetch_failed">}
 */
export async function pushRecordResult(client, record) {
  const itemId = record.cilId;
  const itemUrl = `https://codebeamer.slworld.com/cb/rest/v3/items/${itemId}`;
  const commentText = record.comment || "이상 없음";

  const choiceUpdates = {
    1016: record.saveRule ?? 1,
    1011: record.versionRule ?? 1,
    1012: record.docHistoryRule ?? 1,
    1013: record.statusRule ?? 1,
  };
  const isNgFound = Object.values(choiceUpdates).some((v) => v === 2);

  let itemData;
  try {
    itemData = await client.getJson(itemUrl);
  } catch (e) {
    console.error(`[${itemId}] 조회 실패:`, e);
    return "fetch_failed";
  }

  // 지난 감사와 사유(버전/날짜까지 포함한 코멘트 전문)가 완전히 같은 NG면, 이미 발행된 PR이
  // 아직 처리 중일 것이므로 중복 반영/재발행하지 않는다. 사유가 조금이라도 다르면 - 지금 이
  // 항목이 NG 상태로 남아있든 PR이 아직 안 닫혔든 상관없이 새 이슈로 보고 그대로 반영한다.
  const existingComment = existingAuditComment(itemData, FIELD_ID_AUDIT_COMMENT);
  if (isNgFound && normalizeForDedup(existingComment) === normalizeForDedup(commentText)) {
    return "duplicate_skip";
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
