// codebeamer Wiki 표 파싱 + 이름 매칭/정규화 유틸리티.
// Python B_Audit_Data_Creation.py의 같은 이름 함수들을 1:1로 그대로 옮긴 것.
// 여기 있는 정규식/로직은 실데이터로 여러 번 고친 것들이라 함부로 바꾸지 말 것 -
// 바꿀 일이 생기면 원본 Python 쪽 이력(git log)도 같이 확인해서 옮길 것.

const TABLE_TOKEN_RE = /\[\{Table|\}\]/g;
const OPEN_TABLE_RE = /\[\{Table/g;
const TRAILING_QUALIFIER_RE = /(\s*\([^)]*\))+$/; // 이름 끝의 "(MCU)", "(AP)(BSP)" 같은 한정자
const PROCESS_TAG_RE = /^\[[A-Z]+\.\d+[A-Z]?\]/; // [SAF.2]Functional Safety Audit Report -> [SAF.2]
const VALUE_SPAN_RE = /%%\(color:rgb\([^)]*\)[^)]*\)([^%]+)%!/g;
const VERSION_FULLMATCH_RE = /^v?\d+(\.\d+)+$/i;
const DATE_FULLMATCH_RE = /^\d{6}$/;
const DATE_BASED_TRACKER_SUFFIXES = ["Test Result", "Review Result"];

/**
 * markerPos를 포함하는 최상위 [{Table ... }] 블록의 [시작, 끝] 인덱스를 찾는다.
 * 표 안에 표가 중첩된 경우(예: 대상 문서명 셀 안에 또 표가 있는 경우)까지 고려해
 * 괄호 깊이를 세어 정확한 끝 지점을 찾는다.
 * @returns {[number, number] | null}
 */
function findEnclosingTable(commentText, markerPos) {
  const before = commentText.slice(0, markerPos);
  OPEN_TABLE_RE.lastIndex = 0;
  let openPositions = [];
  let m;
  while ((m = OPEN_TABLE_RE.exec(before)) !== null) {
    openPositions.push(m.index);
  }
  if (openPositions.length === 0) return null;
  const tableStart = openPositions[openPositions.length - 1];

  let depth = 0;
  TABLE_TOKEN_RE.lastIndex = tableStart;
  let match;
  while ((match = TABLE_TOKEN_RE.exec(commentText)) !== null) {
    depth += match[0] === "[{Table" ? 1 : -1;
    if (depth === 0) {
      return [tableStart, match.index + match[0].length];
    }
  }
  return null; // 닫히지 않은 표 (형식 이상)
}

function stripProcessTag(name) {
  return (name || "").replace(PROCESS_TAG_RE, "").trim();
}

/** 이름 맨 앞의 프로세스 태그만 괄호 없이 뽑는다. "[SUP.8]Foo" -> "SUP.8", 없으면 "". */
function extractProcessTag(name) {
  const m = PROCESS_TAG_RE.exec(name || "");
  return m ? m[0].slice(1, -1) : "";
}

function stripTrailingQualifier(name) {
  return (name || "").replace(TRAILING_QUALIFIER_RE, "").trim();
}

/** 표 행 매칭용 정규화: 공백/하이픈/언더스코어 표기 차이는 무시하고 비교한다. */
function normalizeNameForRowMatch(name) {
  return (name || "").replace(/[\s\-_]+/g, "").toLowerCase();
}

/** 이름 끝의 "(MCU)", "(AP)" 같은 괄호 한정자는 무시하고 접미사 일치 여부를 확인한다. */
function nameEndsWith(name, suffix) {
  return stripTrailingQualifier(name).endsWith(suffix);
}

/**
 * name이 configuredNames(설정 파일에 등록된 "차종 코드 없는" 기준 이름들) 중 하나로 끝나는지
 * 확인해서, 일치한 설정값을 그대로 반환한다(없으면 null). 하드웨어/주기적 산출물/Review
 * Report 등 여러 트래커가 이름 앞에 차종 코드가 붙을 수 있어서("NQ6 Hardware PCB Package"),
 * 설정과 완전히 똑같은 이름인지가 아니라 그 이름으로 "끝나는지"로 비교해야 차종 코드 유무와
 * 무관하게 항상 같은 트래커로 인식된다 - 이 매칭 방식은 여러 규칙에서 공통으로 써야 서로
 * 일관성이 깨지지 않는다.
 */
