// codebeamer REST API 클라이언트. 서버 없이 확장이 직접 codebeamer에 붙는다 - Basic Auth
// 헤더를 매 요청에 실어 보낸다. host_permissions에 codebeamer 도메인이 있어야
// (manifest.json 참고) 브라우저가 CORS 없이 요청을 통과시켜준다.

export function createClient({ baseUrl, baseUrlV3, username, password }) {
  const authHeader = "Basic " + btoa(unescape(encodeURIComponent(`${username}:${password}`)));
  const headers = { Authorization: authHeader, Accept: "application/json" };

  async function getJson(url) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const err = new Error(`조회 실패 (상태 코드 ${res.status}): ${url}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /** 실패해도 예외를 던지지 않고 {ok, status, json} 형태로 반환한다 (선택적 조회용). */
  async function getJsonSoft(url) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) return { ok: false, status: res.status, json: null };
      return { ok: true, status: res.status, json: await res.json() };
    } catch (e) {
      return { ok: false, status: null, json: null };
    }
  }

  async function putJson(url, body) {
    const res = await fetch(url, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = new Error(`반영 실패 (상태 코드 ${res.status}): ${url}`);
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /**
   * codebeamer의 /items류 엔드포인트는 기본 페이지 크기(관측상 500)로 페이지네이션되어 있어서,
   * 한 번만 조회하면 그보다 많은 트래커에서 조용히 잘린다. 빈 페이지가 나올 때까지 전부 모은다.
   * 중간 페이지 요청이 실패하면 그때까지 모은 것만 반환하되 incomplete=true를 같이 반환한다.
   */
  async function fetchAllItems(itemsUrl) {
    const allItems = [];
    let page = 1;
    let incomplete = false;
    while (page <= 200) {
      // 안전장치: 비정상 응답으로 무한루프에 빠지지 않도록 상한
      let res;
      try {
        res = await fetch(`${itemsUrl}/page/${page}`, { headers });
      } catch (e) {
        incomplete = true;
        break;
      }
      if (!res.ok) {
        incomplete = true;
        break;
      }
      const data = await res.json();
      const pageItems = data.items || [];
      if (pageItems.length === 0) break;
      allItems.push(...pageItems);
      page += 1;
    }
    return { items: allItems, incomplete };
  }

  return { baseUrl, baseUrlV3, getJson, getJsonSoft, putJson, fetchAllItems };
}

/**
 * 동시 실행 개수를 제한하며 배열의 각 항목에 비동기 함수를 적용한다.
 * Python ThreadPoolExecutor(max_workers=N) 상당 - codebeamer에 한 번에 너무 많은 요청을
 * 동시에 쏘지 않기 위함.
 */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
