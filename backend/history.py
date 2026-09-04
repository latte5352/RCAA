"""프로젝트별 직전 감사 스냅샷을 저장하고, 이번 감사 결과와 비교해
새로 등재된 산출물 / 상태·버전이 바뀐 산출물을 찾아낸다.

diff_and_update()는 호출할 때마다 스냅샷을 이번 결과로 덮어쓰므로, 한 job당 정확히
한 번만 호출해야 한다 (반복 호출하면 두 번째부터는 항상 "변경 없음"이 된다).
"""
import json
from pathlib import Path

import pandas as pd

HISTORY_DIR = Path(__file__).parent / "history_data"
HISTORY_DIR.mkdir(exist_ok=True)


def _history_file(project_name: str) -> Path:
    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in project_name)
    return HISTORY_DIR / f"{safe_name}.json"


def _load_snapshot(project_name: str) -> dict:
    path = _history_file(project_name)
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _save_snapshot(project_name: str, snapshot: dict):
    with _history_file(project_name).open("w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False, indent=2)


def _extract_current_snapshot(detail_xlsx_path: Path) -> dict:
    df = pd.read_excel(detail_xlsx_path, sheet_name="데이터")
    snapshot = {}
    for _, row in df.iterrows():
        name = row.get("트래커명")
        if pd.isna(name) or not str(name).strip():
            continue
        status = row.get("현재 상태")
        version = row.get("현재 버전")
        snapshot[str(name)] = {
            "status": None if pd.isna(status) else str(status),
            "version": None if pd.isna(version) else str(version),
        }
    return snapshot


def diff_and_update(project_name: str, detail_xlsx_path: Path) -> dict:
    """직전 스냅샷과 비교해 신규/변경 목록을 반환하고, 스냅샷을 이번 결과로 갱신한다."""
    previous = _load_snapshot(project_name)
    current = _extract_current_snapshot(detail_xlsx_path)

    new_trackers = sorted(name for name in current if name not in previous)

    changed_trackers = []
    for name, cur in current.items():
        prev = previous.get(name)
        if prev is None:
            continue
        if prev.get("status") != cur.get("status") or prev.get("version") != cur.get("version"):
            changed_trackers.append({
                "tracker_name": name,
                "previous_status": prev.get("status"),
                "current_status": cur.get("status"),
                "previous_version": prev.get("version"),
                "current_version": cur.get("version"),
            })
    changed_trackers.sort(key=lambda x: x["tracker_name"])

    _save_snapshot(project_name, current)

    return {"new_trackers": new_trackers, "changed_trackers": changed_trackers}
