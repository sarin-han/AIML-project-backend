import { useEffect, useRef, useState } from 'react';
import type { DragEvent, MouseEvent } from 'react';
import type { RefObject } from 'react';
import { getAspectLabel, getAspectRatio } from '@/lib/aspect';
import type { AspectSetting } from '@/lib/aspect';
import { readCueDragData, SUBTITLE_FONT_OPTIONS } from '@/lib/subtitles';
import type { CueLines, SubtitleStyle } from '@/lib/subtitles';

interface VideoPreviewProps {
  /** 화면 비율. 기본은 올린 영상의 원래 비율 */
  aspect?: AspectSetting;
  /** true면 자막을 끌어서 옮길 수 있다(선택된 자막이 지금 보일 때) */
  draggable?: boolean;
  /** 목록에서 끌어온 자막을 화면에 놓았을 때(x: 가로 %, yCenter: 아래에서 자막 가운데까지 %) */
  onCueDrop?: (cueId: number, position: { x: number; yCenter: number }) => void;
  onSubtitleMove?: (position: { x: number; y: number }) => void;
  onSubtitleResize?: (size: number) => void;
  subtitlePosition?: { x?: number; y?: number };
  onEnded?: () => void;
  onLoadedMetadata?: () => void;
  onTimeUpdate?: () => void;
  subtitleLines?: CueLines;
  subtitleStyle: SubtitleStyle;
  videoRef?: RefObject<HTMLVideoElement | null>;
  videoUrl?: string;
}

interface Guides {
  x: number[];
  y: number[];
}

const SNAP_DISTANCE = 2.5;
/** 자막 가운데를 맞추는 격자선(%)과, 가장자리를 맞추는 여백선(%) */
const GRID_LINES = [25, 50, 75];
const MARGIN_X = 5;
const MARGIN_Y = 8;

/** 가장 가까운 격자선에 맞춘다. offset은 기준점(자막 가운데 아래)에서 맞출 지점까지의 거리. */
function snapAxis(position: number, targets: Array<{ offset: number; line: number }>): { guide: number | null; value: number } {
  let best: { distance: number; line: number; offset: number } | null = null;

  for (const target of targets) {
    const distance = Math.abs(position + target.offset - target.line);
    if (distance <= SNAP_DISTANCE && (!best || distance < best.distance)) best = { distance, line: target.line, offset: target.offset };
  }

  return best ? { guide: best.line, value: best.line - best.offset } : { guide: null, value: position };
}

interface FrameSize {
  height: number;
  width: number;
}

