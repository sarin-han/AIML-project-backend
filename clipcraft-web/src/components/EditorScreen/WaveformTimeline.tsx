import { useEffect, useRef, useState } from 'react';
import type { DragEvent, MouseEvent } from 'react';
import { cueUsedBySegments, readCueDragData } from '@/lib/subtitles';
import Icon from '@/components/Icon';
import MonoLabel from '@/components/MonoLabel';
import type { WaveformTimelineProps } from '@/types/pages/EditorScreen';
import type { OverlaySegment } from '@/types/app';

const overlayColors = [
  { bg: 'rgba(254,243,199,0.82)', border: '#F59E0B', text: '#92400E' },
  { bg: 'rgba(209,250,229,0.82)', border: '#10B981', text: '#065F46' },
  { bg: 'rgba(254,226,226,0.82)', border: '#EF4444', text: '#991B1B' },
];

/** 확대했을 때 한 화면에 보이는 가장 짧은 길이(초) */
const MIN_VIEW_SECONDS = 3;
const ZOOM_STEP = 1.6;
/** 자막 끝을 끌 때 클립 경계 등에 붙는 거리(화면 픽셀) */
const SNAP_PIXELS = 10;

function formatTime(seconds: number, fine = false): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);

  if (fine) return `${String(minutes).padStart(2, '0')}:${(safe % 60).toFixed(1).padStart(4, '0')}`;

  const rounded = Math.round(safe);
  return `${String(Math.floor(rounded / 60)).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`;
}

