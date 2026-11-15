import { useEffect, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import type { HighlightListProps } from '@/types/pages/EditorScreen';

function formatTime(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const rest = safeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** 구간 색은 목록 순서가 아니라 구간 id를 따라 3색이 돈다(순서를 바꿔도 색은 그대로). */
const SEGMENT_COLORS = ['#F59E0B', '#10B981', '#EF4444'];

function DragHandle() {
  return (
    <svg aria-hidden="true" width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
      {[3, 8, 13].map((y) => (
        <g key={y}>
          <circle cx="2.5" cy={y} r="1.3" />
          <circle cx="7.5" cy={y} r="1.3" />
        </g>
      ))}
    </svg>
  );
}

export default function HighlightList({ activeSegment, currentTime, onSegmentClick, onSegmentDelete, onSegmentsReorder, segmentEditSettings, segments, thumbnails }: HighlightListProps) {
  const [draggingSegmentId, setDraggingSegmentId] = useState<number | null>(null);
  const [hoverSegmentId, setHoverSegmentId] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousCount = useRef(segments.length);

  // 새 시나리오가 목록 끝에 추가되면 목록 맨 아래로 스크롤한다.
  useEffect(() => {
    if (segments.length > previousCount.current && listRef.current) {
      listRef.current.scrollTo({ top: listRef.current.scrollHeight });
    }
    previousCount.current = segments.length;
  }, [segments.length]);

  const handleDragStart = (event: DragEvent<HTMLDivElement>, segmentId: number) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(segmentId));
    setDraggingSegmentId(segmentId);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>, segmentId: number) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (segmentId !== draggingSegmentId) setHoverSegmentId(segmentId);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, targetIndex: number) => {
    event.preventDefault();

    const draggedId = draggingSegmentId ?? Number(event.dataTransfer.getData('text/plain'));
    const fromIndex = segments.findIndex((segment) => segment.id === draggedId);

    if (fromIndex !== -1 && fromIndex !== targetIndex) {
      onSegmentsReorder(fromIndex, targetIndex);
    }

    setDraggingSegmentId(null);
    setHoverSegmentId(null);
  };

  const stopDragging = () => {
    setDraggingSegmentId(null);
    setHoverSegmentId(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    if (event.target !== event.currentTarget) return;

    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      onSegmentsReorder(index, index + (event.key === 'ArrowUp' ? -1 : 1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSegmentClick(index);
    }
  };

  const playingIndex = segments.findIndex((segment) => currentTime >= segment.start && currentTime < segment.end);

  return (
    <div className="ed-list" ref={listRef}>
      {segments.length > 1 && <div className="flex-none px-0.5 pb-0.5 text-[11px] text-black/40">드래그해서 순서를 바꿔요 · 위에서부터 차례로 이어 붙여요</div>}
      {segments.length === 0 && (
        <div className="m-auto text-center text-[13px] leading-[1.6] text-black/40">
          시나리오가 없어요.
          <br />
          아래에서 찾고 싶은 장면을 입력해 보세요.
        </div>
      )}
      {segments.map((segment, index) => {
        const color = SEGMENT_COLORS[(segment.id - 1 + SEGMENT_COLORS.length * 1000) % SEGMENT_COLORS.length];
        const isActive = activeSegment === index || playingIndex === index;
        const editSetting = segmentEditSettings.find((setting) => setting.segmentId === segment.id);
        const hasEditBadge = Boolean(editSetting && (editSetting.speed !== 1 || editSetting.muted));
        const scoreLabel = typeof segment.score === 'number' ? `${Math.round(segment.score * 100)}%` : null;
        const isDragging = draggingSegmentId === segment.id;
        const isDragTarget = hoverSegmentId === segment.id && draggingSegmentId !== segment.id;
        const title = segment.title ?? segment.scenario;

        return (
          <div
            aria-label={`${index + 1}번 ${title}. Alt+위/아래 화살표로 순서 변경`}
            className="ed-row"
            data-active={isActive ? 'true' : 'false'}
            data-testid="result-card"
            draggable
            key={`${segment.sourceId}-${segment.id}-${segment.scenario}-${segment.start}`}
            onClick={() => onSegmentClick(index)}
            onDragEnd={stopDragging}
            onDragOver={(event) => handleDragOver(event, segment.id)}
            onDragStart={(event) => handleDragStart(event, segment.id)}
            onDrop={(event) => handleDrop(event, index)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            role="button"
            style={{
              background: isActive ? `${color}0f` : '#fff',
              borderColor: isActive ? color : undefined,
              boxShadow: isDragTarget ? '0 -2px 0 0 #5b4cf5' : 'none',
              opacity: isDragging ? 0.4 : 1,
            }}
            tabIndex={0}
          >
            <span aria-hidden="true" className="ed-grip">
              <DragHandle />
            </span>
            <span className="w-1 flex-none self-stretch rounded-sm" style={{ background: color }} />
            <div className="relative h-9 w-14 flex-none overflow-hidden rounded-md bg-black">
              {thumbnails[segment.id] ? <img alt="" className="absolute inset-0 h-full w-full object-cover" src={thumbnails[segment.id]} /> : <span aria-label="썸네일 불러오는 중" className="absolute inset-0 flex items-center justify-center" role="status">
                  <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.2)" strokeWidth="3" />
                    <path d="M21 12a9 9 0 0 0-9-9" stroke="white" strokeLinecap="round" strokeWidth="3" />
                  </svg>
                </span>}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="flex h-4 w-4 flex-none items-center justify-center rounded-full font-mono text-[9px] font-bold text-white" style={{ background: color }}>
                  {index + 1}
                </span>
                <span className="truncate text-[13px] font-[480] tracking-[-0.1px]" title={title}>
                  {title}
                </span>
              </div>
              <div className="mt-[3px] flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[11px] whitespace-nowrap text-black/[0.42]">
                <span>
                  <span data-testid="result-start-time">{formatTime(segment.start)}</span> – <span data-testid="result-end-time">{formatTime(segment.end)}</span>
                </span>
                {scoreLabel && <span data-testid="result-score">score {scoreLabel}</span>}
                {hasEditBadge && editSetting?.speed !== 1 && (
                  <span data-testid="playback-rate-indicator" className="rounded-full px-1.5 py-[1px] text-[9px] font-semibold" style={{ background: `${color}18`, color }}>
                    {editSetting?.speed}배속
                  </span>
                )}
                {hasEditBadge && editSetting?.muted && (
                  <span data-testid="mute-indicator" className="rounded-full bg-black/8 px-1.5 py-[1px] text-[9px] font-semibold text-black/55">
                    음소거
                  </span>
                )}
              </div>
            </div>
            <button
              aria-label={`${title} 삭제`}
              className="ed-rm ed-ibtn"
              data-testid="result-delete"
              onClick={(event) => {
                event.stopPropagation();
                onSegmentDelete(segment.id);
              }}
              style={{ height: 24, width: 24 }}
              title="삭제"
              type="button"
            >
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
