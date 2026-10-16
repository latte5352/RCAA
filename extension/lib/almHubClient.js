// ALM Hub(사내 별도 사이트)의 SUP.8 탭 "수기 입력(Handwriting)" 칸에 형상 감사 보고서를 자동으로
// 써주는 클라이언트. 브라우저 Network 탭으로 실제 호출을 하나씩 캡처해서 역공학한 것 - 문서화된
// API가 아니라서 ALM Hub가 바뀌면 언제든 깨질 수 있다.
//
// 흐름: 로그인(codebeamer와 같은 계정/비밀번호를 그대로 재사용) -> 프로젝트 목록 조회해서
// 이름으로 projectId 찾기 -> 그 프로젝트의 SUP.8 대시보드 조회(지금 revision/칸 위치 확인) ->
// 수기 입력 칸에 쓰기. "쓰기" 직전에 조회한 dashboardRevision이 그 사이에 바뀌면(동시 편집 등)
// 서버가 충돌로 거부할 수 있어서, 조회+쓰기 묶음을 통째로 한 번 더 재시도한다.

const BASE_URL = "https://api-almhub.slworld.com/api";
const PROCESS_ID = "SUP.8";
const CHART_KEY = "HANDWRITING";
// 사용자도 이 값이 프로젝트/차종마다 달라지는지 몰라서 일단 유일하게 확인된 값으로 고정한다 -
// 나중에 "COMMON"이 아닌 값이 필요한 경우가 확인되면 그때 가변으로 바꾼다.
const DIVISION = "COMMON";

async function postJson(path, body, token) {
  const resp = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error((json && json.msg) || `요청 실패 (상태 코드 ${resp.status})`);
  }
  return json;
}

async function getJson(path, token) {
  const resp = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error((json && json.msg) || `요청 실패 (상태 코드 ${resp.status})`);
  }
  return json;
}

async function almHubLogin(username, password) {
  const json = await postJson("/auth/login", { username, password });
  const token = json && json.data && json.data.token;
  if (!token) throw new Error("ALM Hub 로그인 응답에서 토큰을 찾지 못함");
  return token;
}

async function fetchAlmHubProjects(token) {
  const json = await getJson("/cb/chart/projects?includeHidden=true", token);
  return json.data || [];
}

async function fetchAlmHubDashboard(token, projectId, processId) {
  // 캐시로 인해 방금 반영한 내용이 바로 안 보일 수 있지만(실제 쓰기 자체엔 영향 없음),
  // _t 캐시버스터는 사이트 자체도 쓰는 관례라 그대로 맞춘다.
  const json = await getJson(`/cb/chart/dashboard/${projectId}/${encodeURIComponent(processId)}?_t=${Date.now()}`, token);
  return json.data;
}

async function submitHandwriting(token, payload) {
  return postJson("/cb/chart/handwriting", payload, token);
}

/**
 * codebeamer 프로젝트명으로 ALM Hub의 SUP.8 수기 입력 칸에 제목/내용을 써넣는다.
 * @param {{username:string, password:string, projectName:string, title:string, contentHtml:string}} params
 * @returns {Promise<void>} 실패하면 에러를 던진다(한 번 조회+쓰기를 재시도한 뒤에도 실패한 경우).
 */
export async function submitConfigReportToAlmHub({ username, password, projectName, title, contentHtml }) {
  const token = await almHubLogin(username, password);

  const projects = await fetchAlmHubProjects(token);
  const project = projects.find((p) => p.projectName === projectName);
  if (!project) {
    throw new Error(`ALM Hub에서 같은 이름의 프로젝트를 찾지 못함: ${projectName}`);
  }

  const MAX_ATTEMPTS = 2;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const dashboard = await fetchAlmHubDashboard(token, project.projectId, PROCESS_ID);
      const handwritingChart = (dashboard.chartBundles || []).find((c) => c.chartKey === CHART_KEY);

      await submitHandwriting(token, {
        expectedRevision: dashboard.dashboardRevision,
        projectId: project.projectId,
        processId: PROCESS_ID,
        chartKey: CHART_KEY,
        division: DIVISION,
        title,
        content: contentHtml,
        gridX: handwritingChart ? handwritingChart.gridX : 0,
        gridY: handwritingChart ? handwritingChart.gridY : 0,
        width: handwritingChart ? handwritingChart.width : 1,
        height: handwritingChart ? handwritingChart.height : 1,
      });
      return;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}
