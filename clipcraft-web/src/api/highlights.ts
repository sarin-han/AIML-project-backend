import { ApiError, getApiUrl, requestJson } from '@/api/client';
import type { HighlightCandidate, HighlightExtractionResult } from '@/types/app';

const DEFAULT_HIGHLIGHT_API_URL = '/highlights';

export interface HighlightApiItem {
  id: number;
  start: number;
  end: number;
  label: string;
  thumbnail?: string | null;
}

export interface HighlightJobStartResponse {
  status: string;
  job_id: string;
}

export interface HighlightJobStatus {
  status: 'queued' | 'running' | 'success' | 'error' | string;
  progress: number;
  step_id: number;
  step_label: string;
  message: string;
  logs: string[];
  project: string;
  video_path?: string | null;
  error?: string | null;
  /** 분석 도중 지금까지 찾은 구간. 없어도 된다. */
  found?: HighlightApiItem[];
  /** status가 success일 때만 채워진다. */
  result?: {
    duration: number;
    highlights: HighlightApiItem[];
    audio?: { barCount: number; amplitudes: number[] };
  } | null;
}

function getHighlightEndpoint(): string {
  return getApiUrl(import.meta.env.VITE_HIGHLIGHT_API_URL, DEFAULT_HIGHLIGHT_API_URL);
}

export function normalizeHighlight(item: HighlightApiItem): HighlightCandidate {
  return {
    id: item.id,
    start: item.start,
    end: item.end,
    label: item.label,
    thumbnail: item.thumbnail || undefined,
  };
}

export function normalizeHighlightResult(result: NonNullable<HighlightJobStatus['result']>): HighlightExtractionResult {
  const highlights = [...result.highlights].map(normalizeHighlight).sort((a, b) => a.start - b.start);
  return {
    duration: result.duration,
    highlights,
    barCount: result.audio?.barCount ?? result.audio?.amplitudes.length ?? 0,
    amplitudes: result.audio?.amplitudes ?? [],
  };
}

/** 시나리오 없이 영상 전체 길이를 분석하는 작업을 시작한다. */
export async function startHighlightJob(file: File, projectName: string): Promise<HighlightJobStartResponse> {
  const formData = new FormData();
  formData.append('video', file, file.name);
  formData.append('project_name', projectName);

  return requestJson<HighlightJobStartResponse>(`${getHighlightEndpoint()}/jobs`, {
    method: 'POST',
    body: formData,
  });
}

export async function getHighlightJob(jobId: string): Promise<HighlightJobStatus> {
  const response = await fetch(`${getHighlightEndpoint()}/jobs/${jobId}`);
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    throw new ApiError(body?.message || body?.detail || body?.error || `API request failed: ${response.status}`, response.status);
  }

  return body as HighlightJobStatus;
}
