"""SUP.8 형상감사 자동화 백엔드 API.

브라우저 확장은 이 서버로만 통신한다. codebeamer 자격증명은 /api/login에서
1회만 검증되고 세션ID로 치환되며, 그 이후 요청은 전부 세션ID만 주고받는다.

실행: uvicorn app:app --reload --port 8000  (backend 폴더에서)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

import auth
import jobs
import config

app = FastAPI(title="SUP.8 형상감사 자동화 API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 배포 시에는 실제 확장 ID(chrome-extension://<id>)로 제한할 것
    allow_methods=["*"],
    allow_headers=["*"],
)


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    session_id: str


class LogoutRequest(BaseModel):
    session_id: str


class ApproveRequest(BaseModel):
    session_id: str
    excluded_cil_ids: list[int] = []


class StartAuditRequest(BaseModel):
    session_id: str
    project_name: str = config.CB_PROJECT_NAME
    tracker_cil: str = config.TRACKER_NAME_CIL
    tracker_ncl: str = config.TRACKER_NAME_NCL
    periodic_cadence: str = "biweekly"  # "weekly" | "biweekly" | "monthly"
    periodic_anchor: int = 0  # weekly/biweekly: 요일(0=월~6=일), monthly: 일자(1~31)


@app.post("/api/login", response_model=LoginResponse)
def login(req: LoginRequest):
    try:
        session_id = auth.login(config.BASE_URL, req.username, req.password)
    except auth.AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    return LoginResponse(session_id=session_id)


@app.post("/api/logout")
def logout(req: LogoutRequest):
    auth.logout(req.session_id)
    return {"ok": True}


@app.get("/api/projects")
def list_projects(session_id: str):
    try:
        username, password = auth.get_credentials(session_id)
    except auth.AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    return {"projects": auth.list_projects(config.BASE_URL, username, password)}


@app.post("/api/audit-jobs")
def start_audit(req: StartAuditRequest):
    try:
        username, password = auth.get_credentials(req.session_id)
    except auth.AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))

    job_id = jobs.start_audit_job(
        config.BASE_URL, config.BASE_URL_V3, username, password,
        req.project_name, req.tracker_cil, req.tracker_ncl,
        req.periodic_cadence, req.periodic_anchor,
    )
    return {"job_id": job_id}


@app.get("/api/audit-jobs/{job_id}")
def get_audit_job(job_id: str):
    job = jobs.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job을 찾을 수 없습니다.")
    return job


@app.get("/api/audit-jobs/{job_id}/download")
def download_audit_result(job_id: str):
    job = jobs.get_job(job_id)
    if job is None or not job.get("result_file"):
        raise HTTPException(status_code=404, detail="결과 파일이 아직 없습니다.")
    return FileResponse(
        job["result_file"],
        filename="B_CM_Audit.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@app.get("/api/audit-jobs/{job_id}/items")
def get_audit_job_items(job_id: str):
    try:
        return {"items": jobs.list_job_items(job_id)}
    except jobs.JobNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except jobs.JobError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.get("/api/audit-jobs/{job_id}/unregistered")
def get_unregistered_trackers(job_id: str):
    try:
        return {"trackers": jobs.list_unregistered_trackers(job_id)}
    except jobs.JobNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except jobs.JobError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.get("/api/audit-jobs/{job_id}/version-check-failures")
def get_version_check_failures(job_id: str):
    try:
        return {"failures": jobs.list_version_check_failures(job_id)}
    except jobs.JobNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except jobs.JobError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.get("/api/audit-jobs/{job_id}/changes")
def get_audit_job_changes(job_id: str):
    try:
        return jobs.get_job_changes(job_id)
    except jobs.JobNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except jobs.JobError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.post("/api/audit-jobs/{job_id}/approve")
def approve_audit_job(job_id: str, req: ApproveRequest):
    try:
        username, password = auth.get_credentials(req.session_id)
    except auth.AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    try:
        jobs.approve_job(job_id, username, password, excluded_cil_ids=req.excluded_cil_ids)
    except jobs.JobNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except jobs.JobError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"ok": True}


@app.post("/api/audit-jobs/{job_id}/reject")
def reject_audit_job(job_id: str):
    try:
        jobs.reject_job(job_id)
    except jobs.JobNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except jobs.JobError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"ok": True}
