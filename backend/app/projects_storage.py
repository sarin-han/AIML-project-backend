"""프로젝트 원본 영상 저장. 저장 위치는 이 파일에서만 다룬다(나중에 S3로 바꿀 때 여기만 고친다)."""
import os
import re
import shutil
from pathlib import Path

from sqlalchemy.orm import Session

from . import models
from .database import DATA_DIR

VIDEO_DIR = DATA_DIR / "videos"


def get_or_create_data(db: Session, project_id: str) -> models.ProjectData:
    row = db.get(models.ProjectData, project_id)
    if row is None:
        row = models.ProjectData(project_id=project_id)
        db.add(row)
    return row


def video_file(row: models.ProjectData | None) -> Path | None:
    if not row or not row.video_storage_path:
        return None
    path = DATA_DIR / row.video_storage_path
    return path if path.is_file() else None


def save_project_video(db: Session, project: models.Project, filename: str | None, content_type: str | None, content: bytes) -> None:
    """분석에 올라온 영상을 프로젝트에 붙여 저장한다. 이미 있으면 바꾼다."""
    suffix = re.sub(r"[^A-Za-z0-9.]", "", os.path.splitext(filename or "")[1])[:10] or ".mp4"
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    relative = f"videos/{project.id}{suffix}"
    row = get_or_create_data(db, project.id)

    if row.video_storage_path and row.video_storage_path != relative:
        (DATA_DIR / row.video_storage_path).unlink(missing_ok=True)

    (DATA_DIR / relative).write_bytes(content)
    row.video_filename = filename or f"video{suffix}"
    row.video_content_type = content_type or "video/mp4"
    row.video_storage_path = relative
    row.gpu_video_path = None  # 새 영상이므로 이전 분석용 사본은 더 이상 맞지 않는다
    project.source_size_bytes = len(content)
    db.add(project)
    db.commit()


def copy_project_data(db: Session, source: models.Project, target: models.Project) -> None:
    """프로젝트 복제: 영상 파일, 분석 결과, 편집 상태를 함께 복사한다."""
    row = db.get(models.ProjectData, source.id)
    if row is None:
        return

    copy = models.ProjectData(
        project_id=target.id,
        video_filename=row.video_filename,
        video_content_type=row.video_content_type,
        job_id=row.job_id,
        analysis=row.analysis,
        editor_state=row.editor_state,
    )
    original = video_file(row)
    if original is not None:
        VIDEO_DIR.mkdir(parents=True, exist_ok=True)
        relative = f"videos/{target.id}{original.suffix}"
        shutil.copyfile(original, DATA_DIR / relative)
        copy.video_storage_path = relative
        target.source_size_bytes = source.source_size_bytes

    target.source_duration_seconds = source.source_duration_seconds
    target.preview_url = source.preview_url
    target.scene_count = source.scene_count
    target.status = "editing" if row.analysis else target.status
    db.add_all([copy, target])
    db.commit()
