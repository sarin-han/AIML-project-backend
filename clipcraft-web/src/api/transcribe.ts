import { ApiError, requestJson, authFetch, errorMessageFromBody } from '@/api/client';
import type { SubtitleCue } from '@/types/app';

const TRANSCRIBE_API_URL = '/transcribe';
const POLL_INTERVAL_MS = 1200;

interface TranscribeJobStartResponse {
  status: string;
  job_id: string;
}

interface TranscribeJobStatus {
  status: 'queued' | 'running' | 'success' | 'error' | string;
  progress: number;
  message: string;
  segments: SubtitleCue[];
  error?: string | null;
}

async function getTranscribeJob(jobId: string): Promise<TranscribeJobStatus> {
  const response = await authFetch(`${TRANSCRIBE_API_URL}/jobs/${jobId}`);
  const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    throw new ApiError(errorMessageFromBody(body, `API request failed: ${response.status}`), response.status);
  }

  return body as TranscribeJobStatus;
}

/** language: 'ko' | 'en' 등 언어 코드, null이면 Whisper가 자동 감지한다. */
export async function requestSubtitles(videoPath: string, onProgress: (progress: number) => void, language: string | null = null): Promise<SubtitleCue[]> {
  const { job_id: jobId } = await requestJson<TranscribeJobStartResponse>(`${TRANSCRIBE_API_URL}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_path: videoPath, language }),
  });

  for (;;) {
    await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
    const job = await getTranscribeJob(jobId);
    onProgress(job.progress);

    if (job.status === 'success') return job.segments;
    if (job.status === 'error') throw new ApiError(job.error || job.message || '자막 생성에 실패했습니다.', 500);
  }
}
