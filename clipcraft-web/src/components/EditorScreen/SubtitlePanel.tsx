import { useEffect, useState } from 'react';
import { SUGGEST_TONE_OPTIONS } from '@/api/suggest';
import type { SuggestTone } from '@/api/suggest';
import { cueUsedBySegments, EXTRA_LANGUAGES, formatCueTime, SUBTITLE_COLORS, SUBTITLE_FONT_OPTIONS, SUBTITLE_POSITION_PRESETS } from '@/lib/subtitles';
import type { SubtitleSetKey, SubtitleStyle } from '@/lib/subtitles';
import type { SubtitleCue } from '@/types/app';

const SUBTITLE_LANGUAGES = [
  { value: '', label: '자동 감지' },
  { value: 'ko', label: '한국어' },
  { value: 'en', label: '영어' },
] as const;

interface SubtitlePanelProps {
  extraBusy: boolean;
  onAddExtraLanguage: (language: string) => void;
  onRemoveExtraLanguage: () => void;
  /** 지금 선택한 클립(하이라이트 구간). 없으면 null */
  activeClip: { end: number; index: number; start: number } | null;
  focusCueId: number | null;
  onCueAdd: () => void;
  onCueFitToClip: (cueId: number) => void;
  onDeleteOutside: () => void;
  onFocusHandled: () => void;
  segmentRanges: Array<{ start: number; end: number }>;
  activeSet: SubtitleSetKey;
  onActiveSetChange: (key: SubtitleSetKey) => void;
  scenarioCount: number;
  voiceCount: number;
  cues: SubtitleCue[];
  disabled: boolean;
  error: string | null;
  generating: boolean;
  language: string;
  notice: string | null;
  onCueChange: (cueId: number, text: string) => void;
  onCuePatch: (cueId: number, patch: Partial<SubtitleCue>) => void;
  onCueTimeChange: (cueId: number, edge: 'start' | 'end', time: number) => void;
  onCueDelete: (cueId: number) => void;
  onCueStyleReset: (cueId: number) => void;
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

const chipClass = 'cursor-pointer rounded-lg border border-[rgba(0,0,0,0.12)] bg-white px-3 py-1 text-[12px] hover:bg-[rgba(0,0,0,0.04)] disabled:cursor-not-allowed disabled:opacity-40';
const activeChipClass = 'cursor-pointer rounded-lg border border-black bg-black px-3 py-1 text-[12px] text-white disabled:cursor-not-allowed disabled:opacity-40';
const inputClass = 'w-[64px] rounded-md border border-[rgba(0,0,0,0.15)] px-2 py-1 text-[12px]';

/** 시간을 누르면 숫자 입력으로 바뀌고, Enter나 바깥 클릭으로 적용한다(초 단위). */
function TimeField({ label, onCommit, value }: { label: string; onCommit: (seconds: number) => void; value: number }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const commit = () => {
    const seconds = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(seconds)) onCommit(seconds);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        aria-label={label}
        autoFocus
        className="w-[64px] rounded-md border border-black/40 px-1.5 py-0.5 font-mono text-[11px]"
        min={0}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setEditing(false);
        }}
        step={0.1}
        type="number"
        value={draft}
      />
    );
  }

  return (
    <button
      aria-label={label}
      className="cursor-pointer rounded-md border border-[rgba(0,0,0,0.15)] bg-white px-1.5 py-0.5 font-mono text-[11px] hover:border-black/50"
      onClick={() => {
        setDraft(value.toFixed(1));
        setEditing(true);
      }}
      title="눌러서 시간 수정 (초 단위로 입력)"
      type="button"
    >
      {formatCueTime(value)}
    </button>
  );
}

