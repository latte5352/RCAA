// 원본 backend/history.py를 그대로 옮긴 것. 서버 디스크 대신 이 브라우저의
// chrome.storage.local에 프로젝트별 스냅샷을 저장한다 (이 컴퓨터에만 남음 - 여러 명이 같은
// 프로젝트를 감사하면 "지난 감사" 기준이 사람마다 다를 수 있다는 한계는 원본과 달리
// 서버리스 구조상 어쩔 수 없이 생기는 부분이다).

function historyKey(projectName) {
  return `history_snapshot_${projectName}`;
}

async function loadSnapshot(projectName) {
  const key = historyKey(projectName);
  const stored = await chrome.storage.local.get(key);
  return stored[key] || {};
}

/**
 * 직전 스냅샷을 읽기만 한다(diffAndUpdateHistory와 달리 갱신하지 않음) - 문서 이력 PR 기재
 * 확인을 위해, 감사 데이터 수집 시작 전에 "이 트래커를 마지막으로 확인해서 문제없었던 버전이
 * 뭐였는지"(docHistoryCheckedVersion) 미리 알아야 하는 곳(collector.js)에서 쓴다.
 * @returns {Promise<Object<string, {status, version, docHistoryCheckedVersion}>>}
 */
export async function loadHistorySnapshot(projectName) {
  return loadSnapshot(projectName);
}

async function saveSnapshot(projectName, snapshot) {
  await chrome.storage.local.set({ [historyKey(projectName)]: snapshot });
}

// 트래커명으로 직전 스냅샷 항목을 못 찾으면(트래커명이 바뀐 경우 - 오타 수정, 차종 코드
// 추가 등) 트래커 ID(코드비머 URI에서 뽑은 고유값, 이름과 달리 이름이 바뀌어도 안 변함)로
// 다시 찾는다 - 안 그러면 이름만 바뀌었을 뿐인데 "체크포인트 없음"으로 취급돼, 문서 이력
// 규칙이 이미 확인 끝난 예전 버전들까지 다시 훑거나(최신 것 하나만 보는 폴백에 걸려)
// 그사이의 실제 문제를 놓치고 지나칠 수 있다. 예전에 저장된 스냅샷엔 trackerId가 없을 수도
// 있는데(이 필드가 생기기 전에 저장된 것), 그런 항목은 그냥 매칭 대상에서 자연히 제외된다.
function findPreviousEntry(previous, r) {
  const direct = previous[r.trackerName];
  if (direct) return direct;
  if (!r.trackerId) return null;
  for (const entry of Object.values(previous)) {
    if (entry.trackerId && entry.trackerId === r.trackerId) return entry;
  }
  return null;
}

// docHistoryCheckedVersion: "문서 이력에 PR 기재가 빠진 게 없다고 마지막으로 확인된 버전".
// 이번에 문제가 없었으면(record.docHistoryManualCheckReason이 없으면) 지금 버전까지 전진시키고,
// 문제가 있었으면 그대로 둬서 - 고쳐지기 전까지는 다음 감사에서도 같은 지점부터 다시 확인해
// "직접 확인 필요" 목록에 계속 뜨게 한다(한 번 알려주고 조용히 사라지는 것을 막기 위함).
function extractCurrentSnapshot(records, previous) {
  const snapshot = {};
  for (const r of records) {
    if (!r.trackerName) continue;
    const prevEntry = findPreviousEntry(previous, r) || {};
    const docHistoryCheckedVersion = r.docHistoryManualCheckReason
      ? prevEntry.docHistoryCheckedVersion ?? null
      : r.currentVersion || null;
    snapshot[r.trackerName] = {
      status: r.status || null,
      version: r.currentVersion || null,
      docHistoryCheckedVersion,
      trackerId: r.trackerId || null,
    };
  }
  return snapshot;
}

/**
 * 직전 스냅샷과 비교해 신규/변경 목록을 반환하고, 스냅샷을 이번 결과로 갱신한다.
 * job(감사 실행)당 정확히 한 번만 호출해야 한다 (반복 호출하면 두 번째부터는 항상 "변경 없음").
 *
 * records가 프로젝트의 트래커 전체가 아니라 일부(특정 트래커만 골라 감사한 경우)여도 안전하도록,
 * 스냅샷은 통째로 교체하지 않고 이번에 감사한 트래커분만 병합해 덮어쓴다 - 그래야 감사하지
 * 않은 나머지 트래커의 "지난 감사" 기준이 다음 전체 감사 때까지 사라지지 않는다.
 */
export async function diffAndUpdateHistory(projectName, records) {
  const previous = await loadSnapshot(projectName);
  const current = extractCurrentSnapshot(records, previous);

  const newTrackers = Object.keys(current)
    .filter((name) => !(name in previous))
    .sort();

  const changedTrackers = [];
  for (const [name, cur] of Object.entries(current)) {
    const prev = previous[name];
    if (!prev) continue;
    if (prev.status !== cur.status || prev.version !== cur.version) {
      changedTrackers.push({
        trackerName: name,
        previousStatus: prev.status,
        currentStatus: cur.status,
        previousVersion: prev.version,
        currentVersion: cur.version,
      });
    }
  }
  changedTrackers.sort((a, b) => a.trackerName.localeCompare(b.trackerName));

  await saveSnapshot(projectName, { ...previous, ...current });

  return { newTrackers, changedTrackers };
}
