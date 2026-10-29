import { requestJson } from '@/api/client';

export type SuggestTone = 'descriptive' | 'emotional' | 'funny';
/** scenario: 시나리오 문장만 근거로 / video: 영상 프레임만 근거로 */
export type SuggestBasis = 'scenario' | 'video';

export const SUGGEST_TONE_OPTIONS: Array<{ value: SuggestTone; label: string }> = [
  { value: 'descriptive', label: '설명형' },
  { value: 'emotional', label: '감성형' },
  { value: 'funny', label: '유머형' },
];

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

export async function requestSubtitleSuggestions(items: SuggestItem[], tone: SuggestTone, basis: SuggestBasis): Promise<SuggestedCaption[]> {
  const { suggestions } = await requestJson<{ suggestions: SuggestedCaption[] }>('/suggest-subtitles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tone, basis, items }),
  });

  return suggestions;
}
