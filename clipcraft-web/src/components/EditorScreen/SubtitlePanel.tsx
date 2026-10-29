import { useState } from 'react';
import { SUGGEST_TONE_OPTIONS } from '@/api/suggest';
import type { SuggestTone } from '@/api/suggest';
import { SUBTITLE_COLORS, SUBTITLE_FONT_OPTIONS, SUBTITLE_POSITION_PRESETS } from '@/lib/subtitles';
import type { SubtitleStyle } from '@/lib/subtitles';
import type { SubtitleCue } from '@/types/app';

export const SUBTITLE_LANGUAGES = [
  { value: '', label: '자동 감지' },
  { value: 'ko', label: '한국어' },
  { value: 'en', label: '영어' },
] as const;

interface SubtitlePanelProps {
  cues: SubtitleCue[];
  disabled: boolean;
  error: string | null;
  generating: boolean;
  language: string;
  notice: string | null;
  onCueChange: (cueId: number, text: string) => void;
  onCueDelete: (cueId: number) => void;
  onCuePositionReset: (cueId: number) => void;
  onCueSelect: (cueId: number) => void;
  onDownload: () => void;
  onGenerate: () => void;
  onLanguageChange: (language: string) => void;
  onStyleChange: (style: SubtitleStyle) => void;
  onSuggest: (tone: SuggestTone) => void;
  onTranslateChange: (translate: boolean) => void;
  progress: number;
  selectedCueId: number | null;
  style: SubtitleStyle;
  suggestDisabled: boolean;
  suggesting: boolean;
  translate: boolean;
}

const chipClass = 'cursor-pointer rounded-full border border-[rgba(0,0,0,0.12)] bg-white px-3 py-1 text-[12px] hover:bg-[rgba(0,0,0,0.04)] disabled:cursor-not-allowed disabled:opacity-40';
const activeChipClass = 'cursor-pointer rounded-full border border-black bg-black px-3 py-1 text-[12px] text-white disabled:cursor-not-allowed disabled:opacity-40';
const inputClass = 'w-[64px] rounded-md border border-[rgba(0,0,0,0.15)] px-2 py-1 text-[12px]';

