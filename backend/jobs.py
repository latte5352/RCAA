"""A~E 스크립트를 백그라운드 스레드로 실행하고 진행 상황을 추적한다.

안전장치: Phase2(데이터 수집)+Phase3(감사 규칙 검사)까지만 먼저 돌리고 "awaiting_review"
상태로 멈춘다. 이 시점 결과(B_CM_Audit.xlsx)를 사람이 다운로드해서 확인한 뒤
approve_job()을 호출해야만 Phase4(codebeamer 실제 반영)+Phase5(PR 자동 채움)가 진행된다.
reject_job()을 부르면 그대로 취소되고 codebeamer에는 아무 것도 반영되지 않는다.

주의(TODO): B(Audit_Data_Creation) 단계는 아직 결과 xlsx를 프로젝트 루트 경로에
고정으로 저장한다(Path(__file__).parent 기준). job 실행 직후 job 전용 폴더로 옮겨서
이후 단계는 job별 경로를 쓰도록 처리했지만, B 자체가 쓰는 시점에는 아직 공용 경로라서
동시에 두 명이 Phase2를 실행하면 그 순간에는 서로 덮어쓸 수 있다. 다중 사용자를
지원하려면 B_Audit_Data_Creation.py의 to_excel 저장 경로도 파라미터로 받도록
리팩터링해야 한다.
"""
import importlib
import sys
import threading
import uuid
from pathlib import Path

import pandas as pd

import history

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

Phase2 = importlib.import_module("B_Audit_Data_Creation")
Phase3 = importlib.import_module("C_Audit")
Phase4 = importlib.import_module("D_Result_Update")
Phase5 = importlib.import_module("E_PR_Edit")

JOBS_DIR = Path(__file__).parent / "job_data"
JOBS_DIR.mkdir(exist_ok=True)

_jobs = {}
_lock = threading.Lock()


class JobError(Exception):
    pass


class JobNotFound(JobError):
    pass


def _set_status(job_id, **kwargs):
    with _lock:
        _jobs[job_id].update(kwargs)


def _job_dir(job_id):
    return JOBS_DIR / job_id


def _collect_and_audit(job_id, base_url, base_url_v3, username, password, project_name, tracker_cil, tracker_ncl, periodic_cadence, periodic_anchor):
    job_dir = _job_dir(job_id)
    job_dir.mkdir(parents=True, exist_ok=True)
    try:
        _set_status(job_id, status="collecting", step="데이터 수집", progress=15)
        Phase2.Audit_Data_Creation(
            base_url, base_url_v3, username, password, project_name, tracker_cil, tracker_ncl
        )
        for name in ("B_CM_Audit.xlsx", "B_CM_CIL.xlsx", "B_Unregistered.xlsx"):
            src = PROJECT_ROOT / name
            if src.exists():
                src.replace(job_dir / name)

        _set_status(job_id, step="감사 규칙 검사", progress=45)
        Phase3.run(str(job_dir / "B_CM_Audit.xlsx"), periodic_cadence, periodic_anchor)

        # 지난 감사 스냅샷과 비교(신규/변경 산출물 탐지). 호출과 동시에 스냅샷이 이번 결과로 갱신되므로
        # job당 정확히 한 번만 호출해야 한다.
        changes = history.diff_and_update(project_name, job_dir / "B_CM_Audit.xlsx")

        _set_status(
            job_id, status="awaiting_review", step="검토 대기 중 (codebeamer에는 아직 반영 안 됨)",
            progress=50, result_file=str(job_dir / "B_CM_Audit.xlsx"), changes=changes,
        )
    except Exception as e:
        _set_status(job_id, status="failed", error=str(e))


def _apply(job_id, base_url, username, password, tracker_cil, excluded_cil_ids=None):
    job_dir = _job_dir(job_id)
    try:
        _set_status(job_id, status="applying", step="codebeamer 결과 반영", progress=70)
        Phase4.NG_Update(
            base_url, username, password,
            audit_file=job_dir / "B_CM_Audit.xlsx",
            cil_file=job_dir / "B_CM_CIL.xlsx",
            excluded_cil_ids=excluded_cil_ids,
        )

        _set_status(job_id, step="PR 필드 자동 채움", progress=90)
        Phase5.run(username, password, tracker_cil)

        _set_status(job_id, status="done", step="완료", progress=100)
    except Exception as e:
        _set_status(job_id, status="failed", error=str(e))


