import { useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { motion } from 'framer-motion';
import Icon from '@/components/Icon';
import MonoLabel from '@/components/MonoLabel';
import { icons } from '@/components/icons';
import { fadeInUp } from '@/lib/animations';
import { formatClock } from '@/lib/highlights';
import { cn } from '@/lib/cn';
import type { FindMethod, ScenarioItem } from '@/types/app';

/** 왼쪽(영상)·오른쪽(방법) 패널이 같이 쓰는 고정 높이. 탭을 바꿔도 변하지 않는다. */
export const UPLOAD_PANEL_HEIGHT = 470;

const METHODS: { id: FindMethod; icon: keyof typeof icons; title: string; sub: string }[] = [
  { id: 'manual', icon: 'text', title: '직접 입력', sub: '내가 장면을 적어요' },
  { id: 'recommend', icon: 'sparkles', title: '추천받기', sub: 'AI가 구성을 제안' },
  { id: 'highlight', icon: 'zap', title: '하이라이트', sub: '시나리오 없이 자동' },
];

const METHOD_DESC: Record<FindMethod, string> = {
  manual: '찾고 싶은 장면을 순서대로 적어 주세요.',
  recommend: '영상을 보고 AI가 제목과 장면 구성을 추천해요.',
  highlight: '시나리오 없이 영상 전체에서 반응이 큰 구간을 골라요.',
};

const EXAMPLE_CHIPS = ['재료 손질', '볶기 시작', '간 맞추기', '플레이팅'];

// 하이라이트 탭의 예시 그림. 실제 결과가 아니라 "이런 식으로 구간을 골라요"를 보여 주는 장식이다.
const EXAMPLE_WAVE = Array.from({ length: 88 }, (_, i) => 4 + Math.abs(Math.sin(i * 0.38 + 0.9) * 18) + Math.abs(Math.cos(i * 0.7) * 8));
/** [왼쪽 %, 너비 %] */
const EXAMPLE_RANGES: [number, number][] = [
  [2.7, 4],
  [7.4, 4],
  [42.3, 4],
];

function DragDots() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" fill="none" aria-hidden="true">
      {[2, 6, 10].flatMap((x) => [3, 7, 11].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r={1.2} fill="#000" />))}
    </svg>
  );
}

interface MethodPanelProps {
  accent: string;
  panelPadding: string;
  accentTint: string;
  method: FindMethod;
  onMethodChange: (method: FindMethod) => void;
  items: ScenarioItem[];
  onItemsChange: (updater: ScenarioItem[] | ((current: ScenarioItem[]) => ScenarioItem[])) => void;
  videoDurationLabel?: string;
}

const nextId = (list: ScenarioItem[]) => list.reduce((max, item) => Math.max(max, item.id), 0) + 1;

