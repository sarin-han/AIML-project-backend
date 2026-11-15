import { requestJson } from '@/api/client';

/** scenario: 시나리오 문장만 근거로 / video: 영상 프레임만 근거로 */
export type SuggestBasis = 'scenario' | 'video';

export interface SuggestItem {
  id: number;
  scenario: string;
  title?: string;
  duration: number;
  /** JPEG data URL */
  frames: string[];
}

export interface SuggestedCaption {
  id: number;
  text: string;
}

export async function requestSubtitleSuggestions(items: SuggestItem[], basis: SuggestBasis): Promise<SuggestedCaption[]> {
  const { suggestions } = await requestJson<{ suggestions: SuggestedCaption[] }>('/suggest-subtitles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ basis, items }),
  });

  return suggestions;
}
