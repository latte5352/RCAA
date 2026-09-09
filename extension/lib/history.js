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

async function saveSnapshot(projectName, snapshot) {
  await chrome.storage.local.set({ [historyKey(projectName)]: snapshot });
}

function extractCurrentSnapshot(records) {
  const snapshot = {};
  for (const r of records) {
    if (!r.trackerName) continue;
    snapshot[r.trackerName] = { status: r.status || null, version: r.currentVersion || null };
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
  const current = extractCurrentSnapshot(records);

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
