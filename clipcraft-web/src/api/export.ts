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

export async function requestExportVideo(videoPath: string, segments: EditorHighlightSegment[], segmentEditSettings: SegmentEditSetting[], subtitles?: ExportSubtitles, outputAspect?: ExportVideoRequest['output_aspect']): Promise<Blob> {
  const endpoint = getApiUrl(import.meta.env.VITE_EXPORT_API_URL, DEFAULT_EXPORT_API_URL);
  const settingsBySegmentId = new Map(segmentEditSettings.map((setting) => [setting.segmentId, setting]));
  const response = await fetch(endpoint, {
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

  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json') ? await response.json() : null;
    throw new ApiError(body?.message || body?.detail || body?.error || `Export failed: ${response.status}`, response.status);
  }

  return response.blob();
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
