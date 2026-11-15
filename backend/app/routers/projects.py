import json
import os
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, Header, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import models, security
from ..projects_storage import copy_project_data, frame_image, get_or_create_data, video_file
from ..database import get_db
from ..envelope import ApiError, envelope, envelope_list
from ..schemas import (
    ProjectCreateRequest,
    ProjectDuplicateRequest,
    ProjectPatchRequest,
    ProjectRestoreRequest,
    ProjectSummary,
)

router = APIRouter(prefix="/api/v1/projects", tags=["projects"])


def _get_owned_project(db: Session, user: models.User, project_id: str, *, include_deleted: bool = False) -> models.Project:
    project = db.get(models.Project, project_id)

    if not project or project.user_id != user.id or (not include_deleted and project.deleted_at is not None):
        raise ApiError(404, "RESOURCE_NOT_FOUND", "프로젝트를 찾을 수 없습니다.")

    return project


@router.get("")
def list_projects(
    query: str = "",
    sort: str = "updated",
    order: str | None = None,
    status: list[str] | None = Query(default=None),
    starred: bool | None = None,
    page: int = 1,
    page_size: int = 20,
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    if page < 1:
        raise ApiError(422, "VALIDATION_ERROR", "page는 1 이상이어야 해요.")
    if not (1 <= page_size <= 100):
        raise ApiError(422, "VALIDATION_ERROR", "page_size는 1~100이어야 해요.")

    filtered = db.query(models.Project).filter(models.Project.user_id == current_user.id, models.Project.deleted_at.is_(None))

    if query:
        filtered = filtered.filter(models.Project.title.ilike(f"%{query}%"))
    if status:
        filtered = filtered.filter(models.Project.status.in_(status))
    if starred is not None:
        filtered = filtered.filter(models.Project.starred == starred)

    sort_by_name = sort == "name"
    sort_column = models.Project.title if sort_by_name else models.Project.updated_at
    descending = (not sort_by_name) if order is None else order == "desc"
    filtered = filtered.order_by(sort_column.desc() if descending else sort_column.asc())

    total = filtered.count()
    projects = filtered.offset((page - 1) * page_size).limit(page_size).all()

    return envelope_list([ProjectSummary.model_validate(project) for project in projects], page=page, page_size=page_size, total=total)


@router.post("", status_code=201)
def create_project(
    payload: ProjectCreateRequest,
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    project = models.Project(user_id=current_user.id, title=payload.title, format=payload.format)
    db.add(project)
    db.commit()
    db.refresh(project)

    return envelope(ProjectSummary.model_validate(project))


@router.get("/{project_id}")
def get_project(
    project_id: str,
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    project = _get_owned_project(db, current_user, project_id)
    return envelope(ProjectSummary.model_validate(project))


@router.patch("/{project_id}")
def patch_project(
    project_id: str,
    payload: ProjectPatchRequest,
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    project = _get_owned_project(db, current_user, project_id)

    if project.version != payload.version:
        raise ApiError(409, "VERSION_CONFLICT", "다른 곳에서 먼저 수정됐어요. 새로고침 후 다시 시도해주세요.")
    if payload.title is None and payload.starred is None and payload.format is None:
        raise ApiError(422, "VALIDATION_ERROR", "변경할 값을 하나 이상 보내주세요.")

    if payload.title is not None:
        project.title = payload.title
    if payload.starred is not None:
        project.starred = payload.starred
    if payload.format is not None:
        project.format = payload.format

    project.version += 1
    db.add(project)
    db.commit()
    db.refresh(project)

    return envelope(ProjectSummary.model_validate(project))


@router.delete("/{project_id}", status_code=204)
def delete_project(
    project_id: str,
    version: int,
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    project = _get_owned_project(db, current_user, project_id)

    if project.version != version:
        raise ApiError(409, "VERSION_CONFLICT", "다른 곳에서 먼저 수정됐어요. 새로고침 후 다시 시도해주세요.")

    project.deleted_at = datetime.utcnow()
    db.add(project)
    db.commit()


@router.post("/{project_id}/restore")
def restore_project(
    project_id: str,
    payload: ProjectRestoreRequest,
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    project = _get_owned_project(db, current_user, project_id, include_deleted=True)

    if project.deleted_at is None:
        raise ApiError(409, "CONFLICT", "삭제되지 않은 프로젝트예요.")
    if project.version != payload.deleted_version:
        raise ApiError(409, "VERSION_CONFLICT", "삭제 시점 정보가 일치하지 않아요.")

    project.deleted_at = None
    project.version += 1
    db.add(project)
    db.commit()
    db.refresh(project)

    return envelope(ProjectSummary.model_validate(project))


@router.post("/{project_id}/duplicate", status_code=201)
def duplicate_project(
    project_id: str,
    payload: ProjectDuplicateRequest,
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    project = _get_owned_project(db, current_user, project_id)
    title = payload.title.strip() if payload.title else f"{project.title} 복사본"

    duplicate = models.Project(user_id=current_user.id, title=title, format=project.format)
    db.add(duplicate)
    db.commit()
    db.refresh(duplicate)
    copy_project_data(db, project, duplicate)
    db.refresh(duplicate)

    return envelope(ProjectSummary.model_validate(duplicate))


GPU_SERVER_URL = os.environ.get("GPU_SERVER_URL", "http://host.docker.internal:8001").rstrip("/")
MAX_STATE_BYTES = 8 * 1024 * 1024


class ProjectStatePayload(BaseModel):
    """프로젝트의 분석 결과와 편집 상태. 보낸 항목만 바꾼다."""

    analysis: dict | None = None
    editor: dict | None = None
    job_id: str | None = None
    video_path: str | None = None
    status: str | None = None
    exported_duration_seconds: float | None = None
    # 프로젝트 목록 썸네일(작은 JPEG data URL). 영상 중간 프레임을 브라우저가 만들어 보낸다.
    preview_url: str | None = None


def _load_json(text: str | None):
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


async def _ensure_gpu_copy(row: models.ProjectData, stored: "os.PathLike | None") -> str | None:
    """분석·내보내기는 GPU 서버 임시 폴더의 사본을 쓴다. 사라졌으면 저장해 둔 영상으로 다시 올린다."""
    try:
        async with httpx.AsyncClient(timeout=None) as client:
            if row.gpu_video_path:
                check = await client.get(f"{GPU_SERVER_URL}/videos/exists", params={"video_path": row.gpu_video_path}, timeout=10.0)
                if check.is_success and check.json().get("exists"):
                    return row.gpu_video_path
            if stored is None:
                return row.gpu_video_path
            with open(stored, "rb") as handle:
                files = {"video": (row.video_filename or "video.mp4", handle, row.video_content_type or "application/octet-stream")}
                uploaded = await client.post(f"{GPU_SERVER_URL}/videos", files=files)
            if uploaded.is_success:
                return uploaded.json().get("video_path")
    except (httpx.HTTPError, ValueError):
        pass
    return row.gpu_video_path


async def ensure_project_gpu_video(db: Session, project_id: str) -> str | None:
    """프로젝트 영상의 GPU 서버 사본 경로. 사라졌으면 저장해 둔 영상으로 다시 만들어 돌려준다."""
    row = db.get(models.ProjectData, project_id)
    if row is None:
        return None

    path = await _ensure_gpu_copy(row, video_file(row))
    if path != row.gpu_video_path:
        row.gpu_video_path = path
        db.add(row)
        db.commit()
    return path


@router.get("/{project_id}/state")
async def get_project_state(
    project_id: str,
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    project = _get_owned_project(db, current_user, project_id)
    row = db.get(models.ProjectData, project_id)

    if row is None:
        return envelope({"project": ProjectSummary.model_validate(project), "analysis": None, "editor": None, "job_id": None, "video": None})

    stored = video_file(row)
    gpu_path = await _ensure_gpu_copy(row, stored) if row.analysis else row.gpu_video_path
    if gpu_path != row.gpu_video_path:
        row.gpu_video_path = gpu_path
        db.add(row)
        db.commit()

    video = None
    if stored is not None or gpu_path:
        video = {
            "name": row.video_filename,
            "url": f"/api/v1/projects/{project_id}/video?token={security.create_video_token(current_user.id, project_id)}" if stored is not None else None,
            "path": gpu_path,
        }

    return envelope(
        {
            "project": ProjectSummary.model_validate(project),
            "analysis": _load_json(row.analysis),
            "editor": _load_json(row.editor_state),
            "job_id": row.job_id,
            "video": video,
        }
    )


@router.put("/{project_id}/state")
def put_project_state(
    project_id: str,
    payload: ProjectStatePayload,
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    project = _get_owned_project(db, current_user, project_id)
    row = get_or_create_data(db, project_id)

    if payload.analysis is not None:
        text = json.dumps(payload.analysis, ensure_ascii=False)
        if len(text) > MAX_STATE_BYTES:
            raise ApiError(413, "PAYLOAD_TOO_LARGE", "분석 결과가 너무 커요.")
        row.analysis = text
        segments = payload.analysis.get("segments")
        project.scene_count = len(segments) if isinstance(segments, list) else project.scene_count
        duration = payload.analysis.get("duration")
        if isinstance(duration, (int, float)) and duration > 0:
            project.source_duration_seconds = float(duration)
        if project.status in ("draft", "analyzing", "failed"):
            project.status = "editing"
    if payload.editor is not None:
        text = json.dumps(payload.editor, ensure_ascii=False)
        if len(text) > MAX_STATE_BYTES:
            raise ApiError(413, "PAYLOAD_TOO_LARGE", "편집 내용이 너무 커요.")
        row.editor_state = text
    if payload.job_id is not None:
        row.job_id = payload.job_id
    if payload.video_path is not None:
        row.gpu_video_path = payload.video_path
    if payload.status in ("editing", "completed"):
        project.status = payload.status
    if payload.preview_url is not None:
        if not payload.preview_url.startswith("data:image/jpeg;base64,") or len(payload.preview_url) > 200_000:
            raise ApiError(422, "VALIDATION_ERROR", "썸네일 형식이 올바르지 않아요.")
        project.preview_url = payload.preview_url
    if payload.exported_duration_seconds is not None:
        project.exported_duration_seconds = payload.exported_duration_seconds

    project.updated_at = datetime.utcnow()
    db.add_all([row, project])
    db.commit()
    db.refresh(project)

    return envelope(ProjectSummary.model_validate(project))


@router.get("/{project_id}/video")
def get_project_video(
    project_id: str,
    token: str | None = None,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    """저장해 둔 원본 영상. <video>가 쓰도록 주소의 token(영상 전용 단기 토큰)이나 Authorization 헤더로 확인한다."""
    if token:
        user_id = security.decode_video_token(token, project_id)
    elif authorization and authorization.lower().startswith("bearer "):
        user_id = security.decode_access_token(authorization.split(" ", 1)[1].strip())
    else:
        raise ApiError(401, "UNAUTHORIZED", "토큰이 없거나 만료되었습니다.")

    project = db.get(models.Project, project_id)
    if not project or project.user_id != user_id or project.deleted_at is not None:
        raise ApiError(404, "RESOURCE_NOT_FOUND", "프로젝트를 찾을 수 없습니다.")

    row = db.get(models.ProjectData, project_id)
    path = video_file(row)
    if path is None:
        raise ApiError(404, "RESOURCE_NOT_FOUND", "저장된 영상이 없어요.")

    return FileResponse(path, media_type=row.video_content_type or "video/mp4", filename=None)


def _project_for_media(project_id: str, token: str | None, authorization: str | None, db: Session) -> models.Project:
    """영상·미리보기 이미지 요청의 사용자 확인: 주소의 영상 전용 토큰이나 Authorization 헤더."""
    if token:
        user_id = security.decode_video_token(token, project_id)
    elif authorization and authorization.lower().startswith("bearer "):
        user_id = security.decode_access_token(authorization.split(" ", 1)[1].strip())
    else:
        raise ApiError(401, "UNAUTHORIZED", "토큰이 없거나 만료되었습니다.")

    project = db.get(models.Project, project_id)
    if not project or project.user_id != user_id or project.deleted_at is not None:
        raise ApiError(404, "RESOURCE_NOT_FOUND", "프로젝트를 찾을 수 없습니다.")
    return project


@router.get("/{project_id}/video-token")
def get_video_token(
    project_id: str,
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """<img>·<video> 주소에 실을 이 프로젝트 전용 단기 토큰."""
    _get_owned_project(db, current_user, project_id)
    return envelope({"token": security.create_video_token(current_user.id, project_id)})


@router.get("/{project_id}/frame")
def get_project_frame(
    project_id: str,
    t: float = 0.0,
    w: int = 320,
    token: str | None = None,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    """저장해 둔 영상의 t초 프레임(작은 JPEG). 구간 미리보기용으로, 영상을 통째로 받지 않고 서버가 바로 뽑아 준다."""
    _project_for_media(project_id, token, authorization, db)
    path = video_file(db.get(models.ProjectData, project_id))
    if path is None:
        raise ApiError(404, "RESOURCE_NOT_FOUND", "저장된 영상이 없어요.")

    image = frame_image(project_id, path, t, min(640, max(80, w)))
    if image is None:
        raise ApiError(404, "RESOURCE_NOT_FOUND", "그 시각의 프레임을 만들지 못했어요.")

    # 같은 주소(시각·너비)는 내용이 바뀌지 않으므로 브라우저가 오래 보관해도 된다.
    return FileResponse(image, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})
