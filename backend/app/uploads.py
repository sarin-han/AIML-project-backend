"""큰 영상을 조각으로 나눠 올리기 위한 임시 저장소.

Cloudflare 등 프록시는 요청 하나의 크기를 제한(무료 플랜 100MB)하므로, 브라우저가 영상을 조각으로 올리고
분석 API는 영상 대신 upload_id를 받는다. 조각이 모두 모이면 분석/저장에 쓰고 임시 파일은 지운다.
"""
import json
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from .database import DATA_DIR
from .envelope import ApiError

UPLOAD_DIR = DATA_DIR / "uploads"
CHUNK_SIZE = 32 * 1024 * 1024  # 프록시 제한(100MB)보다 충분히 작게
MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024
STALE_SECONDS = 24 * 3600


@dataclass
class UploadedVideo:
    path: Path
    filename: str
    content_type: str
    size: int


def _paths(upload_id: str) -> tuple[Path, Path]:
    if not upload_id.isalnum():
        raise ApiError(404, "RESOURCE_NOT_FOUND", "업로드를 찾을 수 없어요.")
    return UPLOAD_DIR / f"{upload_id}.part", UPLOAD_DIR / f"{upload_id}.json"


def create_upload(user_id: str, filename: str, size: int, content_type: str | None) -> str:
    if size <= 0 or size > MAX_UPLOAD_BYTES:
        raise ApiError(422, "VALIDATION_ERROR", "영상 크기가 올바르지 않거나 너무 커요.")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    upload_id = uuid.uuid4().hex
    part, meta = _paths(upload_id)
    part.write_bytes(b"")
    meta.write_text(json.dumps({"user_id": user_id, "filename": filename, "size": size, "content_type": content_type or "video/mp4"}), encoding="utf-8")
    return upload_id


def get_upload_meta(user_id: str, upload_id: str) -> dict:
    return _meta(user_id, upload_id)


def _meta(user_id: str, upload_id: str) -> dict:
    _, meta_path = _paths(upload_id)
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ApiError(404, "RESOURCE_NOT_FOUND", "업로드를 찾을 수 없어요. 다시 올려 주세요.")
    if meta.get("user_id") != user_id:
        raise ApiError(404, "RESOURCE_NOT_FOUND", "업로드를 찾을 수 없어요.")
    return meta


def append_chunk(user_id: str, upload_id: str, offset: int, data: bytes) -> int:
    meta = _meta(user_id, upload_id)
    part, _ = _paths(upload_id)
    received = part.stat().st_size if part.exists() else 0
    if offset != received:
        raise ApiError(409, "UPLOAD_OFFSET_MISMATCH", f"이어서 올릴 위치가 맞지 않아요. (서버가 받은 크기: {received})", [{"field": "received", "reason": str(received)}])
    if received + len(data) > meta["size"]:
        raise ApiError(422, "VALIDATION_ERROR", "선언한 영상 크기보다 많이 올라왔어요.")
    with part.open("ab") as fh:
        fh.write(data)
    return received + len(data)


def get_upload(user_id: str, upload_id: str) -> UploadedVideo:
    """모든 조각이 올라온 업로드를 돌려준다."""
    meta = _meta(user_id, upload_id)
    part, _ = _paths(upload_id)
    size = part.stat().st_size if part.exists() else 0
    if size != meta["size"]:
        raise ApiError(409, "UPLOAD_INCOMPLETE", "영상 업로드가 아직 끝나지 않았어요. 다시 올려 주세요.")
    return UploadedVideo(path=part, filename=meta["filename"], content_type=meta["content_type"], size=size)


def discard_upload(upload_id: str) -> None:
    for path in _paths(upload_id):
        path.unlink(missing_ok=True)


def new_temp_upload(user_id: str, filename: str | None, content_type: str | None, content: bytes) -> str:
    """조각 업로드를 쓰지 않은 기존 방식(multipart)도 같은 경로로 처리하려고 임시 업로드로 만든다."""
    upload_id = create_upload(user_id, filename or "video.mp4", max(len(content), 1), content_type)
    part, _ = _paths(upload_id)
    part.write_bytes(content)
    return upload_id


def cleanup_stale() -> None:
    if not UPLOAD_DIR.is_dir():
        return
    cutoff = time.time() - STALE_SECONDS
    for path in UPLOAD_DIR.iterdir():
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        except OSError:
            pass
