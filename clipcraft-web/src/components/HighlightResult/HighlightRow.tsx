import Icon from '@/components/Icon';
import { icons } from '@/components/icons';
import { formatClock } from '@/lib/highlights';
import type { HighlightCandidate } from '@/types/app';

interface HighlightRowProps {
  accent: string;
  highlight: HighlightCandidate;
  thumbnail?: string;
  selected: boolean;
  active: boolean;
  onToggle: () => void;
  onFocus: () => void;
}

/** 하이라이트 구간 한 줄: 체크박스, 64×40 썸네일, 라벨, mm:ss – mm:ss · N초 */
export default function HighlightRow({ accent, highlight, thumbnail, selected, active, onToggle, onFocus }: HighlightRowProps) {
  const seconds = Math.round(highlight.end - highlight.start);

  return (
    <div
      className="flex items-center gap-3 rounded-[10px] border px-3 py-2.5 transition-[border-color,background] duration-150"
      data-testid="highlight-row"
      data-selected={selected}
      style={{ borderColor: active ? accent : 'rgba(0,0,0,0.08)', background: active ? `${accent}0a` : '#fff' }}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`${highlight.label} ${selected ? '제외' : '포함'}`}
        data-testid="highlight-check"
        onClick={onToggle}
        className="flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center rounded-full p-0 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashed focus-visible:outline-black"
        style={{ border: `1.5px solid ${selected ? accent : 'rgba(0,0,0,0.28)'}`, background: selected ? accent : '#fff' }}
      >
        {selected && <Icon d={icons.check} size={12} stroke="#fff" strokeWidth={2.6} />}
      </button>

      <button
        type="button"
        onClick={onFocus}
        aria-current={active}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 border-0 bg-transparent p-0 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashed focus-visible:outline-black"
      >
        <span className="h-10 w-16 shrink-0 overflow-hidden rounded-md bg-stage" aria-hidden="true">
          {thumbnail && <img src={thumbnail} alt="" className="h-full w-full object-cover" style={{ filter: selected ? 'none' : 'grayscale(0.7)' }} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-[480] tracking-[-0.1px]">{highlight.label}</span>
          <span className="mt-[3px] block font-mono text-[11.5px] text-ink-56">
            {formatClock(highlight.start)} – {formatClock(highlight.end)} · {seconds}초
          </span>
        </span>
      </button>
    </div>
  );
}
