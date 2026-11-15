"""프로젝트 원본 영상 저장. 저장 위치는 이 파일에서만 다룬다(나중에 S3로 바꿀 때 여기만 고친다)."""
import os
import re
import shutil
from pathlib import Path

from sqlalchemy.orm import Session

from . import models
from .database import DATA_DIR

VIDEO_DIR = DATA_DIR / "videos"
FRAME_DIR = DATA_DIR / "frames"


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
    shutil.rmtree(FRAME_DIR / project.id, ignore_errors=True)  # 새 영상이면 이전 영상에서 뽑은 미리보기는 버린다
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


def frame_image(project_id: str, video: Path, seconds: float, width: int) -> Path | None:
    """영상의 한 시각을 작은 JPEG로 뽑는다. 한 번 뽑은 것은 디스크에 두고 다시 쓴다."""
    import subprocess

    seconds = round(max(0.0, seconds), 1)
    target = FRAME_DIR / project_id / f"{seconds:.1f}_{width}.jpg"
    if target.is_file():
        return target

    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(".tmp.jpg")
    command = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-ss", f"{seconds:.1f}", "-i", str(video), "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "5", str(partial)]
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=30)
    except (subprocess.SubprocessError, OSError):
        partial.unlink(missing_ok=True)
        return None

    if not partial.is_file() or partial.stat().st_size == 0:
        # 영상 길이를 넘은 시각이면 프레임이 없다.
        partial.unlink(missing_ok=True)
        return None
    partial.replace(target)
    return target
