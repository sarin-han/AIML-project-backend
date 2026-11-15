import { ApiError, authFetch, errorMessageFromBody } from '@/api/client';
import type { ApiErrorBody } from '@/api/types';

const UPLOAD_API_URL = import.meta.env.VITE_API_V1_URL || '/api/v1';
const MAX_CHUNK_RETRIES = 3;

interface UploadCreated {
  upload_id: string;
  chunk_size: number;
}

/**
 * 영상을 조각으로 나눠 올리고 upload_id를 돌려준다.
 * 프록시(Cloudflare 무료 플랜은 요청당 100MB)의 크기 제한을 피하려고 분석 API는 영상 대신 이 id를 받는다.
 */
export async function uploadVideoInChunks(file: File, onProgress?: (ratio: number) => void): Promise<string> {
  const response = await authFetch(`${UPLOAD_API_URL}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, size: file.size, content_type: file.type || 'video/mp4' }),
  });
  const createdBody = (response.headers.get('content-type') ?? '').includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    throw new ApiError(errorMessageFromBody(createdBody as ApiErrorBody | null, `영상 업로드를 시작하지 못했어요. (${response.status})`), response.status);
  }
  const created = (createdBody as { data: UploadCreated }).data;
  if (!created?.upload_id) throw new ApiError('업로드 응답이 올바르지 않아요.', response.status);

  let offset = 0;
  onProgress?.(0);
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(offset + created.chunk_size, file.size));
    offset = await putChunk(created.upload_id, offset, chunk);
    onProgress?.(offset / file.size);
  }
  return created.upload_id;
}

async function putChunk(uploadId: string, offset: number, chunk: Blob): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_CHUNK_RETRIES; attempt += 1) {
    try {
      const response = await authFetch(`${UPLOAD_API_URL}/uploads/${uploadId}?offset=${offset}`, { method: 'PUT', body: chunk });
      const body = (response.headers.get('content-type') ?? '').includes('application/json') ? await response.json() : null;
      if (response.ok) return (body as { data: { received: number } }).data.received;

      // 서버가 이미 이 조각을 받았다면(응답만 놓친 경우) 서버가 알려준 위치부터 이어간다.
      if (response.status === 409) {
        const received = Number((body as ApiErrorBody | null)?.error && (body as { error: { details?: { reason: string }[] } }).error.details?.[0]?.reason);
        if (Number.isFinite(received) && received >= offset + chunk.size) return received;
      }
      throw new ApiError(errorMessageFromBody(body as ApiErrorBody | null, `영상 업로드에 실패했어요. (${response.status})`), response.status);
    } catch (error) {
      lastError = error;
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error; // 재시도해도 소용없는 오류
      await new Promise((resolve) => window.setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('영상 업로드에 실패했어요.');
}
