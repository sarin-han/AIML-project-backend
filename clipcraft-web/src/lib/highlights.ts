import type { EditorHighlightSegment, HighlightAnalysisResult, HighlightCandidate, HighlightExtractionResult } from '@/types/app';

/** 초 → mm:ss */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

/** 선택한 구간의 길이 합(초). */
export function totalDuration(highlights: HighlightCandidate[]): number {
  return highlights.reduce((sum, item) => sum + Math.max(0, item.end - item.start), 0);
}

/**
 * 선택한 하이라이트를 편집 화면이 받는 분석 결과로 바꾼다.
 * 선택한 구간은 선택한 순서가 아니라 시간 순서대로 이어 붙인다.
 */
export function buildEditorAnalysis(
  extraction: HighlightExtractionResult,
  selectedIds: ReadonlySet<number>,
  meta: Pick<HighlightAnalysisResult, 'jobId' | 'projectName' | 'videoPath' | 'videoUrl' | 'videoName'>,
): HighlightAnalysisResult {
  const segments: EditorHighlightSegment[] = extraction.highlights
    .filter((item) => selectedIds.has(item.id))
    .sort((a, b) => a.start - b.start)
    .map((item, index) => ({
      id: index + 1,
      sourceId: item.id,
      scenario: item.label,
      title: item.label,
      start: item.start,
      end: item.end,
    }));

  return {
    segments,
    duration: extraction.duration,
    barCount: extraction.barCount,
    amplitudes: extraction.amplitudes,
    ...meta,
  };
}
