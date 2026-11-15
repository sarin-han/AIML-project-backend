import { ApiError, getApiUrl } from '@/api/client';
import type { SubtitleStyle, TimelineCue } from '@/lib/subtitles';
import type { EditorHighlightSegment, SegmentEditSetting } from '@/types/app';

const DEFAULT_EXPORT_API_URL = '/export';

export interface ExportVideoRequest {
  video_path: string;
  segments: Array<{
    start: number;
    end: number;
    speed: number;
    muted: boolean;
  }>;
  /** 출력 화면 비율. 없으면 원본 비율 그대로 */
  output_aspect?: '16:9' | '9:16' | '1:1';
  subtitle_cues?: TimelineCue[];
  subtitle_style?: Pick<SubtitleStyle, 'font' | 'size' | 'position' | 'color' | 'box'> & { extra_lang: string };
}

export interface ExportSubtitles {
  cues: TimelineCue[];
  style: SubtitleStyle;
}

/** 내보내기 진행 상황 조회 간격 */
const EXPORT_POLL_INTERVAL_MS = 1000;
/** 이 시간 안에 끝나지 않으면 포기한다 */
const EXPORT_TIMEOUT_MS = 30 * 60 * 1000;
/** 상태 조회가 연달아 이만큼 실패하면 포기한다(잠깐 끊기는 것은 견딘다) */
const EXPORT_MAX_POLL_FAILURES = 5;

interface ExportJobStatus {
  status: 'queued' | 'running' | 'success' | 'error';
  progress: number;
  message?: string;
  error?: string | null;
}

async function readError(response: Response, fallback: string): Promise<ApiError> {
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json') ? await response.json() : null;
  return new ApiError(body?.message || body?.detail || body?.error || `${fallback}: ${response.status}`, response.status);
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * 내보내기를 시작하고, 끝날 때까지 진행 상황을 물어본 뒤 완성된 영상을 내려받는다.
 * 오래 걸려도 요청이 끊기지 않는다. onProgress에는 0~100이 전달된다.
 */
export async function requestExportVideo(
  videoPath: string,
  segments: EditorHighlightSegment[],
  segmentEditSettings: SegmentEditSetting[],
  subtitles?: ExportSubtitles,
  outputAspect?: ExportVideoRequest['output_aspect'],
  onProgress?: (percent: number) => void,
): Promise<Blob> {
  const endpoint = getApiUrl(import.meta.env.VITE_EXPORT_API_URL, DEFAULT_EXPORT_API_URL);
  const settingsBySegmentId = new Map(segmentEditSettings.map((setting) => [setting.segmentId, setting]));
  const start = await fetch(`${endpoint}/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      video_path: videoPath,
      segments: segments.map((segment) => {
        const editSetting = settingsBySegmentId.get(segment.id);

        return {
          start: segment.start,
          end: segment.end,
          speed: editSetting?.speed ?? 1,
          muted: editSetting?.muted ?? false,
        };
      }),
      ...(outputAspect ? { output_aspect: outputAspect } : {}),
      ...(subtitles && subtitles.cues.length > 0
        ? {
            subtitle_cues: subtitles.cues,
            subtitle_style: { font: subtitles.style.font, size: subtitles.style.size, position: subtitles.style.position, color: subtitles.style.color, box: subtitles.style.box, extra_lang: subtitles.style.extraLang },
          }
        : {}),
    } satisfies ExportVideoRequest),
  });

  if (!start.ok) throw await readError(start, 'Export failed');
  const { job_id: jobId } = (await start.json()) as { job_id: string };

  const deadline = Date.now() + EXPORT_TIMEOUT_MS;
  let failures = 0;

  for (;;) {
    if (Date.now() > deadline) throw new ApiError('내보내기가 너무 오래 걸려서 중단했어요.', 408);
    await wait(EXPORT_POLL_INTERVAL_MS);

    let job: ExportJobStatus;
    try {
      const response = await fetch(`${endpoint}/jobs/${jobId}`);
      if (response.status === 404) throw new ApiError('서버가 다시 시작돼서 내보내기가 중단됐어요. 다시 시도해 주세요.', 404);
      if (!response.ok) throw await readError(response, 'Export status failed');
      job = (await response.json()) as ExportJobStatus;
      failures = 0;
    } catch (error) {
      // 서버가 알려 준 오류(작업 없음 등)는 바로 전달하고, 네트워크가 잠깐 끊긴 것은 몇 번 더 시도한다.
      if (error instanceof ApiError) throw error;
      failures += 1;
      if (failures >= EXPORT_MAX_POLL_FAILURES) throw error;
      continue;
    }

    onProgress?.(Math.max(0, Math.min(100, job.progress)));
    if (job.status === 'error') throw new ApiError(job.error || job.message || '내보내기에 실패했어요.', 500);
    if (job.status === 'success') break;
  }

  const download = await fetch(`${endpoint}/jobs/${jobId}/download`);
  if (!download.ok) throw await readError(download, 'Export download failed');
  return download.blob();
}

export function downloadExportedVideo(blob: Blob, fileName = 'clipcraft_export.mp4'): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
