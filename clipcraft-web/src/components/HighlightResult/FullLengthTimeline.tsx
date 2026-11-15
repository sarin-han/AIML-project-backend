import { useRef } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import MonoLabel from '@/components/MonoLabel';
import { formatClock } from '@/lib/highlights';
import type { HighlightCandidate } from '@/types/app';

const FALLBACK_BAR_COUNT = 120;
const TICK_COUNT = 6;
const KEY_SEEK_SECONDS = 5;

interface FullLengthTimelineProps {
  accent: string;
  duration: number;
  highlights: HighlightCandidate[];
  selected: ReadonlySet<number>;
  activeId: number | null;
  /** 재생 위치(초) */
  position: number;
  /** 0~1 사이의 오디오 에너지. 비어 있으면 낮은 막대로 대신한다. */
  amplitudes: number[];
  onSeek: (seconds: number) => void;
  onFocusHighlight: (highlight: HighlightCandidate) => void;
}

const pct = (seconds: number, duration: number) => (duration > 0 ? Math.min(100, Math.max(0, (seconds / duration) * 100)) : 0);

/** 영상 전체 길이를 보여 주는 타임라인: 오디오 파형, 번호 핀, 선택(보라 덮개)/제외(해치) 구간, 눈금 */
export default function FullLengthTimeline({ accent, duration, highlights, selected, activeId, position, amplitudes, onSeek, onFocusHighlight }: FullLengthTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const bars = amplitudes.length > 0 ? amplitudes : Array.from({ length: FALLBACK_BAR_COUNT }, () => 0.05);

  const seekFromPointer = (event: MouseEvent<HTMLDivElement>) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    onSeek(Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration)));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      onSeek(Math.min(duration, position + KEY_SEEK_SECONDS));
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onSeek(Math.max(0, position - KEY_SEEK_SECONDS));
    }
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <MonoLabel>Full length timeline</MonoLabel>
        <span className="inline-flex items-center gap-2.5 text-[11px] text-ink-56">
          <span className="inline-flex items-center gap-[5px]">
            <span className="h-[9px] w-[9px] rounded-[2px]" style={{ background: `${accent}55`, border: `1px solid ${accent}` }} />
            선택
          </span>
          <span className="inline-flex items-center gap-[5px]">
            <span className="h-[9px] w-[9px] rounded-[2px] border border-dashed border-[rgba(0,0,0,0.35)] bg-glass" />
            제외
          </span>
        </span>
      </div>

      <div className="overflow-hidden rounded-[10px] border border-line-soft bg-[#fafafa]">
        {/* 번호 핀 */}
        <div className="relative h-[26px] border-b border-[rgba(0,0,0,0.05)] bg-[#f4f4f4]">
          {highlights.map((item, index) => {
            const on = selected.has(item.id);
            const isActive = activeId === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-label={`${item.label} 구간으로 이동`}
                onClick={() => onFocusHighlight(item)}
                className="absolute top-1/2 flex h-[17px] w-[17px] -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full p-0 font-mono text-[9px] font-[540] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashed focus-visible:outline-black"
                style={{
                  left: `${pct((item.start + item.end) / 2, duration)}%`,
                  background: on ? accent : '#fff',
                  color: on ? '#fff' : 'rgba(0,0,0,0.56)',
                  border: isActive ? '2px solid #000' : on ? 'none' : '1px dashed rgba(0,0,0,0.35)',
                }}
              >
                {index + 1}
              </button>
            );
          })}
        </div>

        {/* 파형 + 구간 덮개 + 재생 위치 */}
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="영상 전체 타임라인"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(position)}
          aria-valuetext={`${formatClock(position)} / ${formatClock(duration)}`}
          data-testid="full-timeline"
          onClick={seekFromPointer}
          onKeyDown={handleKeyDown}
          className="relative flex h-[104px] cursor-crosshair items-center px-0.5 py-1 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashed focus-visible:outline-black"
        >
          {bars.map((value, index) => (
            <div
              key={index}
              className="relative z-[1] mx-[0.4px] flex-1 rounded-[1px]"
              style={{
                height: Math.max(3, Math.min(1, Math.max(0, value)) * 92),
                background: index / bars.length < (duration > 0 ? position / duration : 0) ? `${accent}cc` : 'rgba(0,0,0,0.16)',
              }}
            />
          ))}
          {highlights.map((item) => {
            const on = selected.has(item.id);
            return (
              <div
                key={item.id}
                data-testid={`timeline-range-${item.id}`}
                data-selected={on}
                className="pointer-events-none absolute inset-y-0 z-[2]"
                style={{
                  left: `${pct(item.start, duration)}%`,
                  width: `${pct(item.end - item.start, duration)}%`,
                  background: on ? `${accent}26` : 'repeating-linear-gradient(135deg, rgba(0,0,0,0.07) 0 3px, rgba(0,0,0,0.02) 3px 6px)',
                  borderLeft: `2px ${on ? 'solid' : 'dashed'} ${on ? accent : 'rgba(0,0,0,0.35)'}`,
                  outline: activeId === item.id ? `1.5px solid ${accent}` : 'none',
                  outlineOffset: -1.5,
                }}
              />
            );
          })}
          <div className="pointer-events-none absolute inset-y-0 z-[4] w-[1.5px]" style={{ left: `${pct(position, duration)}%`, background: accent }} />
        </div>

        {/* 눈금 */}
        <div className="flex justify-between border-t border-line-soft bg-[#f4f4f4] px-1 py-[3px]" aria-hidden="true">
          {Array.from({ length: TICK_COUNT }, (_, index) => formatClock((index * duration) / (TICK_COUNT - 1))).map((label, index) => (
            <span key={index} className="font-mono text-[8.5px] text-ink-56">
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