function matchConfiguredSuffix(name, configuredNames) {
  const pure = name || "";
  return configuredNames.find((n) => pure.endsWith(n)) || null;
}

function isDateBasedTracker(trackerNameRaw) {
  const pureName = stripProcessTag(trackerNameRaw);
  return DATE_BASED_TRACKER_SUFFIXES.some((suffix) => nameEndsWith(pureName, suffix));
}

// 표의 %% 인라인 스팬 대신, 셀 자체에 스타일을 입히는 문법("|(색상 등 스타일...)내용" 한
// 줄이 셀 하나, "|<"는 왼쪽 셀이 옆으로 병합된(colspan) 빈 칸)만 쓰는 표도 실제로 있다(예:
// "|(color:black;...)v1.6" - %% 스팬 없이 셀 스타일 파라미터로만 색을 줌). 빈 줄로 행(row)이
// 구분되므로, 빈 줄 단위로 나눈 뒤 각 줄을 셀로 파싱해서 "이름 칼럼들 + 마지막 버전 칼럼"
// 형태로 다시 조립한다. extractTargetVersionFromComment가 %% 스팬으로 못 찾았을 때만
// 보조로 시도한다(기존에 이미 %%로 되던 표는 그대로 두고, 이 표기법만 쓰는 표를 추가 대응).
function extractTargetVersionFromCellStyledTable(section, targetNorm) {
  const rows = section.split(/\r?\n\s*\r?\n/);
  for (const row of rows) {
    const cells = [];
    for (const rawLine of row.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("|")) continue;
      if (/^\|<\s*$/.test(line)) continue; // 병합된 빈 칸 - 새 셀 아님
      const m = /^\|(?:\([^)]*\))?(.*)$/.exec(line);
      if (!m) continue;
      // 표의 마지막 셀은 줄바꿈 없이 표 닫는 토큰("}]")이 바로 이어 붙기도 한다(예: "v1.6}]") -
      // 그것도 뒤쪽 백슬래시 이어붙이기 표시와 같이 떼어낸다.
      cells.push(m[1].replace(/(?:\\+|\}\])+\s*$/, "").trim());
    }
    if (cells.length < 2) continue;
    const nameText = cells.slice(0, -1).join(" ");
    if (!normalizeNameForRowMatch(nameText).includes(targetNorm)) continue;
    const value = cells[cells.length - 1].trim();
    if (VERSION_FULLMATCH_RE.test(value) || DATE_FULLMATCH_RE.test(value)) {
      return { value: value.replace(/^[vV]+/, ""), failReason: null };
    }
    return { value: null, failReason: `'${value}' 형식을 인식하지 못함` };
  }
  return null; // 이 표에서는 못 찾음 - 호출부가 기존 실패 사유로 처리
}

/**
 * Review Report PA 아이템의 코멘트(자유 텍스트 Wiki 표)에서 "리뷰 대상 문서명" 표에 적힌
 * trackerName과 같은 행(row)의 값(버전, 또는 Test Result의 경우 대상 완료일 YYMMDD 6자리)을
 * 추출한다. 하나의 Review Report가 대상 산출물을 2개 이상(예: Test Result 실행 결과 + 별도
 * Test Report 문서) 같이 다루는 경우가 있어서, 표에 적힌 값 아무거나 줍는 게 아니라 행 단위로
 * 문서명을 매칭해 정확히 짝을 맞춰야 한다.
 *
 * @returns {{value: string|null, failReason: string|null}}
 */
const RAW_SNIPPET_MAX_LEN = 600;
function truncateSnippet(text) {
  return text.length > RAW_SNIPPET_MAX_LEN ? `${text.slice(0, RAW_SNIPPET_MAX_LEN)} …(생략)` : text;
}

