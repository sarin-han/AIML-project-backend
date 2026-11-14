/** 편집 화면의 화면 비율. 'source'는 올린 영상의 원래 비율을 그대로 쓴다. */
export type AspectSetting = 'source' | '16:9' | '9:16' | '1:1';

export const ASPECT_OPTIONS: ReadonlyArray<{ label: string; value: AspectSetting }> = [
  { label: '원본', value: 'source' },
  { label: '가로 16:9', value: '16:9' },
  { label: '세로 9:16', value: '9:16' },
  { label: '정사각형 1:1', value: '1:1' },
];

const ASPECT_STORAGE_KEY = 'clipcraft.aspect';
const FIXED_RATIOS: Record<Exclude<AspectSetting, 'source'>, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 };

function isAspectSetting(value: unknown): value is AspectSetting {
  return value === 'source' || value === '16:9' || value === '9:16' || value === '1:1';
}

export function loadAspectSetting(): AspectSetting {
  try {
    const saved = window.localStorage.getItem(ASPECT_STORAGE_KEY);
    return isAspectSetting(saved) ? saved : 'source';
  } catch {
    return 'source';
  }
}

export function saveAspectSetting(setting: AspectSetting): void {
  try {
    window.localStorage.setItem(ASPECT_STORAGE_KEY, setting);
  } catch {
    // 저장 공간을 못 쓰는 환경에서는 이번 세션에서만 유지한다.
  }
}

/** 가로/세로 비율 숫자. 원본이면 영상의 비율(아직 모르면 16:9). */
export function getAspectRatio(setting: AspectSetting, sourceRatio: number | null): number {
  return setting === 'source' ? sourceRatio ?? 16 / 9 : FIXED_RATIOS[setting];
}

/** 내보내기 요청에 보낼 비율. 원본이면 보내지 않는다(영상 그대로). */
export function toExportAspect(setting: AspectSetting): '16:9' | '9:16' | '1:1' | undefined {
  return setting === 'source' ? undefined : setting;
}

export function getAspectLabel(setting: AspectSetting, sourceRatio: number | null): string {
  if (setting !== 'source') return ASPECT_OPTIONS.find((option) => option.value === setting)?.label ?? setting;
  if (!sourceRatio) return '원본 비율';
  if (sourceRatio > 1.05) return '원본 · 가로형';
  if (sourceRatio < 0.95) return '원본 · 세로형';
  return '원본 · 정사각형';
}
