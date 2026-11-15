import { loadAccessToken } from '@/lib/authStorage';
import type { ApiErrorBody, ApiRequestBody, ApiResponse, ApiStatusResponse } from '@/api/types';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** 로그인한 사용자의 액세스 토큰을 실어 보내는 fetch. 분석·번역·편집·내보내기 API는 로그인이 필요하다. */
export function authFetch(input: RequestInfo | URL, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  const token = loadAccessToken();
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...options, headers });
}

/** 서버 오류 본문에서 사람이 읽을 메시지를 꺼낸다. (기존 API는 message/error/detail, /api/v1은 error.message) */
export function errorMessageFromBody(body: ApiErrorBody | null | undefined, fallback: string): string {
  if (!body) return fallback;
  const nested = typeof body.error === 'object' && body.error !== null ? body.error.message : undefined;
  const text = body.message || nested || (typeof body.error === 'string' ? body.error : undefined) || (typeof body.detail === 'string' ? body.detail : undefined);
  return text || fallback;
}

export function getApiUrl(envUrl: string | undefined, fallbackUrl: string): string {
  return envUrl || fallbackUrl;
}

export async function requestJson<T>(url: string, options: RequestInit & { body?: ApiRequestBody } = {}): Promise<T> {
  const response = await authFetch(url, options);
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    const errorBody = body as ApiErrorBody | null;
    throw new ApiError(errorMessageFromBody(errorBody, `API request failed: ${response.status}`), response.status);
  }

  return unwrapApiResponse<T>(body);
}

export async function requestStatusJson<T>(url: string, options: RequestInit & { body?: ApiRequestBody } = {}): Promise<ApiStatusResponse<T>> {
  const response = await authFetch(url, options);
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    const errorBody = body as ApiErrorBody | null;
    throw new ApiError(errorMessageFromBody(errorBody, `API request failed: ${response.status}`), response.status);
  }

  if (!isApiStatusResponse<T>(body)) {
    throw new ApiError('Invalid API response', 200);
  }

  if (body.status !== 'success') {
    throw new ApiError(body.message || body.error || 'API request failed', 200);
  }

  return body;
}

export function unwrapApiResponse<T>(body: unknown): T {
  if (isApiResponse<T>(body)) {
    if (!body.success) {
      throw new ApiError(body.message || body.error || 'API request failed', 200);
    }

    return body.data;
  }

  if (isApiStatusResponse<T>(body)) {
    if (body.status !== 'success') {
      throw new ApiError(body.message || body.error || 'API request failed', 200);
    }

    return body.results;
  }

  return body as T;
}

function isApiResponse<T>(body: unknown): body is ApiResponse<T> {
  return typeof body === 'object' && body !== null && 'success' in body && 'data' in body;
}

function isApiStatusResponse<T>(body: unknown): body is ApiStatusResponse<T> {
  return typeof body === 'object' && body !== null && 'status' in body && 'results' in body;
}