export default function MethodPanel({ accent, panelPadding, accentTint, method, onMethodChange, items, onItemsChange, videoDurationLabel }: MethodPanelProps) {
  const [inputValue, setInputValue] = useState('');
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isHighlight = method === 'highlight';
  const isRecommend = method === 'recommend';
  const isGuide = isHighlight || isRecommend;

  const addItem = (value = inputValue) => {
    const text = value.trim();
    if (!text) return;
    onItemsChange((current) => [...current, { id: nextId(current), ko: text, en: text }]);
    setInputValue('');
    inputRef.current?.focus();
  };

  const updateItem = (id: number, text: string) => onItemsChange((current) => current.map((item) => (item.id === id ? { ...item, ko: text, en: text, rec: false, start: undefined, end: undefined } : item)));
  const removeItem = (id: number) => onItemsChange((current) => current.filter((item) => item.id !== id));
  const finishEdit = (id: number) => {
    setEditingId(null);
    onItemsChange((current) => (current.some((item) => item.id === id && !item.ko.trim()) ? current.filter((item) => item.id !== id) : current));
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      addItem();
    }
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>, id: number) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (id !== draggingId) setOverId(id);
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>, targetId: number) => {
    event.preventDefault();
    if (draggingId === null || draggingId === targetId) return;
    onItemsChange((current) => {
      const next = [...current];
      const from = next.findIndex((item) => item.id === draggingId);
      const to = next.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return current;
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setDraggingId(null);
    setOverId(null);
  };

  const ghostCount = Math.max(0, 8 - items.length);

  return (
    <motion.section
      className={cn('flex flex-col rounded-[14px] border border-line-soft bg-white', panelPadding)}
      style={{ height: UPLOAD_PANEL_HEIGHT }}
      variants={fadeInUp}
    >
      <div className="mb-3.5 flex items-center gap-2">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[rgba(0,0,0,0.18)]" />
        <MonoLabel>02 - 찾는 방법 선택</MonoLabel>
      </div>

      <div role="tablist" aria-label="찾는 방법" className="mb-2.5 grid grid-cols-3 gap-2">
        {METHODS.map((entry) => {
          const on = method === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={on}
              data-testid={`method-tab-${entry.id}`}
              onClick={() => onMethodChange(entry.id)}
              className={cn(
                'flex cursor-pointer flex-col items-start gap-2 rounded-xl border-[1.5px] px-3 py-2.5 text-left transition-[border-color,background] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashed focus-visible:outline-black',
                !on && 'border-line-app bg-white hover:border-[rgba(0,0,0,0.3)]',
              )}
              style={on ? { borderColor: accent, background: `${accent}0f` } : undefined}
            >
              <span
                className={cn('flex h-7 w-7 items-center justify-center rounded-full transition-colors', !on && 'bg-glass text-ink-56')}
                style={on ? { background: accent, color: '#fff' } : undefined}
              >
                <Icon d={icons[entry.icon]} size={14} strokeWidth={1.8} />
              </span>
              <span>
                <span className="block text-[13.5px] font-[540] tracking-[-0.2px]" style={{ color: on ? accent : '#000' }}>
                  {entry.title}
                </span>
                <span className="mt-0.5 block text-[11.5px] tracking-[-0.1px] text-ink-56">{entry.sub}</span>
              </span>
            </button>
          );
        })}
      </div>

      <p className="mb-3 min-h-5 text-[13px] leading-[1.5] tracking-[-0.1px] text-ink-56">{METHOD_DESC[method]}</p>

      {/* 하이라이트 · 추천받기: 시나리오 입력 없이 시작하고, 결과 화면에서 고른다 */}
      {isGuide && (
        <div className="flex flex-1 flex-col justify-evenly gap-2.5 rounded-[10px] border border-dashed border-line-app bg-[rgba(0,0,0,0.022)] px-[18px] py-3.5">
          <div>
            <div className="mb-2 flex justify-between">
              <MonoLabel>Full video · 00:00 – {videoDurationLabel ?? '--:--'}</MonoLabel>
              <MonoLabel>예시</MonoLabel>
            </div>
            <div className="relative flex h-[52px] items-center overflow-hidden rounded-lg border border-line-soft bg-white px-0.5" aria-hidden="true">
              {EXAMPLE_WAVE.map((value, index) => (
                <div key={index} className="flex-1 rounded-[1px] bg-[rgba(0,0,0,0.12)]" style={{ height: Math.max(3, value * 0.85) }} />
              ))}
              {EXAMPLE_RANGES.map(([left, width]) => (
                <div
                  key={left}
                  className="absolute inset-y-0"
                  style={{ left: `${left}%`, width: `${width}%`, background: `${accent}30`, borderLeft: `2px solid ${accent}` }}
                />
              ))}
            </div>
          </div>
          {(isRecommend
            ? ([
                ['장면을 직접 적지 않아도 바로 시작해요', 'sparkles'],
                ['AI가 영상을 훑어 제목과 장면 구성을 만들어요', 'history'],
                ['결과 화면에서 쓸 장면만 골라요', 'check'],
              ] as const)
            : ([
                ['시나리오 입력 없이 바로 시작해요', 'zap'],
                ['영상 전체 길이를 분석해요', 'history'],
                ['결과 화면에서 쓸 구간만 골라요', 'check'],
              ] as const)
          ).map(([text, icon]) => (
            <div key={text} className="flex items-center gap-2.5 text-[13px] tracking-[-0.1px] text-ink-72">
              <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full" style={{ background: `${accent}14`, color: accent }}>
                <Icon d={icons[icon]} size={12} strokeWidth={2} />
              </span>
              {text}
            </div>
          ))}
        </div>
      )}

      {/* 빈 상태 */}
      {!isGuide && items.length === 0 && (
        <div className="mb-3 flex flex-1 flex-col items-center justify-center gap-2.5 rounded-[10px] border border-dashed border-line-app bg-[rgba(0,0,0,0.022)] px-5 py-3">
          <div className="relative h-[34px] w-[52px] shrink-0" aria-hidden="true">
            {[2, 1, 0].map((stack) => (
              <div
                key={stack}
                className="absolute h-[22px] rounded-[7px] border border-[rgba(0,0,0,0.07)]"
                style={{ top: stack * 4, left: stack * 4, right: -(stack * 4), background: stack === 0 ? 'rgba(0,0,0,0.06)' : stack === 1 ? 'rgba(0,0,0,0.04)' : 'rgba(0,0,0,0.025)' }}
              />
            ))}
          </div>
          <div className="text-center">
            <div className="mb-[5px] text-sm font-[490] tracking-[-0.2px] text-ink-56">아직 입력된 장면이 없어요</div>
            <div className="text-[12.5px] leading-[1.5] tracking-[-0.1px] text-ink-56">
              {method === 'manual' ? (
                <>
                  아래 입력창에 장면 이름을 입력하고
                  <br />
                  Enter 또는 + 버튼으로 추가하세요.
                </>
              ) : null}
            </div>
          </div>
          {method === 'manual' && (
            <div className="flex flex-wrap justify-center gap-1.5">
              {EXAMPLE_CHIPS.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="cursor-pointer rounded-full border border-line-app bg-white px-3 py-[5px] text-[11.5px] text-ink-56 transition-colors hover:border-[var(--cc-chip)] hover:text-[var(--cc-chip)]"
                  style={{ ['--cc-chip' as string]: accent }}
                  onClick={() => {
                    setInputValue(example);
                    inputRef.current?.focus();
                  }}
                >
                  {example}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 목록: 추천 항목과 직접 쓴 항목 모두 고칠 수 있다 */}
      {!isGuide && items.length > 0 && (
        <div className="mb-3 flex min-h-0 flex-1 flex-col gap-[5px] overflow-y-auto pr-0.5" data-testid="scenario-list">
          {items.map((item, index) => {
            const isDragging = draggingId === item.id;
            const isOver = overId === item.id;
            const isEditing = editingId === item.id;
            return (
              <div
                key={item.id}
                draggable={!isEditing}
                onDragStart={(event) => {
                  setDraggingId(item.id);
                  event.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(event) => handleDragOver(event, item.id)}
                onDrop={(event) => handleDrop(event, item.id)}
                onDragEnd={() => {
                  setDraggingId(null);
                  setOverId(null);
                }}
                className={cn(
                  'flex shrink-0 animate-[fadeIn_0.3s_ease] items-center gap-2.5 rounded-lg border py-2 pr-3 pl-3.5 transition-[border-color,background,transform,box-shadow,opacity] duration-150',
                  isEditing ? 'cursor-text' : 'cursor-grab',
                )}
                style={{
                  borderColor: isOver || isEditing ? accent : item.rec ? `${accent}33` : isDragging ? 'rgba(0,0,0,0.05)' : 'rgba(0,0,0,0.08)',
                  background: isOver ? accentTint : item.rec ? `${accent}07` : isDragging ? 'rgba(0,0,0,0.025)' : '#fff',
                  opacity: isDragging ? 0.4 : 1,
                  transform: isOver ? 'translateY(-1px)' : 'none',
                  boxShadow: isOver ? `0 4px 12px ${accent}22` : 'none',
                }}
              >
                <div className="flex shrink-0 items-center pr-0.5 opacity-25" aria-hidden="true">
                  <DragDots />
                </div>
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] transition-colors"
                  style={{ background: isOver ? accent : 'rgba(0,0,0,0.06)', color: isOver ? '#fff' : 'rgba(0,0,0,0.56)' }}
                >
                  {index + 1}
                </span>
                <input
                  value={item.ko}
                  aria-label={`장면 ${index + 1}`}
                  data-testid="scenario-item-input"
                  onChange={(event) => updateItem(item.id, event.target.value)}
                  onFocus={() => setEditingId(item.id)}
                  onBlur={() => finishEdit(item.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur();
                  }}
                  className="min-w-0 flex-1 border-0 bg-transparent px-0 py-[3px] text-[13.5px] tracking-[-0.1px] text-black outline-none"
                />
                {item.rec && item.start !== undefined && item.end !== undefined && (
                  <span className="shrink-0 font-mono text-[10.5px] text-ink-56" data-testid="scenario-item-range">
                    {formatClock(item.start)}–{formatClock(item.end)}
                  </span>
                )}
                {item.rec && (
                  <span className="shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-[540] tracking-[0.2px]" style={{ background: `${accent}1c`, color: accent }}>
                    추천
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeItem(item.id)}
                  aria-label={`장면 ${index + 1} 삭제`}
                  className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent opacity-40 transition-opacity hover:opacity-80"
                >
                  <Icon d={icons.trash} size={12} stroke="#000" />
                </button>
              </div>
            );
          })}

          {ghostCount > 0 && (
            <div
              aria-hidden="true"
              className="flex min-h-0 flex-[1_1_0] flex-col gap-[5px] overflow-hidden"
              style={{ WebkitMaskImage: 'linear-gradient(to bottom, #000 30%, transparent)', maskImage: 'linear-gradient(to bottom, #000 30%, transparent)' }}
            >
              {Array.from({ length: ghostCount }).map((_, index) => (
                <div key={index} className="flex h-10 shrink-0 items-center gap-2.5 rounded-lg border border-dashed border-line-strong py-0 pr-3.5 pl-9">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-line-strong font-mono text-[10px] text-ink-40">{items.length + index + 1}</span>
                  <span className="text-[12.5px] tracking-[-0.1px] text-ink-40">장면을 추가해 보세요</span>
                </div>
              ))}
            </div>
          )}

        </div>
      )}

      {/* 아래 컨트롤은 고른 방법에 따라 달라진다 */}
      {method === 'manual' && (
        <div className="mt-auto flex gap-2">
          <div
            className="flex flex-1 items-center gap-2 rounded-[10px] bg-white px-3.5 py-2.5 transition-colors"
            style={{ border: `1.5px solid ${isInputFocused ? accent : 'rgba(0,0,0,0.12)'}` }}
          >
            <Icon d={icons.plus} size={14} stroke={isInputFocused ? accent : 'rgba(0,0,0,0.4)'} />
            <input
              ref={inputRef}
              className="min-w-0 flex-1 border-0 bg-transparent text-[13.5px] tracking-[-0.1px] text-black outline-none placeholder:text-ink-56"
              data-testid="scenario-input"
              onBlur={() => setIsInputFocused(false)}
              onChange={(event) => setInputValue(event.target.value)}
              onFocus={() => setIsInputFocused(true)}
              onKeyDown={handleInputKeyDown}
              placeholder="장면 이름 입력 (예: 재료 손질)"
              value={inputValue}
            />
          </div>
          <button
            type="button"
            className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[10px] border-0 transition-colors"
            data-testid="add-scenario-button"
            onClick={() => addItem()}
            style={{ background: inputValue.trim() ? accent : 'rgba(0,0,0,0.07)', cursor: inputValue.trim() ? 'pointer' : 'default' }}
            aria-label="시나리오에 추가"
          >
            <Icon d={icons.plus} size={16} stroke={inputValue.trim() ? '#fff' : 'rgba(0,0,0,0.4)'} strokeWidth={2} />
          </button>
        </div>
      )}

    </motion.section>
  );
}
