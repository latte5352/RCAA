// codebeamer 프로젝트 멤버 화면(cb/project/{key}/members)이 내부적으로 쓰는 비공식 엔드포인트
// (cb/proj/getMembers.spr)의 HTML 응답을 파싱해서, 로그인한 계정이 그 프로젝트에서 특정
// 역할(예: CM)을 갖고 있는지 확인한다. 정식 REST API(cb/rest, cb/api/v3)가 아니라 화면
// 렌더링용 내부 엔드포인트라서 codebeamer가 업데이트되면 파싱이 깨질 수 있고, Basic Auth로
// 인증되는지도 검증되지 않았다(브라우저 세션 쿠키 기반으로만 동작한다면 이 방식 자체가 안 통함) -
// 그래서 실패해도 조용히 "판단 불가"로 처리하고, 절대 감사/반영을 막지 않는다(경고용 정보일 뿐).

import { mapWithConcurrency } from "./codebeamerClient.js";

function parseMemberRoleRows(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows = doc.querySelectorAll("table#member tbody tr");
  const result = [];
  for (const row of rows) {
    const nameCell = row.querySelector("td.nameColumn a");
    const username = (nameCell ? nameCell.textContent : "").trim();
    if (!username) continue;
    const roleNames = Array.from(row.querySelectorAll(".rolesColumn .role"))
      .map((el) => el.textContent.trim())
      .filter(Boolean);
    result.push({ username, roleNames });
  }
  return result;
}

/**
 * @returns {Promise<{found: boolean, hasRole: boolean|null, error: string|null}>}
 * - error가 있으면 조회 자체가 실패한 것(엔드포인트 호환 문제일 수 있음) - hasRole은 null.
 * - found=false면 페이지를 끝까지 넘겨봐도 이 계정을 멤버 목록에서 못 찾은 것 - hasRole은 null.
 * - found=true일 때만 hasRole(boolean)이 실제 판정값이다.
 */
export async function checkUserProjectRole(client, { projBaseUrl, projectId, username, roleName, maxPages = 20 }) {
  const targetUsername = (username || "").trim().toLowerCase();
  if (!targetUsername || !projectId) {
    return { found: false, hasRole: null, error: null };
  }

  for (let page = 1; page <= maxPages; page += 1) {
    // 안전장치: 응답 형식이 예상과 달라 무한 루프에 빠지지 않도록 페이지 상한을 둔다.
    const url = `${projBaseUrl}/getMembers.spr?projectId=${projectId}&page=${page}&filter=&statusId=3&_=${Date.now()}`;
    const resp = await client.getTextSoft(url);
    if (!resp.ok) {
      return { found: false, hasRole: null, error: `조회 실패 (상태 코드 ${resp.status ?? "알 수 없음"})` };
    }

    let rows;
    try {
      rows = parseMemberRoleRows(resp.text);
    } catch (e) {
      return { found: false, hasRole: null, error: "응답을 해석하지 못함" };
    }
    if (rows.length === 0) break;

    const match = rows.find((r) => r.username.toLowerCase() === targetUsername);
    if (match) {
      return { found: true, hasRole: match.roleNames.includes(roleName), error: null };
    }
  }

  return { found: false, hasRole: null, error: null };
}

/**
 * 프로젝트 목록 중 로그인 계정이 특정 역할(예: CM)을 확실히 갖고 있지 않다고 판정된 것만 뺀다.
 * - 판단이 애매한 경우(조회 실패, 멤버 목록에서 계정을 못 찾음)는 절대 빼지 않는다 - 이 비공식
 *   엔드포인트가 안 맞는 환경이면 하나도 못 걸러도 그만이지, 잘못 걸러서 실제 접근 가능한
 *   프로젝트까지 감춰버리면 안 되기 때문이다.
 * - 조회 자체가 하나라도 명확히 실패하면(엔드포인트 호환 문제 가능성) 필터링을 통째로
 *   포기하고 원래 목록을 그대로 돌려준다.
 * - 프로젝트가 많을 때 너무 오래 걸리지 않도록 프로젝트당 조회 페이지 수(maxPagesPerProject)를
 *   적게 잡는다 - 그 안에서 못 찾으면 "판단 불가"로 보고 그냥 남겨둔다(위 원칙과 일관됨).
 * @returns {Promise<{projects: Array, filtered: boolean, hiddenCount: number}>}
 */
export async function filterProjectsByRole(client, {
  projBaseUrl, projects, username, roleName, concurrency = 6, maxPagesPerProject = 5,
}) {
  let sawError = false;

  const checked = await mapWithConcurrency(projects, concurrency, async (project) => {
    const projectId = (project.uri || "").split("/").filter(Boolean).pop();
    const result = await checkUserProjectRole(client, {
      projBaseUrl, projectId, username, roleName, maxPages: maxPagesPerProject,
    });
    if (result.error) sawError = true;
    return { project, result };
  });

  if (sawError) {
    return { projects, filtered: false, hiddenCount: 0 };
  }

  const kept = checked
    .filter(({ result }) => !(result.found && result.hasRole === false))
    .map(({ project }) => project);

  return { projects: kept, filtered: true, hiddenCount: projects.length - kept.length };
}
