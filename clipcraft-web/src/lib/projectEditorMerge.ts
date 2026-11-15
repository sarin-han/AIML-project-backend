import type { EditorSavedState, ProjectState } from '@/api/projects';
import { DEFAULT_SUBTITLE_STYLE } from '@/lib/subtitles';
import type { EditorHighlightSegment, HighlightAnalysisData } from '@/types/app';

export interface NewSegmentInput {
  scenario: string;
  start: number;
  end: number;
}

/**
 * 저장된 프로젝트의 편집 내용 끝에 구간을 더한다. 편집 화면의 "시나리오 추가"와 같은 방식(extraSegments + segments)이다.
 * 이미 목록에 있는 구간(시작·끝이 0.5초 안으로 같은 것)은 건너뛴다.
 */
export function appendSegmentsToProject(state: ProjectState, added: NewSegmentInput[]): { analysis: HighlightAnalysisData; editor: EditorSavedState; addedCount: number } {
  const analysis = state.analysis as HighlightAnalysisData;
  const editor: EditorSavedState = state.editor ?? {
    deletedSegmentIds: [],
    extraSegments: [],
    segmentEditSettings: [],
    segments: analysis.segments,
    subtitleSets: { voice: [], scenario: [], active: 'voice' },
    subtitleStyle: DEFAULT_SUBTITLE_STYLE,
  };

  const usedIds = [...analysis.segments, ...editor.extraSegments, ...editor.segments].map((item) => item.id).concat(editor.deletedSegmentIds);
  let nextId = Math.max(0, ...usedIds) + 1;
  const duration = analysis.duration > 0 ? analysis.duration : Number.POSITIVE_INFINITY;
  const fresh: EditorHighlightSegment[] = [];

  for (const item of added) {
    const start = Math.max(0, item.start);
    const end = Math.min(duration, Math.max(item.end, start + 0.2));
    const duplicate = [...editor.segments, ...fresh].some((segment) => Math.abs(segment.start - start) < 0.5 && Math.abs(segment.end - end) < 0.5);
    if (duplicate) continue;

    fresh.push({ id: nextId, sourceId: nextId, scenario: item.scenario, title: item.scenario, start, end });
    nextId += 1;
  }

  return {
    analysis,
    addedCount: fresh.length,
    editor: { ...editor, extraSegments: [...editor.extraSegments, ...fresh], segments: [...editor.segments, ...fresh] },
  };
}
