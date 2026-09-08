// Python B_Audit_Data_Creation.py의 parse_baseline_data() + latest_baselines 구성 로직을
// 그대로 옮긴 것. 특히 "승인 스탬프 베이스라인은 설명이 보통 비어있으므로, 같은 버전의
// 비-승인 형제 베이스라인 설명으로 대신 채운다" 보정은 실데이터로 고친 부분이라 그대로
// 유지해야 한다 (자세한 설명은 사용자와의 검토 대화 참고).

import { stripTrailingQualifier } from "./wikiTable.js";

const VERSION_PATTERN = /_v\.?(\d+[.\d]*)$/;
const DATE_PATTERN = /(\d{6}\.\d+)$/;
const PR_IN_BASELINE_DESC_RE = /PR~-(\d+)/;
const CR_IN_BASELINE_DESC_RE = /CR~-(\d+)/;

/**
 * codebeamer 베이스라인 API 응답({"baselines": [...]})을 파싱한다.
 * @returns {Array<{baselineId, tracker, versionType, version, owner, description, createdAt, prId, crId}>}
 */
export function parseBaselineData(data) {
  const rows = [];
  for (const item of data.baselines || []) {
    const name = item.name || "";
    const description = item.description || "";

    // 베이스라인 이름 끝에 "(Approved)" 같은 주석이 붙어있으면 버전/날짜 숫자가 문자열
    // 맨 끝에 오지 않아 정규식이 매칭 안 되므로, 끝에 붙은 괄호 한정자를 떼고 매칭한다.
    const nameForMatch = stripTrailingQualifier(name);
    const vMatch = VERSION_PATTERN.exec(nameForMatch);
    const dMatch = DATE_PATTERN.exec(nameForMatch);

    // 뗀 한정자 안에 "approved"가 있으면, 이 베이스라인은 이미 승인이 끝난 버전이라는 뜻이다.
    const removedQualifier = name.slice(nameForMatch.length).toLowerCase();
    const isApprovedVersion = removedQualifier.includes("approved");

    let versionType = "Other";
    let versionVal = null;
    if (vMatch) {
      versionType = "Version Up";
      versionVal = vMatch[1];
    } else if (dMatch) {
      versionType = "Create Date";
      versionVal = dMatch[1];
    }

    if (isApprovedVersion && versionType !== "Other") {
      versionType += " (Approved)";
    }

    const prMatch = PR_IN_BASELINE_DESC_RE.exec(description);
    const crMatch = CR_IN_BASELINE_DESC_RE.exec(description);

    // parent가 있을 경우에만 추가: parent가 없는 것들은 실제 베이스라인이 아님
    if (item.parent) {
      rows.push({
        baselineId: item.parent.id,
        tracker: item.parent.name,
        versionType,
        version: versionVal,
        owner: item.owner ? item.owner.firstName : undefined,
        description,
        createdAt: item.createdAt,
        prId: prMatch ? Number(prMatch[1]) : null,
        crId: crMatch ? Number(crMatch[1]) : null,
      });
    }
  }
  return rows;
}

/**
 * 트래커별 "최신 베이스라인"을 구한다. 최신 것이 승인 스탬프(버전종류에 "Approved" 포함)면,
 * 같은 트래커·같은 버전번호의 비-승인 형제 베이스라인 설명으로 대신 채운다 - 승인 스탬프
 * 자체는 보통 설명이 비어있어서, 그대로 두면 실제로 작성된 변경이력을 못 보고 문서 이력
 * 기술 규칙이 잘못 NG로 잡히기 때문이다.
 *
 * @returns {Map<string, object>} 트래커명 -> 최신 베이스라인 행(설명은 위 보정이 적용된 상태)
 */
export function buildLatestBaselines(baselineRows) {
  const sorted = [...baselineRows].sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : -Infinity;
    const tb = b.createdAt ? Date.parse(b.createdAt) : -Infinity;
    return tb - ta; // createdAt 내림차순 (최신이 먼저)
  });

  const byTracker = new Map();
  for (const row of sorted) {
    if (!byTracker.has(row.tracker)) byTracker.set(row.tracker, { ...row });
  }

  for (const [trackerName, base] of byTracker) {
    if (!(base.versionType || "").includes("Approved")) continue;
    const sibling = sorted.find(
      (r) => r.tracker === trackerName && r.version === base.version && !(r.versionType || "").includes("Approved")
    );
    if (sibling) {
      base.description = sibling.description;
    }
  }

  return byTracker;
}