function extractTargetVersionFromComment(commentText, trackerName) {
  // 판정 불가로 끝날 때, 그 원인이 된 원본 위키 마크업 일부를 같이 실어 보낸다("🔍 리뷰 대상
  // 버전 자동 확인 불가" 안내에 표시됨) - 이 정규식들이 못 알아본 새로운 표 형식이 또 나왔을 때,
  // codebeamer REST API를 따로 조회하지 않고도 화면에서 바로 원인을 확인할 수 있게 하기 위함.
  const fail = (reason, snippetSource) => ({
    value: null,
    failReason: reason,
    rawSnippet: snippetSource ? truncateSnippet(snippetSource) : undefined,
  });

  if (!commentText) {
    return fail("리뷰 코멘트가 비어있음");
  }

  // 표 제목이 "리뷰 대상 문서명"/"리뷰 대상 문서"/"리뷰 대상" 등 작성자마다 수기로 다르게
  // 적혀있어서, 정확한 문구 대신 공통으로 들어가는 "대상"만 찾는다. 자유 텍스트 중에 "대상"이
  // 표 밖에서 먼저 나올 수도 있으니, 표([{Table ... }]) 안에 있는 것을 찾을 때까지 등장 위치를
  // 순서대로 시도한다.
  const markerPositions = [];
  const markerRe = /대상/g;
  let mm;
  while ((mm = markerRe.exec(commentText)) !== null) {
    markerPositions.push(mm.index);
  }
  if (markerPositions.length === 0) {
    return fail("'대상' 표를 찾을 수 없음", commentText);
  }

  let tableBounds = null;
  for (const pos of markerPositions) {
    tableBounds = findEnclosingTable(commentText, pos);
    if (tableBounds !== null) break;
  }
  if (tableBounds === null) {
    return fail("표 구조를 인식하지 못함", commentText.slice(markerPositions[0]));
  }
  const section = commentText.slice(tableBounds[0], tableBounds[1]);

  const targetNorm = normalizeNameForRowMatch(stripTrailingQualifier(stripProcessTag(trackerName)));
  if (!targetNorm) {
    return fail("대상 트래커명을 알 수 없음", section);
  }

  // codebeamer Wiki 서식: %%(color:rgb(r,g,b);...)내용%! 형태로 셀 내용(버전/날짜)만 색이
  // 입혀져 있고, 문서명은 그 앞에 일반 텍스트로 적혀있다 (표 한 행 = 문서명 + 색 입힌 값)
  VALUE_SPAN_RE.lastIndex = 0;
  const valueSpans = [...section.matchAll(VALUE_SPAN_RE)];
  if (valueSpans.length > 0) {
    let prevEnd = 0;
    for (const m of valueSpans) {
      const nameChunk = section.slice(prevEnd, m.index);
      prevEnd = m.index + m[0].length;
      if (normalizeNameForRowMatch(nameChunk).includes(targetNorm)) {
        // Python의 .strip().strip("\\").strip()과 동일: 양끝 공백 -> 양끝 백슬래시 -> 양끝 공백
        let value = m[1].trim().replace(/^\\+/, "").replace(/\\+$/, "").trim();
        if (VERSION_FULLMATCH_RE.test(value) || DATE_FULLMATCH_RE.test(value)) {
          return { value: value.replace(/^[vV]+/, ""), failReason: null };
        }
        return fail(`'${value}' 형식을 인식하지 못함`, section);
      }
    }
  }

  // %% 스팬 방식으로 못 찾았으면(스팬 자체가 없거나, 있어도 우리 산출물 행이 아니면), 셀
  // 자체에 스타일을 입히는 표 문법으로 한 번 더 시도한다(extractTargetVersionFromCellStyledTable
  // 참고 - 실제로 이 표기법만 쓰는 표가 있어서 추가함).
  const cellStyledResult = extractTargetVersionFromCellStyledTable(section, targetNorm);
  if (cellStyledResult) {
    return cellStyledResult.failReason ? fail(cellStyledResult.failReason, section) : cellStyledResult;
  }

  if (valueSpans.length === 0) {
    return fail("버전(또는 날짜) 값을 인식하지 못함", section);
  }
  return fail("표에서 이 산출물과 일치하는 행을 찾지 못함", section);
}

/** codebeamer의 ISO 8601 날짜/시각 문자열을 YYMMDD 6자리로 변환한다 (문자열의 날짜 부분을 그대로
 * 씀 - 타임존 변환을 하지 않아, Date 객체를 거치는 것보다 원본 Python의 동작과 정확히 일치한다). */
function toYYMMDD(isoDatetimeStr) {
  if (!isoDatetimeStr) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDatetimeStr);
  if (!m) return "";
  return m[1].slice(2) + m[2] + m[3];
}

export {
  findEnclosingTable,
  stripProcessTag,
  extractProcessTag,
  stripTrailingQualifier,
  normalizeNameForRowMatch,
  nameEndsWith,
  matchConfiguredSuffix,
  isDateBasedTracker,
  extractTargetVersionFromComment,
  toYYMMDD,
};