def start_audit_job(base_url, base_url_v3, username, password, project_name, tracker_cil, tracker_ncl, periodic_cadence, periodic_anchor):
    job_id = str(uuid.uuid4())
    with _lock:
        _jobs[job_id] = {
            "status": "queued", "step": "대기 중", "progress": 0,
            "base_url": base_url, "tracker_cil": tracker_cil,
        }
    thread = threading.Thread(
        target=_collect_and_audit,
        args=(job_id, base_url, base_url_v3, username, password, project_name, tracker_cil, tracker_ncl, periodic_cadence, periodic_anchor),
        daemon=True,
    )
    thread.start()
    return job_id


def approve_job(job_id, username, password, excluded_cil_ids=None):
    job = get_job(job_id)
    if job is None:
        raise JobNotFound("job을 찾을 수 없습니다.")
    if job["status"] != "awaiting_review":
        raise JobError(f"검토 대기 상태가 아닙니다 (현재 상태: {job['status']}).")

    thread = threading.Thread(
        target=_apply,
        args=(job_id, job["base_url"], username, password, job["tracker_cil"], excluded_cil_ids),
        daemon=True,
    )
    thread.start()


def list_job_items(job_id):
    job = get_job(job_id)
    if job is None:
        raise JobNotFound("job을 찾을 수 없습니다.")
    if not job.get("result_file"):
        raise JobError(f"아직 검토할 결과가 없습니다 (현재 상태: {job['status']}).")
    job_dir = _job_dir(job_id)
    return Phase4.list_pending_updates(
        audit_file=job_dir / "B_CM_Audit.xlsx",
        cil_file=job_dir / "B_CM_CIL.xlsx",
    )


def list_unregistered_trackers(job_id):
    """프로젝트에는 존재하지만 Configuration Item List에 등록되지 않은 트래커 목록을 반환한다."""
    job = get_job(job_id)
    if job is None:
        raise JobNotFound("job을 찾을 수 없습니다.")
    if not job.get("result_file"):
        raise JobError(f"아직 검토할 결과가 없습니다 (현재 상태: {job['status']}).")
    unregistered_file = _job_dir(job_id) / "B_Unregistered.xlsx"
    if not unregistered_file.exists():
        return []
    df = pd.read_excel(unregistered_file)
    return [
        {
            "tracker_name": row["트래커명"],
            "tracker_uri": row["TRACKER_uri"] if pd.notna(row["TRACKER_uri"]) else None,
        }
        for _, row in df.iterrows()
    ]


def list_version_check_failures(job_id):
    """Approved 상태인데 Review Report에서 대상 버전을 자동으로 읽지 못한 항목을 반환한다."""
    job = get_job(job_id)
    if job is None:
        raise JobNotFound("job을 찾을 수 없습니다.")
    if not job.get("result_file"):
        raise JobError(f"아직 검토할 결과가 없습니다 (현재 상태: {job['status']}).")
    df = pd.read_excel(job["result_file"], sheet_name="판정불가")
    return [
        {
            "tracker_name": row["트래커명"] if pd.notna(row["트래커명"]) else "",
            "reason": row["사유"] if pd.notna(row["사유"]) else "",
        }
        for _, row in df.iterrows()
    ]


def get_job_changes(job_id):
    """지난 감사 대비 신규 등재 / 상태·버전 변경 산출물 목록을 반환한다."""
    job = get_job(job_id)
    if job is None:
        raise JobNotFound("job을 찾을 수 없습니다.")
    if not job.get("result_file"):
        raise JobError(f"아직 검토할 결과가 없습니다 (현재 상태: {job['status']}).")
    return job.get("changes", {"new_trackers": [], "changed_trackers": []})


def reject_job(job_id):
    job = get_job(job_id)
    if job is None:
        raise JobNotFound("job을 찾을 수 없습니다.")
    if job["status"] != "awaiting_review":
        raise JobError(f"검토 대기 상태가 아닙니다 (현재 상태: {job['status']}).")
    _set_status(job_id, status="cancelled", step="사용자가 취소함")


def get_job(job_id):
    with _lock:
        return _jobs.get(job_id)
