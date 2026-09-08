// 원본 backend/auth.py의 list_projects()를 그대로 옮긴 것.

/** 로그인한 계정이 접근 가능한 프로젝트 목록을 전부 페이지네이션으로 가져온다. */
export async function listProjects(client) {
  const projects = [];
  let page = 1;
  while (page <= 50) {
    // 안전장치: 비정상 응답으로 무한루프에 빠지지 않도록 상한
    const resp = await client.getJsonSoft(`${client.baseUrl}/projects/page/${page}`);
    if (!resp.ok) break;
    const pageProjects = (resp.json && resp.json.projects) || [];
    if (pageProjects.length === 0) break;
    projects.push(...pageProjects);
    page += 1;
  }
  return projects.map((p) => ({ name: p.name, uri: p.uri }));
}

/** codebeamer 로그인 자격 증명이 유효한지 확인한다 (프로젝트 1페이지 조회로 검증). */
export async function verifyLogin(client) {
  const resp = await client.getJsonSoft(`${client.baseUrl}/projects/page/1`);
  return resp.ok;
}