export default function SubtitlePanel({
  extraBusy,
  onAddExtraLanguage,
  onRemoveExtraLanguage,
  activeClip,
  focusCueId,
  onCueAdd,
  onCueFitToClip,
  onDeleteOutside,
  onFocusHandled,
  segmentRanges,
  activeSet,
  onActiveSetChange,
  scenarioCount,
  voiceCount,
  cues,
  disabled,
  error,
  generating,
  language,
  notice,
  onCueChange,
  onCueDelete,
  onCuePatch,
  onCueTimeChange,
  onCueStyleReset,
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
  const [openSection, setOpenSection] = useState<'create' | null>(null);
  const [createMode, setCreateMode] = useState<'voice' | 'scenario' | null>(null);
  // scene: 선택한 클립(없으면 선택한 모든 장면)의 자막만, all: 전체 자막
  const [viewMode, setViewMode] = useState<'scene' | 'all'>('scene');
  const [styleTarget, setStyleTarget] = useState<'selected' | 'default'>('default');
  const hasTranslation = cues.some((cue) => cue.original);
  const hasExtra = cues.some((cue) => cue.extra !== undefined);
  // 선택한 장면(하이라이트 구간) 안에 걸친 자막만 내보내기에 쓰인다.
  const usedCueIds = new Set(cues.filter((cue) => cueUsedBySegments(cue, segmentRanges)).map((cue) => cue.id));
  const outsideCount = cues.length - usedCueIds.size;
  const sceneRanges = activeClip ? [{ start: activeClip.start, end: activeClip.end }] : segmentRanges;
  const sceneCueCount = cues.filter((cue) => cueUsedBySegments(cue, sceneRanges)).length;
  const sceneLabel = activeClip ? `클립 ${activeClip.index + 1}의 자막` : '선택한 장면의 자막';
  const visibleCues = cues.filter((cue) => viewMode === 'all' || cueUsedBySegments(cue, sceneRanges) || cue.id === selectedCueId);
  const selectedIndex = cues.findIndex((cue) => cue.id === selectedCueId);
  const selectedCue = selectedIndex >= 0 ? cues[selectedIndex] : undefined;
  // 기본은 모든 자막의 기본 스타일을 편집한다. 자막을 고른 뒤 "자막 N번만"을 누르면 그 자막만 편집한다.
  const editingCue = styleTarget === 'selected' ? selectedCue : undefined;
  const shownStyle: SubtitleStyle = editingCue?.style ? { ...style, ...editingCue.style } : style;
  const shownPosition = editingCue ? (editingCue.y ?? style.position) : style.position;
  const hasOwnStyle = Boolean(selectedCue && (selectedCue.style || selectedCue.x !== undefined || selectedCue.y !== undefined));

  useEffect(() => {
    setStyleTarget('default');
  }, [selectedCueId]);

  // 방금 추가한 자막의 입력칸이 그려진 뒤에는 포커스 요청을 비운다.
  useEffect(() => {
    if (focusCueId !== null) onFocusHandled();
  }, [focusCueId]);

  const patchStyle = (patch: Partial<Pick<SubtitleStyle, 'font' | 'size' | 'color' | 'box'>>) => {
    if (editingCue) onCuePatch(editingCue.id, { style: { ...editingCue.style, ...patch } });
    else onStyleChange({ ...style, ...patch });
  };
  const patchGlobal = (patch: Partial<SubtitleStyle>) => onStyleChange({ ...style, ...patch });
  const setPosition = (value: number) => {
    if (editingCue) onCuePatch(editingCue.id, { x: undefined, y: value });
    else patchGlobal({ position: value });
  };
  const toggleSection = (section: 'create') => {
    setCreateMode(null);
    setOpenSection((current) => (current === section ? null : section));
  };
  const busy = generating || suggesting;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-wrap items-center gap-2 px-5 py-2.5">
        <span className="text-[13px] font-[520] tracking-[-0.1px]">자막</span>
        <span className="font-mono text-[10px] text-[rgba(0,0,0,0.4)]">{cues.length > 0 ? `${cues.length}개` : ''}</span>
        <button className={openSection === 'create' || busy ? activeChipClass : chipClass} disabled={busy || (disabled && suggestDisabled)} onClick={() => toggleSection('create')} type="button">
          {generating ? `음성 인식 중... ${progress}%` : suggesting ? '시나리오로 만드는 중...' : '자동 자막 생성하기'}
        </button>
        <button className={chipClass} disabled={disabled} onClick={onCueAdd} title="지금 재생 위치에 빈 자막을 추가해요. 파형 아래 자막 줄의 빈 곳을 더블클릭해도 돼요." type="button">
          + 자막 추가
        </button>
      </div>

      {voiceCount > 0 && scenarioCount > 0 && (
        <div className="mx-5 mb-2 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-[rgba(0,0,0,0.5)]">보여줄 자막</span>
          <button className={activeSet === 'voice' ? activeChipClass : chipClass} onClick={() => onActiveSetChange('voice')} type="button">
            음성 자막 {voiceCount}
          </button>
          <button className={activeSet === 'scenario' ? activeChipClass : chipClass} onClick={() => onActiveSetChange('scenario')} type="button">
            시나리오 자막 {scenarioCount}
          </button>
          <span className="text-[rgba(0,0,0,0.4)]">편집·내보내기에는 지금 고른 자막이 쓰여요.</span>
        </div>
      )}

      {openSection === 'create' && (
        <div className="mx-5 mb-2 flex flex-col gap-2.5 rounded-lg border border-[rgba(0,0,0,0.08)] p-3 text-[12px]">
          <span className="text-[rgba(0,0,0,0.5)]">어떤 방법으로 자막을 만들까요? 두 가지를 모두 만들면 버튼으로 전환할 수 있어요.</span>
          <div className="flex flex-wrap items-center gap-2">
            <button className={createMode === 'voice' ? activeChipClass : chipClass} disabled={disabled} onClick={() => setCreateMode('voice')} title="영상 속 말소리를 인식해서 자막을 만들어요" type="button">
              음성대로 만들기
            </button>
            <button className={createMode === 'scenario' ? activeChipClass : chipClass} disabled={suggestDisabled} onClick={() => setCreateMode('scenario')} title="분석에 입력한 시나리오 문장으로 자막 문구를 만들어요" type="button">
              시나리오대로 만들기
            </button>
          </div>

          {createMode === 'voice' && (
            <div className="flex flex-wrap items-center gap-3 border-t border-[rgba(0,0,0,0.06)] pt-2.5">
              <span className="text-[rgba(0,0,0,0.5)]">말소리 언어</span>
              <select aria-label="음성 언어" className={`${chipClass} px-2`} onChange={(event) => onLanguageChange(event.target.value)} value={language}>
                {SUBTITLE_LANGUAGES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <label className="flex cursor-pointer items-center gap-1">
                <input checked={translate} onChange={(event) => onTranslateChange(event.target.checked)} type="checkbox" />
                한국어로 번역
              </label>
              <button
                className="cursor-pointer rounded-lg border-0 bg-black px-3 py-1 text-[12px] text-white"
                onClick={() => {
                  setOpenSection(null);
                  setCreateMode(null);
                  onGenerate();
                }}
                type="button"
              >
                만들기
              </button>
              {voiceCount > 0 && <span className="text-[rgba(0,0,0,0.4)]">기존 음성 자막은 새로 만든 자막으로 바뀌어요.</span>}
            </div>
          )}

          {createMode === 'scenario' && (
            <div className="flex flex-wrap items-center gap-2 border-t border-[rgba(0,0,0,0.06)] pt-2.5">
              <span className="text-[rgba(0,0,0,0.5)]">어떤 느낌으로? 고르면 바로 만들어요.</span>
              {SUGGEST_TONE_OPTIONS.map((option) => (
                <button
                  className={chipClass}
                  key={option.value}
                  onClick={() => {
                    setOpenSection(null);
                    setCreateMode(null);
                    onSuggest(option.value);
                  }}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
              {scenarioCount > 0 && <span className="text-[rgba(0,0,0,0.4)]">기존 시나리오 자막은 새로 만든 자막으로 바뀌어요. 음성 자막은 그대로 남아요.</span>}
            </div>
          )}
        </div>
      )}

      {cues.length > 0 && (
        <div className="mx-5 mb-2 grid grid-cols-[48px_1fr] items-center gap-x-3 gap-y-2.5 rounded-lg border border-[rgba(0,0,0,0.08)] p-3 text-[12px]">
          <span className="col-span-2 text-[12px] font-[520]">자막 꾸미기</span>

          {selectedCue && (
            <>
              <span className="text-[rgba(0,0,0,0.5)]">대상</span>
              <div className="flex flex-wrap items-center gap-2">
                <button className={!editingCue ? activeChipClass : chipClass} onClick={() => setStyleTarget('default')} type="button">
                  전체 기본값
                </button>
                <button className={editingCue ? activeChipClass : chipClass} onClick={() => setStyleTarget('selected')} type="button">
                  자막 {selectedIndex + 1}번만
                </button>
              </div>
            </>
          )}

          <span className="text-[rgba(0,0,0,0.5)]">폰트</span>
          <select className={`${chipClass} w-full`} onChange={(event) => patchStyle({ font: event.target.value })} value={shownStyle.font}>
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
              value={shownStyle.size}
            />
            <span className="text-[rgba(0,0,0,0.45)]">% (영상 높이 기준)</span>
          </label>

          <span className="text-[rgba(0,0,0,0.5)]">위치</span>
          <div className="flex flex-wrap items-center gap-2">
            {SUBTITLE_POSITION_PRESETS.map((preset) => (
              <button className={shownPosition === preset.value && (!editingCue || editingCue.x === undefined) ? activeChipClass : chipClass} key={preset.label} onClick={() => setPosition(preset.value)} type="button">
                {preset.label}
              </button>
            ))}
            {editingCue && editingCue.x !== undefined && editingCue.x !== 50 && (
              <button className={chipClass} onClick={() => onCuePatch(editingCue.id, { x: 50 })} type="button">
                가로 가운데
              </button>
            )}
            <label className="flex cursor-pointer items-center gap-1 text-[rgba(0,0,0,0.55)]" title="화면에서 자막을 끌 때 가운데·1/4 지점·여백선에 딱 맞춰요. Alt를 누르면 자유롭게 움직여요.">
              <input checked={style.snap} onChange={(event) => patchGlobal({ snap: event.target.checked })} type="checkbox" />
              격자에 맞추기
            </label>
          </div>

          <span className="text-[rgba(0,0,0,0.5)]">색</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {SUBTITLE_COLORS.map((color) => (
              <button
                aria-label={`자막 색 ${color}`}
                className="h-5 w-5 cursor-pointer rounded-full"
                key={color}
                onClick={() => patchStyle({ color })}
                style={{ background: color, border: shownStyle.color.toLowerCase() === color.toLowerCase() ? '2px solid #5b4bff' : '1px solid rgba(0,0,0,0.25)' }}
                type="button"
              />
            ))}
            <label className="ml-1 flex cursor-pointer items-center gap-1 text-[rgba(0,0,0,0.55)]" title="팔레트에서 직접 고르기">
              <input aria-label="자막 색 직접 고르기" className="h-6 w-7 cursor-pointer border-0 bg-transparent p-0" onChange={(event) => patchStyle({ color: event.target.value.toUpperCase() })} type="color" value={shownStyle.color} />
              직접 고르기
            </label>
            <label className="ml-2 flex cursor-pointer items-center gap-1">
              <input checked={shownStyle.box} onChange={(event) => patchStyle({ box: event.target.checked })} type="checkbox" />
              배경 박스
            </label>
          </div>

          {editingCue && hasOwnStyle && (
            <>
              <span />
              <div className="flex flex-wrap items-center gap-2">
                <button className={chipClass} onClick={() => onCueStyleReset(editingCue.id)} type="button">
                  이 자막 스타일 초기화
                </button>
              </div>
            </>
          )}

          <span className="text-[rgba(0,0,0,0.5)]">추가 언어</span>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="추가 언어" className={`${chipClass} px-2`} disabled={extraBusy} onChange={(event) => patchGlobal({ extraLang: event.target.value })} value={style.extraLang}>
              {EXTRA_LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.label}
                </option>
              ))}
            </select>
            <button className={chipClass} disabled={extraBusy} onClick={() => onAddExtraLanguage(style.extraLang)} title="지금 자막을 이 언어로 번역해서 아래 줄에 추가해요" type="button">
              {extraBusy ? '변환 중...' : hasExtra ? '이 언어로 다시 변환' : '이 언어로 자막 추가'}
            </button>
            {hasExtra && (
              <>
                <label className="flex cursor-pointer items-center gap-1">
                  <input checked={style.showExtra} onChange={(event) => patchGlobal({ showExtra: event.target.checked })} type="checkbox" />
                  아래 줄에 표시
                </label>
                <button className="cursor-pointer border-0 bg-transparent p-0 text-[11.5px] text-[rgba(0,0,0,0.55)] underline hover:text-black" onClick={onRemoveExtraLanguage} type="button">
                  지우기
                </button>
              </>
            )}
          </div>

          {hasTranslation && (
            <>
              <span className="text-[rgba(0,0,0,0.5)]">언어</span>
              <label className="flex cursor-pointer items-center gap-1">
                <input checked={style.bilingual} onChange={(event) => patchGlobal({ bilingual: event.target.checked })} type="checkbox" />
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

      {cues.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-5 pb-2 text-[11.5px] text-[rgba(0,0,0,0.55)]">
          <button className={viewMode === 'scene' ? activeChipClass : chipClass} onClick={() => setViewMode('scene')} type="button">
            {sceneLabel} {sceneCueCount}
          </button>
          <button className={viewMode === 'all' ? activeChipClass : chipClass} onClick={() => setViewMode('all')} type="button">
            전체 자막 보기 {cues.length}
          </button>
          <span className="text-[rgba(0,0,0,0.4)]">
            장면 안 {usedCueIds.size}개{outsideCount > 0 ? ` · 장면 밖 ${outsideCount}개 (내보내기에 안 쓰여요)` : ''}
          </span>
          {outsideCount > 0 && (
            <button className="cursor-pointer border-0 bg-transparent p-0 text-[11.5px] text-[rgba(0,0,0,0.55)] underline hover:text-black" onClick={onDeleteOutside} type="button">
              장면 밖 자막 지우기
            </button>
          )}
        </div>
      )}

      {cues.length > 0 && visibleCues.length === 0 && <p className="px-5 pb-3 text-[12px] text-[rgba(0,0,0,0.4)]">{activeClip ? `클립 ${activeClip.index + 1}에는` : '선택한 장면 안에는'} 자막이 없어요. "전체 자막 보기"를 누르면 모든 자막이 보여요.</p>}

      <div className="flex flex-col gap-1.5 px-5 pb-3">
        {visibleCues.map((cue, visibleIndex) => {
          // 클립별로 보면 그 클립 안에서 1번부터, 전체로 보면 전체 순서대로 번호를 붙인다.
          const index = viewMode === 'all' ? cues.indexOf(cue) : visibleIndex;

          return (
          <div
            className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 ${cue.id === selectedCueId ? 'border-black/50 bg-[rgba(0,0,0,0.04)]' : 'border-[rgba(0,0,0,0.08)]'} ${usedCueIds.has(cue.id) ? '' : 'opacity-55'}`}
            key={cue.id}
            onMouseDown={() => cue.id !== selectedCueId && onCueSelect(cue.id)}
          >
            <span className="flex w-6 shrink-0 flex-col items-center pt-0.5 font-mono text-[10px] text-[rgba(0,0,0,0.35)] select-none">{index + 1}</span>
            <div className="flex flex-1 flex-col gap-0.5">
              <textarea
                aria-label={`자막 ${index + 1}`}
                autoFocus={cue.id === focusCueId}
                className="min-h-[40px] resize-none border-0 bg-transparent p-0 text-[13px] leading-snug outline-none"
                onChange={(event) => onCueChange(cue.id, event.target.value)}
                placeholder="자막 내용을 입력하세요"
                rows={Math.max(2, cue.text.split('\n').length, Math.ceil(cue.text.length / 28))}
                value={cue.text}
              />
              {cue.original && <span className="text-[11px] leading-snug text-[rgba(0,0,0,0.4)]">{cue.original}</span>}
              {cue.extra !== undefined && (
                <textarea
                  aria-label={`자막 ${index + 1} 추가 언어`}
                  className="min-h-[20px] resize-none rounded border border-dashed border-[rgba(0,0,0,0.15)] bg-transparent px-1.5 py-0.5 text-[12px] leading-snug text-[rgba(0,0,0,0.65)] outline-none"
                  onChange={(event) => onCuePatch(cue.id, { extra: event.target.value })}
                  placeholder="아래 줄 자막"
                  rows={Math.max(1, Math.ceil(cue.extra.length / 30))}
                  value={cue.extra}
                />
              )}
              {cue.id === selectedCueId && (
                <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-[rgba(0,0,0,0.45)]">
                  구간
                  <TimeField label={`자막 ${index + 1} 시작 시간`} onCommit={(seconds) => onCueTimeChange(cue.id, 'start', seconds)} value={cue.start} />
                  ~
                  <TimeField label={`자막 ${index + 1} 종료 시간`} onCommit={(seconds) => onCueTimeChange(cue.id, 'end', seconds)} value={cue.end} />
                  {/* 시나리오 자막은 장면(클립)에 맞춰 만들어지므로 이 버튼은 시나리오 자막에서만 보인다. */}
                  {activeSet === 'scenario' && (
                    <button
                      className="cursor-pointer rounded-md border border-[rgba(0,0,0,0.15)] bg-white px-1.5 py-0.5 text-[10.5px] text-[rgba(0,0,0,0.6)] hover:border-black/50"
                      disabled={segmentRanges.length === 0}
                      onClick={() => onCueFitToClip(cue.id)}
                      title="이 자막의 시작·끝을 겹치는 장면(클립) 길이에 맞춰요"
                      type="button"
                    >
                      클립 길이에 맞추기
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
          );
        })}
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