export default function WaveformTimeline({
  accent,
  activeCueId,
  duration,
  onCueAdd,
  onCueDrop,
  onCueMove,
  onCueSelect,
  onCueTimeChange,
  onSegmentChange,
  onSegmentPick,
  onSubtitleTrackToggle,
  activeSegmentId,
  subtitleTrackOpen,
  progress,
  segments,
  selectedCueId,
  setPlaying,
  setProgress,
  subtitleCues,
  waveHeights: heights,
}: WaveformTimelineProps) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 1;
  const [dropActive, setDropActive] = useState(false);
  const [snapTime, setSnapTime] = useState<number | null>(null);
  const [zoomRaw, setZoomRaw] = useState(1);
  const [viewStartRaw, setViewStartRaw] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // 보기 구간: 전체 길이를 zoom으로 나눈 길이만큼만 보이고, viewStart부터 시작한다.
  const maxZoom = Math.max(1, safeDuration / MIN_VIEW_SECONDS);
  const zoom = Math.min(maxZoom, Math.max(1, zoomRaw));
  const viewLength = safeDuration / zoom;
  const viewStart = Math.min(Math.max(0, viewStartRaw), Math.max(0, safeDuration - viewLength));
  const viewEnd = viewStart + viewLength;
  const zoomed = zoom > 1.001;
  const fineLabels = viewLength < 40;

  const toPercent = (time: number) => ((time - viewStart) / viewLength) * 100;
  const fromRatio = (ratio: number) => viewStart + Math.min(1, Math.max(0, ratio)) * viewLength;
  const visible = (start: number, end: number) => end > viewStart && start < viewEnd;

  // 휠 이벤트는 passive가 아니어야 브라우저 확대를 막을 수 있어서 직접 등록한다. 최신 값은 ref로 읽는다.
  const viewRef = useRef({ maxZoom, safeDuration, viewLength, viewStart, zoom });
  viewRef.current = { maxZoom, safeDuration, viewLength, viewStart, zoom };

  const zoomTo = (nextZoom: number, anchorTime: number, anchorRatio: number) => {
    const { maxZoom: max, safeDuration: total } = viewRef.current;
    const clamped = Math.min(max, Math.max(1, nextZoom));
    const nextLength = total / clamped;

    setZoomRaw(clamped);
    setViewStartRaw(Math.min(Math.max(0, anchorTime - anchorRatio * nextLength), Math.max(0, total - nextLength)));
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onWheel = (event: WheelEvent) => {
      const track = container.querySelector('[data-view-track]');
      if (!track) return;

      const current = viewRef.current;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoomTo(current.zoom * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), current.viewStart + ratio * current.viewLength, ratio);
      } else if (current.zoom > 1.001 && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault();
        setViewStartRaw(Math.min(Math.max(0, current.viewStart + (event.deltaX / rect.width) * current.viewLength), current.safeDuration - current.viewLength));
      }
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
    // zoomTo는 ref만 읽으므로 한 번만 등록한다.
  }, []);

  // 확대한 상태에서 재생 위치가 보기 구간을 벗어나면 따라간다.
  useEffect(() => {
    if (zoom <= 1.001) return;

    const time = progress * safeDuration;
    if (time < viewStart || time > viewEnd) setViewStartRaw(Math.max(0, time - viewLength * 0.25));
    // 보기 구간을 직접 옮기는 동안에는 따라가지 않도록 재생 위치가 바뀔 때만 확인한다.
  }, [progress]);

  const playheadTime = progress * safeDuration;
  const zoomByButton = (factor: number) => {
    const anchorInView = playheadTime >= viewStart && playheadTime <= viewEnd;
    const anchorTime = anchorInView ? playheadTime : viewStart + viewLength / 2;
    zoomTo(zoom * factor, anchorTime, (anchorTime - viewStart) / viewLength);
  };
  const zoomToRange = (start: number, end: number) => {
    const length = Math.max(MIN_VIEW_SECONDS, (end - start) * 1.6);
    const nextZoom = Math.min(maxZoom, Math.max(1, safeDuration / length));
    const nextLength = safeDuration / nextZoom;

    setZoomRaw(nextZoom);
    setViewStartRaw(Math.min(Math.max(0, (start + end) / 2 - nextLength / 2), Math.max(0, safeDuration - nextLength)));
  };
  const selectedCue = subtitleCues.find((cue) => cue.id === selectedCueId);

  const segmentRanges = segments.map((segment) => ({ start: segment.start, end: segment.end }));
  const timeMarks = Array.from({ length: 9 }, (_, index) => formatTime(viewStart + (viewLength / 8) * index, fineLabels));

  // 막대 개수는 그대로 두고, 보기 구간에 해당하는 값을 보간해서 채운다.
  const sample = (time: number) => {
    const position = Math.min(heights.length - 1, Math.max(0, (time / safeDuration) * heights.length - 0.5));
    const low = Math.floor(position);
    const high = Math.min(heights.length - 1, low + 1);
    return heights[low] + (heights[high] - heights[low]) * (position - low);
  };
  const viewHeights = heights.map((_, index) => sample(viewStart + ((index + 0.5) / heights.length) * viewLength));

  const markers = segments
    .flatMap((segment, listIndex) => [
      { id: `${segment.id}-start`, edge: 'start' as const, listIndex, segmentId: segment.id, time: segment.start },
      { id: `${segment.id}-end`, edge: 'end' as const, listIndex, segmentId: segment.id, time: segment.end },
    ])
    .sort((a, b) => a.time - b.time);
  const overlaySegments: OverlaySegment[] = segments.flatMap((segment) => {
    if (!visible(segment.start, segment.end)) return [];

    const colors = overlayColors[(segment.id - 1 + overlayColors.length * 1000) % overlayColors.length];
    const left = Math.max(0, toPercent(segment.start));
    const right = Math.min(100, toPercent(segment.end));

    return [
      {
        left,
        width: Math.max(1, right - left),
        id: segment.id,
        label: segment.scenario,
        sub: `${formatTime(segment.start, fineLabels)}-${formatTime(segment.end, fineLabels)}`,
        ...colors,
      },
    ];
  });

  const startMarkerDrag = (event: MouseEvent<HTMLButtonElement>, segmentId: number, edge: 'start' | 'end', listIndex: number) => {
    event.preventDefault();
    event.stopPropagation();
    setPlaying(false);

    const track = event.currentTarget.parentElement;
    if (!track) return;

    const rect = track.getBoundingClientRect();
    const updateTime = (clientX: number) => {
      const time = fromRatio((clientX - rect.left) / rect.width);
      onSegmentChange(segmentId, edge, time);
      setProgress(time / safeDuration);
    };
    const onMove = (moveEvent: globalThis.MouseEvent) => updateTime(moveEvent.clientX);
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    onSegmentPick(listIndex);
    updateTime(event.clientX);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  /** 목록에서 끌어온 자막을 파형 위에 놓으면, 놓은 가로 위치를 시간으로 바꿔 알려 준다. */
  const handleCueDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropActive(false);

    const cueId = readCueDragData(event.dataTransfer);
    const track = event.currentTarget.querySelector('[data-cue-track]');
    if (cueId === null || !track) return;

    const rect = track.getBoundingClientRect();
    onCueDrop(cueId, fromRatio((event.clientX - rect.left) / rect.width));
  };

  /** 자막 막대의 가장자리(길이 조절) 또는 몸통(통째로 이동)을 드래그한다. 움직임 없이 놓으면 그 위치로 이동만 한다. */
  const startCueDrag = (event: MouseEvent<HTMLElement>, cueId: number, mode: 'start' | 'end' | 'move') => {
    event.preventDefault();
    event.stopPropagation();
    setPlaying(false);
    onCueSelect(cueId);

    const track = event.currentTarget.closest('[data-cue-track]');
    const cue = subtitleCues.find((item) => item.id === cueId);
    if (!track || !cue) return;

    const rect = track.getBoundingClientRect();
    const originX = event.clientX;
    const originStart = cue.start;
    const cueLength = cue.end - cue.start;
    const lengthAtStart = viewLength;
    let moved = false;
    const toTime = (clientX: number) => fromRatio((clientX - rect.left) / rect.width);

    // 붙을 곳: 선택한 장면(클립)의 시작·끝, 다른 자막의 시작·끝, 재생 위치, 영상 처음·끝
    const snapTargets = [
      0,
      safeDuration,
      playheadTime,
      ...segments.flatMap((segment) => [segment.start, segment.end]),
      ...subtitleCues.filter((other) => other.id !== cueId).flatMap((other) => [other.start, other.end]),
    ];
    const snapDistance = (SNAP_PIXELS / rect.width) * lengthAtStart;
    const nearestTarget = (time: number) => {
      let best: { distance: number; target: number } | null = null;

      for (const target of snapTargets) {
        const distance = Math.abs(target - time);
        if (distance <= snapDistance && (!best || distance < best.distance)) best = { distance, target };
      }

      return best;
    };

    const onMove = (moveEvent: globalThis.MouseEvent) => {
      if (Math.abs(moveEvent.clientX - originX) > 2) moved = true;
      if (!moved) return;

      // Alt를 누르고 있으면 붙지 않고 자유롭게 움직인다.
      const snapping = !moveEvent.altKey;

      if (mode === 'move') {
        const rawStart = originStart + ((moveEvent.clientX - originX) / rect.width) * lengthAtStart;
        const byStart = snapping ? nearestTarget(rawStart) : null;
        const byEnd = snapping ? nearestTarget(rawStart + cueLength) : null;
        let nextStart = rawStart;
        let line: number | null = null;

        if (byStart && (!byEnd || byStart.distance <= byEnd.distance)) {
          nextStart = byStart.target;
          line = byStart.target;
        } else if (byEnd) {
          nextStart = byEnd.target - cueLength;
          line = byEnd.target;
        }

        setSnapTime(line);
        onCueMove(cueId, nextStart);
      } else {
        const raw = toTime(moveEvent.clientX);
        const hit = snapping ? nearestTarget(raw) : null;
        const time = hit ? hit.target : raw;

        setSnapTime(hit ? hit.target : null);
        onCueTimeChange(cueId, mode, time);
        setProgress(time / safeDuration);
      }
    };
    const onUp = () => {
      if (!moved) setProgress(originStart / safeDuration);
      setSnapTime(null);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const playheadPercent = toPercent(playheadTime);
  const playheadVisible = playheadPercent >= 0 && playheadPercent <= 100;
  const zoomButtonClass =
    'flex h-6 min-w-6 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-black/5 px-2 text-[11.5px] leading-none whitespace-nowrap text-black/60 hover:bg-black/10 disabled:cursor-default disabled:opacity-35';

  return (
    <div className="flex flex-col gap-2 px-5 pt-3 pb-3.5 max-[900px]:px-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <MonoLabel>Timeline</MonoLabel>
        <button
          aria-expanded={subtitleTrackOpen}
          className="inline-flex h-6 flex-none cursor-pointer items-center gap-[5px] rounded-full border-0 bg-black/5 px-2.5 text-[11.5px] font-[480] whitespace-nowrap text-black/65"
          data-testid="subtitle-track-toggle"
          onClick={onSubtitleTrackToggle}
          type="button"
        >
          자막 트랙<span className="opacity-50">{subtitleCues.length}</span>
          <span className="inline-flex transition-transform" style={{ transform: subtitleTrackOpen ? 'rotate(180deg)' : 'none' }}>
            <Icon d="M6 9l6 6 6-6" size={12} strokeWidth={1.6} />
          </span>
        </button>
        <div className="flex-1" />
        <div className="flex flex-none items-center gap-1.5">
          {selectedCue && subtitleTrackOpen && (
            <button className={zoomButtonClass} onClick={() => zoomToRange(selectedCue.start, selectedCue.end)} title="선택한 자막 구간을 확대해서 보기" type="button">
              자막 확대
            </button>
          )}
          <button aria-label="파형 축소" className={zoomButtonClass} disabled={!zoomed} onClick={() => zoomByButton(1 / ZOOM_STEP)} title="축소 (⌘/Ctrl + 스크롤)" type="button">
            −
          </button>
          <span className="w-9 text-center font-mono text-[11px] text-black/50">×{zoom.toFixed(1)}</span>
          <button aria-label="파형 확대" className={zoomButtonClass} disabled={zoom >= maxZoom - 0.001} onClick={() => zoomByButton(ZOOM_STEP)} title="확대 (⌘/Ctrl + 스크롤)" type="button">
            +
          </button>
          <button className={zoomButtonClass} disabled={!zoomed} onClick={() => zoomTo(1, 0, 0)} title="전체 보기" type="button">
            전체
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className={`relative overflow-hidden rounded-[8px] border bg-[#f6f6f5] ${dropActive ? 'border-[#5b4bff] ring-2 ring-[#5b4bff]/40' : 'border-[rgba(0,0,0,0.08)]'}`}
        onDragLeave={() => setDropActive(false)}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropActive(true);
        }}
        onDrop={handleCueDrop}
      >
        {snapTime !== null && toPercent(snapTime) >= 0 && toPercent(snapTime) <= 100 && (
          <div className="pointer-events-none absolute top-0 bottom-0 z-[6] w-[2px] -translate-x-1/2" style={{ background: '#5b4bff', boxShadow: '0 0 6px rgba(91,75,255,0.6)', left: `${toPercent(snapTime)}%` }} />
        )}
        <div className="relative h-5 border-b border-[rgba(0,0,0,0.08)] bg-[#efeeed]">
          {markers.map((marker) => {
            const position = toPercent(marker.time);
            if (position < 0 || position > 100) return null;

            const markerColor = overlayColors[(marker.segmentId - 1 + overlayColors.length * 1000) % overlayColors.length].border;

            return (
              <button
                key={marker.id}
                aria-label={`${marker.listIndex + 1}번 ${marker.edge === 'start' ? '시작' : '끝'} 지점 조절`}
                data-testid={marker.edge === 'start' ? 'segment-start-input' : 'segment-end-input'}
                className="absolute top-1/2 z-[4] flex h-[13px] w-[13px] cursor-ew-resize items-center justify-center rounded-full border-0 p-0 font-mono text-[6.5px] font-bold text-white transition-transform hover:scale-125"
                onMouseDown={(event) => startMarkerDrag(event, marker.segmentId, marker.edge, marker.listIndex)}
                style={{
                  background: markerColor,
                  border: marker.segmentId === activeSegmentId ? '2px solid #000' : 'none',
                  left: `${position}%`,
                  transform: 'translate(-50%,-50%)',
                  zIndex: marker.segmentId === activeSegmentId ? 5 : 4,
                }}
                title="좌우로 드래그해서 구간을 조절"
                type="button"
              >
                {marker.listIndex + 1}
              </button>
            );
          })}
        </div>

        <div
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setProgress(fromRatio((event.clientX - rect.left) / rect.width) / safeDuration);
            setPlaying(false);
          }}
          data-view-track
          className="relative flex h-[50px] cursor-crosshair items-center gap-px px-0.5 py-[3px]"
        >
          {viewHeights.map((height, index) => (
            <div
              key={index}
              className="relative z-[1] flex-1 rounded-px"
              style={{
                background: viewStart + ((index + 0.5) / viewHeights.length) * viewLength < playheadTime ? `${accent}8c` : 'rgba(0,0,0,0.10)',
                height: Math.min(42, Math.max(4, height)),
              }}
            />
          ))}

          {overlaySegments.map((segment) => (
            <div
              key={segment.id}
              className="absolute top-0 bottom-0 z-[2] flex flex-col items-start justify-center overflow-hidden border-l-2 border-r-2 px-1"
              style={{
                background: segment.bg,
                borderLeftColor: segment.border,
                borderRightColor: segment.border,
                outline: segment.id === activeSegmentId ? `1.5px solid ${segment.border}` : 'none',
                outlineOffset: -1.5,
                left: `${segment.left}%`,
                width: `${segment.width}%`,
              }}
            >
              <span className="font-mono text-[6.5px] leading-[1.4] font-semibold whitespace-nowrap" style={{ color: segment.text }}>
                {segment.label}
              </span>
              <span className="font-mono text-[6px] leading-[1.4] whitespace-nowrap" style={{ color: `${segment.text}aa` }}>
                {segment.sub}
              </span>
            </div>
          ))}

          {playheadVisible && <div className="pointer-events-none absolute top-0 bottom-0 z-[4] w-[1.5px]" style={{ background: accent, left: `${playheadPercent}%` }} />}
        </div>

        {subtitleTrackOpen && <div
          className="relative h-[30px] border-t border-[rgba(0,0,0,0.08)] bg-[#faf9f8]"
          data-cue-track
          onDoubleClick={(event) => {
            if (event.target !== event.currentTarget) return;

            const rect = event.currentTarget.getBoundingClientRect();
            onCueAdd(fromRatio((event.clientX - rect.left) / rect.width));
          }}
          title="빈 곳을 더블클릭하면 그 위치에 자막을 추가해요"
        >
          {subtitleCues.length === 0 && (
            <span className="pointer-events-none absolute inset-0 flex items-center px-2 font-mono text-[7.5px] text-[rgba(0,0,0,0.28)]">자막 · 빈 곳을 더블클릭해서 추가하거나, 자막을 만들면 여기에 표시돼요.</span>
          )}
          {subtitleCues.map((cue) => {
            if (!visible(cue.start, cue.end)) return null;

            const clippedLeft = cue.start < viewStart;
            const clippedRight = cue.end > viewEnd;
            const left = Math.max(0, toPercent(cue.start));
            const right = Math.min(100, toPercent(cue.end));
            const width = Math.max(0.6, right - left);
            const active = cue.id === activeCueId;
            const selected = cue.id === selectedCueId;
            const used = cueUsedBySegments(cue, segmentRanges);

            return (
              <div
                key={cue.id}
                className="absolute top-[4px] bottom-[4px] z-[2] flex cursor-grab items-center overflow-hidden rounded-[4px] border"
                onMouseDown={(event) => startCueDrag(event, cue.id, 'move')}
                style={{
                  background: active || selected ? `${accent}33` : 'rgba(0,0,0,0.07)',
                  borderColor: selected ? accent : active ? `${accent}88` : 'rgba(0,0,0,0.22)',
                  borderStyle: used || selected ? 'solid' : 'dashed',
                  borderWidth: selected ? 2 : 1,
                  opacity: used || selected ? 1 : 0.45,
                  left: `${left}%`,
                  width: `${width}%`,
                }}
                title={used ? cue.text : `${cue.text} (선택한 장면 밖이라 내보내기에 쓰이지 않아요)`}
              >
                {!clippedLeft && (
                  <button
                    aria-label={`자막 ${cue.id} 시작 조절`}
                    className="absolute top-0 bottom-0 left-0 z-[3] w-[6px] cursor-ew-resize border-0 bg-transparent p-0 hover:bg-black/20"
                    onMouseDown={(event) => startCueDrag(event, cue.id, 'start')}
                    type="button"
                  />
                )}
                <span className="pointer-events-none truncate px-2 text-[8px] leading-none text-[rgba(0,0,0,0.65)]">{cue.text || '(빈 자막)'}</span>
                {!clippedRight && (
                  <button
                    aria-label={`자막 ${cue.id} 종료 조절`}
                    className="absolute top-0 right-0 bottom-0 z-[3] w-[6px] cursor-ew-resize border-0 bg-transparent p-0 hover:bg-black/20"
                    onMouseDown={(event) => startCueDrag(event, cue.id, 'end')}
                    type="button"
                  />
                )}
              </div>
            );
          })}
          {playheadVisible && <div className="pointer-events-none absolute top-0 bottom-0 z-[4] w-[1.5px]" style={{ background: accent, left: `${playheadPercent}%` }} />}
        </div>}

        <div className="flex justify-between border-t border-[rgba(0,0,0,0.08)] bg-[#efeeed] px-1.5 py-[3px]">
          {timeMarks.map((time, index) => (
            <span key={index} className="font-mono text-[6.5px]" style={{ color: index % 3 === 0 ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.13)' }}>
              {index % 2 === 0 ? time : '·'}
            </span>
          ))}
        </div>

        {zoomed && (
          <div className="border-t border-[rgba(0,0,0,0.08)] bg-[#efeeed] px-1.5 py-1">
            <input
              aria-label="파형 보기 위치"
              className="block h-2 w-full cursor-pointer"
              max={Math.max(0, safeDuration - viewLength)}
              min={0}
              onChange={(event) => setViewStartRaw(Number(event.target.value))}
              step={safeDuration / 1000}
              style={{ accentColor: accent }}
              type="range"
              value={viewStart}
            />
          </div>
        )}
      </div>

      {zoomed && <span className="font-mono text-[8px] text-[rgba(0,0,0,0.35)]">보는 구간 {formatTime(viewStart, true)} ~ {formatTime(viewEnd, true)} · ⌘/Ctrl + 스크롤로 확대·축소, 좌우 스크롤로 이동</span>}
    </div>
  );
}