export default function VideoPreview({ aspect = 'source', draggable = false, onCueDrop, onEnded, onLoadedMetadata, onSubtitleMove, onSubtitleResize, onTimeUpdate, subtitleLines, subtitlePosition, subtitleStyle, videoRef, videoUrl }: VideoPreviewProps) {
  const [boxElement, setBoxElement] = useState<HTMLDivElement | null>(null);
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState<FrameSize | null>(null);
  const [sourceRatio, setSourceRatio] = useState<number | null>(null);
  const [fit, setFit] = useState<FrameSize | null>(null);
  const frameElementRef = useRef<HTMLDivElement>(null);
  const textElementRef = useRef<HTMLSpanElement>(null);
  const [guides, setGuides] = useState<Guides | null>(null);
  const [dropActive, setDropActive] = useState(false);

  // 영상은 object-contain으로 그려지므로, 자막 기준이 되는 "실제 영상 화면" 크기를 계산한다(내보낸 영상과 같은 비율).
  useEffect(() => {
    const video = videoRef?.current;
    if (!boxElement || !video) return;

    const measure = () => {
      if (!video.videoWidth || !video.videoHeight) return;

      setSourceRatio(video.videoWidth / video.videoHeight);
      const scale = Math.min(boxElement.clientWidth / video.videoWidth, boxElement.clientHeight / video.videoHeight);
      setFrame({ width: video.videoWidth * scale, height: video.videoHeight * scale });
    };
    const observer = new ResizeObserver(measure);

    observer.observe(boxElement);
    video.addEventListener('loadedmetadata', measure);
    measure();

    return () => {
      observer.disconnect();
      video.removeEventListener('loadedmetadata', measure);
    };
  }, [boxElement, videoRef, videoUrl]);

  const ratio = getAspectRatio(aspect, sourceRatio);

  // 사용 가능한 공간(컨테이너) 안에 선택한 비율의 화면을 가능한 크게 맞춘다.
  useEffect(() => {
    if (!containerElement) return;

    const measureFit = () => {
      const width = containerElement.clientWidth;
      const height = containerElement.clientHeight;
      if (!width || !height) return;

      setFit(width / height > ratio ? { height, width: height * ratio } : { height: width / ratio, width });
    };
    const observer = new ResizeObserver(measureFit);

    observer.observe(containerElement);
    measureFit();

    return () => observer.disconnect();
  }, [containerElement, ratio]);

  const fontOption = SUBTITLE_FONT_OPTIONS.find((option) => option.id === subtitleStyle.font) ?? SUBTITLE_FONT_OPTIONS[0];
  const fontPx = frame ? (subtitleStyle.size / 100) * frame.height : 0;

  const x = subtitlePosition?.x ?? 50;
  const y = subtitlePosition?.y ?? subtitleStyle.position;

  const startSubtitleDrag = (event: MouseEvent<HTMLDivElement>) => {
    const frameElement = frameElementRef.current;
    if (!draggable || !frameElement || !onSubtitleMove) return;

    event.preventDefault();
    const rect = frameElement.getBoundingClientRect();
    const textRect = textElementRef.current?.getBoundingClientRect();
    const widthPct = textRect ? (textRect.width / rect.width) * 100 : 0;
    const heightPct = textRect ? (textRect.height / rect.height) * 100 : 0;
    const origin = { clientX: event.clientX, clientY: event.clientY, x, y };

    setGuides({ x: [], y: [] });
    const onMove = (moveEvent: globalThis.MouseEvent) => {
      let nextX = origin.x + ((moveEvent.clientX - origin.clientX) / rect.width) * 100;
      let nextY = origin.y - ((moveEvent.clientY - origin.clientY) / rect.height) * 100;
      const hit: Guides = { x: [], y: [] };

      // Alt를 누르고 있으면 격자에 맞추지 않고 자유롭게 움직인다.
      if (subtitleStyle.snap && !moveEvent.altKey) {
        const snappedX = snapAxis(nextX, [...GRID_LINES.map((line) => ({ offset: 0, line })), { offset: -widthPct / 2, line: MARGIN_X }, { offset: widthPct / 2, line: 100 - MARGIN_X }]);
        const snappedY = snapAxis(nextY, [
          ...GRID_LINES.map((line) => ({ offset: heightPct / 2, line })),
          { offset: 0, line: MARGIN_Y },
          { offset: heightPct, line: 100 - MARGIN_Y },
        ]);

        nextX = snappedX.value;
        nextY = snappedY.value;
        if (snappedX.guide !== null) hit.x.push(snappedX.guide);
        if (snappedY.guide !== null) hit.y.push(snappedY.guide);
      }

      setGuides(hit);
      onSubtitleMove({ x: Math.min(95, Math.max(5, nextX)), y: Math.min(95, Math.max(0, nextY)) });
    };
    const onUp = () => {
      setGuides(null);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropActive(false);

    const cueId = readCueDragData(event.dataTransfer);
    if (cueId === null || !boxElement || !frame || !onCueDrop) return;

    // 놓은 지점을 영상 화면(object-contain으로 가운데 놓인 실제 영상 영역) 기준 %로 바꾼다.
    const box = boxElement.getBoundingClientRect();
    const left = box.left + (box.width - frame.width) / 2;
    const top = box.top + (box.height - frame.height) / 2;
    onCueDrop(cueId, {
      x: ((event.clientX - left) / frame.width) * 100,
      yCenter: (1 - (event.clientY - top) / frame.height) * 100,
    });
  };

  /** 모서리 핸들을 끌면 자막 크기가 가로 폭에 비례해 바뀐다. */
  const startSubtitleResize = (event: MouseEvent<HTMLElement>) => {
    const textElement = textElementRef.current;
    if (!draggable || !textElement || !onSubtitleResize) return;

    event.preventDefault();
    event.stopPropagation();
    const startWidth = Math.max(40, textElement.getBoundingClientRect().width);
    const startX = event.clientX;
    const startSize = subtitleStyle.size;
    const onMove = (moveEvent: globalThis.MouseEvent) => {
      const scale = Math.max(0.2, (startWidth + (moveEvent.clientX - startX) * 2) / startWidth);
      onSubtitleResize(Math.round(Math.min(12, Math.max(1, startSize * scale)) * 10) / 10);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div ref={setContainerElement} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
      <div
        ref={setBoxElement}
        className={`relative shrink-0 overflow-hidden rounded-[10px] bg-[#0a0500] ${dropActive ? 'ring-2 ring-[#5b4bff]' : ''}`}
        style={fit ? { height: fit.height, width: fit.width } : { aspectRatio: String(ratio), height: '100%' }}
        onDragLeave={() => setDropActive(false)}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropActive(true);
        }}
        onDrop={handleDrop}
      >
        {videoUrl ? (
          <video
            ref={videoRef}
            className="h-full w-full object-contain"
            src={videoUrl}
            playsInline
            preload="metadata"
            onEnded={onEnded}
            onLoadedMetadata={onLoadedMetadata}
            onTimeUpdate={onTimeUpdate}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[repeating-linear-gradient(160deg,#0f0700_0px,#0f0700_10px,#1e0e00_10px,#1e0e00_20px)]">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1.5">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            <span className="font-mono text-[9px] tracking-[1px] text-[rgba(255,255,255,0.15)]">영상 미리보기</span>
          </div>
        )}
        {subtitleLines && frame && (
          <div ref={frameElementRef} className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" style={{ height: frame.height, width: frame.width }}>
            {guides && (
              <div className="pointer-events-none absolute inset-0">
                {[...GRID_LINES, MARGIN_X, 100 - MARGIN_X].map((line) => (
                  <div
                    className="absolute top-0 bottom-0 w-px"
                    key={`vx${line}`}
                    style={{ background: guides.x.includes(line) ? '#5b4bff' : GRID_LINES.includes(line) ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.14)', left: `${line}%` }}
                  />
                ))}
                {[...GRID_LINES, MARGIN_Y, 100 - MARGIN_Y].map((line) => (
                  <div
                    className="absolute right-0 left-0 h-px"
                    key={`hy${line}`}
                    style={{ background: guides.y.includes(line) ? '#5b4bff' : GRID_LINES.includes(line) ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.14)', bottom: `${line}%` }}
                  />
                ))}
              </div>
            )}
            <div
              className={`absolute w-[90%] -translate-x-1/2 text-center ${draggable ? 'pointer-events-auto cursor-move' : ''}`}
              onMouseDown={startSubtitleDrag}
              style={{ bottom: `${y}%`, left: `${x}%` }}
              title={draggable ? '끌어서 위치 이동' : undefined}
            >
              <span
                ref={textElementRef}
                className={`relative inline-block px-[0.3em] leading-[1.25] whitespace-pre-line ${draggable ? 'outline outline-1 outline-dashed outline-white/70' : ''}`}
                style={{
                  background: subtitleStyle.box ? 'rgba(0,0,0,0.5)' : undefined,
                  color: subtitleStyle.color,
                  fontFamily: `${fontOption.css}, sans-serif`,
                  fontSize: fontPx,
                  fontWeight: fontOption.weight,
                  textShadow: subtitleStyle.box ? undefined : '0 0 0.12em #000, 0 0 0.12em #000, 0 0 0.12em #000, 0 0 0.12em #000',
                }}
              >
                {subtitleLines.top && <span className="block" style={{ color: '#CCCCCC' }}>{subtitleLines.top}</span>}
                {subtitleLines.main}
                {subtitleLines.bottom && <span className="block" style={{ fontSize: '0.85em' }}>{subtitleLines.bottom}</span>}
                {draggable && (
                  <span
                    aria-label="자막 크기 조절"
                    className="pointer-events-auto absolute -right-2 -bottom-2 h-3.5 w-3.5 cursor-nwse-resize rounded-full border-2 border-[#5b4bff] bg-white"
                    onMouseDown={startSubtitleResize}
                    role="presentation"
                    title="끌어서 크기 조절"
                  />
                )}
              </span>
            </div>
          </div>
        )}
        <div className="pointer-events-none absolute right-0 bottom-2.5 left-0 text-center">
          <span className="rounded bg-black/50 px-2 py-0.5 font-mono text-[9px] text-white/60">{getAspectLabel(aspect, sourceRatio)}</span>
        </div>
      </div>
    </div>
  );
}
