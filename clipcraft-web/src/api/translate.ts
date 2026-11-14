import { requestJson } from '@/api/client';
import type { SubtitleCue } from '@/types/app';

const TRANSLATE_API_URL = '/translate';

function isMostlyKorean(texts: string[]): boolean {
  const letters = texts.join('').match(/[A-Za-z\uAC00-\uD7A3]/g) ?? [];
  if (letters.length === 0) return true;

  const hangul = letters.filter((char) => char >= '\uAC00' && char <= '\uD7A3').length;
  return hangul / letters.length > 0.3;
}

/** 한국어가 아닌 자막만 한국어로 번역한다. 원문은 original에 남긴다. */
export async function translateCuesToKorean(cues: SubtitleCue[]): Promise<SubtitleCue[]> {
  if (cues.length === 0 || isMostlyKorean(cues.map((cue) => cue.text))) return cues;

  const { translations } = await requestJson<{ translations: string[] }>(TRANSLATE_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: cues.map((cue) => cue.text) }),
  });

  return cues.map((cue, index) => ({ ...cue, text: translations[index] ?? cue.text, original: cue.text }));
}

/** 자막 문장을 지정한 언어로 번역한다(백엔드 /translate). */
export async function requestTranslations(texts: string[], target: string): Promise<string[]> {
  const { translations } = await requestJson<{ translations: string[] }>(TRANSLATE_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts, target }),
  });

  return translations;
}
