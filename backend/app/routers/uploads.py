from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from .. import models, security, uploads
from ..envelope import ApiError, envelope

router = APIRouter(prefix="/api/v1/uploads", tags=["uploads"])


class UploadCreateRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    size: int
    content_type: str | None = None


@router.post("", status_code=201)
def create_upload(body: UploadCreateRequest, current_user: models.User = Depends(security.get_current_user)):
    uploads.cleanup_stale()
    upload_id = uploads.create_upload(current_user.id, body.filename, body.size, body.content_type)
    return envelope({"upload_id": upload_id, "chunk_size": uploads.CHUNK_SIZE})


@router.put("/{upload_id}")
async def put_chunk(upload_id: str, offset: int, request: Request, current_user: models.User = Depends(security.get_current_user)):
    if offset < 0:
        raise ApiError(422, "VALIDATION_ERROR", "offset이 올바르지 않아요.")
    data = await request.body()
    if len(data) > uploads.CHUNK_SIZE * 2:
        raise ApiError(413, "PAYLOAD_TOO_LARGE", "조각이 너무 커요.")
    received = uploads.append_chunk(current_user.id, upload_id, offset, data)
    return envelope({"received": received})


@router.delete("/{upload_id}", status_code=204)
def delete_upload(upload_id: str, current_user: models.User = Depends(security.get_current_user)):
    uploads.get_upload_meta(current_user.id, upload_id)
    uploads.discard_upload(upload_id)