export default function SubtitlePanel({
  cues,
  disabled,
  error,
  generating,
  language,
  notice,
  onCueChange,
  onCueDelete,
  onCuePositionReset,
  onCueSelect,
  onDownload,
  onGenerate,
  onLanguageChange,
  onStyleChange,
  onSuggest,
  onTranslateChange,
  progress,
  selectedCueId,
  style,
  suggestDisabled,
  suggesting,
  translate,
}: SubtitlePanelProps) {
  const [openSection, setOpenSection] = useState<'style' | 'scenario' | null>(null);
  const hasTranslation = cues.some((cue) => cue.original);
  const patchStyle = (patch: Partial<SubtitleStyle>) => onStyleChange({ ...style, ...patch });
  const toggleSection = (section: 'style' | 'scenario') => setOpenSection((current) => (current === section ? null : section));

  return (
    <div className="flex max-h-[48%] min-h-[150px] shrink-0 flex-col overflow-y-auto border-t border-[rgba(0,0,0,0.08)]">
      <div className="flex flex-wrap items-center gap-2 px-5 pt-2.5 pb-1.5">
        <span className="text-[13px] font-[520] tracking-[-0.1px]">자막</span>
        <span className="font-mono text-[10px] text-[rgba(0,0,0,0.4)]">{cues.length > 0 ? `${cues.length}개` : ''}</span>
        <button className={openSection === 'style' ? activeChipClass : chipClass} onClick={() => toggleSection('style')} type="button">
          자막 스타일
        </button>
        <button
          className={openSection === 'scenario' ? activeChipClass : chipClass}
          disabled={suggestDisabled || suggesting}
          onClick={() => toggleSection('scenario')}
          title="시나리오 문장을 보고 자막 문구를 만들어요"
          type="button"
        >
          {suggesting ? '만드는 중...' : '시나리오대로 만들기'}
        </button>
        <div className="flex-1" />
        <button
          className="cursor-pointer rounded-full border-0 bg-black px-3 py-1 text-[12px] text-white disabled:cursor-not-allowed disabled:opacity-40"
          disabled={disabled || generating}
          onClick={onGenerate}
          title="영상 속 말소리를 인식해서 자막을 만들어요"
          type="button"
        >
          {generating ? `인식 중... ${progress}%` : cues.length > 0 ? '말소리로 다시 만들기' : '말소리로 자막 만들기'}
        </button>
      </div>

      <div className="flex items-center justify-end gap-3 px-5 pb-2 text-[11px] text-[rgba(0,0,0,0.5)]">
        <span>말소리 인식 설정</span>
        <select aria-label="음성 언어" className={`${chipClass} px-2 py-0.5 text-[11px]`} disabled={generating} onChange={(event) => onLanguageChange(event.target.value)} value={language}>
          {SUBTITLE_LANGUAGES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <label className="flex cursor-pointer items-center gap-1">
          <input checked={translate} disabled={generating} onChange={(event) => onTranslateChange(event.target.checked)} type="checkbox" />
          한국어로 번역
        </label>
      </div>

      {openSection === 'scenario' && (
        <div className="mx-5 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-[rgba(0,0,0,0.08)] p-3 text-[12px]">
          <span className="text-[rgba(0,0,0,0.5)]">어떤 느낌의 문구로 만들까요? 고르면 바로 만들어요.</span>
          {SUGGEST_TONE_OPTIONS.map((option) => (
            <button
              className={chipClass}
              disabled={suggesting}
              key={option.value}
              onClick={() => {
                setOpenSection(null);
                onSuggest(option.value);
              }}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      {openSection === 'style' && (
        <div className="mx-5 mb-2 grid grid-cols-[48px_1fr] items-center gap-x-3 gap-y-2.5 rounded-lg border border-[rgba(0,0,0,0.08)] p-3 text-[12px]">
          <span className="text-[rgba(0,0,0,0.5)]">폰트</span>
          <select className={`${chipClass} w-full`} onChange={(event) => patchStyle({ font: event.target.value })} value={style.font}>
            {SUBTITLE_FONT_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>

          <span className="text-[rgba(0,0,0,0.5)]">크기</span>
          <label className="flex items-center gap-1.5">
            <input
              className={inputClass}
              max={12}
              min={1}
              onChange={(event) => Number.isFinite(event.target.valueAsNumber) && patchStyle({ size: Math.min(12, Math.max(1, event.target.valueAsNumber)) })}
              step={0.1}
              type="number"
              value={style.size}
            />
            <span className="text-[rgba(0,0,0,0.45)]">% (영상 높이 기준)</span>
          </label>

          <span className="text-[rgba(0,0,0,0.5)]">위치</span>
          <div className="flex flex-wrap items-center gap-2">
            {SUBTITLE_POSITION_PRESETS.map((preset) => (
              <button className={style.position === preset.value ? activeChipClass : chipClass} key={preset.label} onClick={() => patchStyle({ position: preset.value })} type="button">
                {preset.label}
              </button>
            ))}
            <span className="text-[rgba(0,0,0,0.4)]">자막을 선택하면 화면에서 끌어서 옮길 수 있어요</span>
          </div>

          <span className="text-[rgba(0,0,0,0.5)]">색</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {SUBTITLE_COLORS.map((color) => (
              <button
                aria-label={`자막 색 ${color}`}
                className="h-5 w-5 cursor-pointer rounded-full"
                key={color}
                onClick={() => patchStyle({ color })}
                style={{ background: color, border: style.color.toLowerCase() === color.toLowerCase() ? '2px solid #5b4bff' : '1px solid rgba(0,0,0,0.25)' }}
                type="button"
              />
            ))}
            <label className="ml-1 flex cursor-pointer items-center gap-1 text-[rgba(0,0,0,0.55)]" title="팔레트에서 직접 고르기">
              <input aria-label="자막 색 직접 고르기" className="h-6 w-7 cursor-pointer border-0 bg-transparent p-0" onChange={(event) => patchStyle({ color: event.target.value.toUpperCase() })} type="color" value={style.color} />
              직접 고르기
            </label>
            <label className="ml-2 flex cursor-pointer items-center gap-1">
              <input checked={style.box} onChange={(event) => patchStyle({ box: event.target.checked })} type="checkbox" />
              배경 박스
            </label>
          </div>

          {hasTranslation && (
            <>
              <span className="text-[rgba(0,0,0,0.5)]">언어</span>
              <label className="flex cursor-pointer items-center gap-1">
                <input checked={style.bilingual} onChange={(event) => patchStyle({ bilingual: event.target.checked })} type="checkbox" />
                원문과 번역을 두 줄로 함께 표시 (원문 위, 번역 아래)
              </label>
            </>
          )}
        </div>
      )}

      {error && <p className="px-5 pb-2 text-[12px] text-[#d33]">{error}</p>}
      {notice && !error && <p className="px-5 pb-2 text-[12px] text-[rgba(0,0,0,0.6)]">{notice}</p>}

      {cues.length === 0 && !generating && !error && !notice && (
        <p className="px-5 pb-3 text-[12px] text-[rgba(0,0,0,0.4)]">
          {disabled ? '분석이 끝난 영상에서 자막을 만들 수 있어요.' : '말소리를 인식하거나 시나리오로 자막을 만들 수 있어요. 시간은 위 파형 아래 자막 줄에서 끌어서 조절해요.'}
        </p>
      )}

      <div className="flex flex-col gap-1.5 px-5 pb-3">
        {cues.map((cue, index) => (
          <div
            className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 ${cue.id === selectedCueId ? 'border-black/50 bg-[rgba(0,0,0,0.04)]' : 'border-[rgba(0,0,0,0.08)]'}`}
            key={cue.id}
            onMouseDown={() => cue.id !== selectedCueId && onCueSelect(cue.id)}
          >
            <span className="w-4 shrink-0 pt-0.5 text-right font-mono text-[10px] text-[rgba(0,0,0,0.35)]">{index + 1}</span>
            <div className="flex flex-1 flex-col gap-0.5">
              <textarea
                aria-label={`자막 ${index + 1}`}
                className="min-h-[24px] resize-none border-0 bg-transparent p-0 text-[13px] leading-snug outline-none"
                onChange={(event) => onCueChange(cue.id, event.target.value)}
                placeholder="자막 내용을 입력하세요"
                rows={Math.max(1, Math.ceil(cue.text.length / 28))}
                value={cue.text}
              />
              {cue.original && <span className="text-[11px] leading-snug text-[rgba(0,0,0,0.4)]">{cue.original}</span>}
              {cue.id === selectedCueId && (
                <span className="text-[10.5px] text-[rgba(0,0,0,0.4)]">
                  영상 화면에서 자막을 끌어 위치를 옮길 수 있어요.
                  {(cue.x !== undefined || cue.y !== undefined) && (
                    <button className="ml-1.5 cursor-pointer border-0 bg-transparent p-0 text-[10.5px] text-[rgba(0,0,0,0.55)] underline hover:text-black" onClick={() => onCuePositionReset(cue.id)} type="button">
                      기본 위치로
                    </button>
                  )}
                </span>
              )}
            </div>
            <button
              aria-label={`자막 ${index + 1} 삭제`}
              className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[14px] leading-none text-[rgba(0,0,0,0.3)] hover:text-[#d33]"
              onClick={() => onCueDelete(cue.id)}
              type="button"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {cues.length > 0 && (
        <div className="px-5 pb-3 text-right">
          <button className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-[rgba(0,0,0,0.45)] underline hover:text-black" onClick={onDownload} type="button">
            SRT 파일만 받기
          </button>
        </div>
      )}
    </div>
  );
}
