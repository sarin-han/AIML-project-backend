import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { RefObject } from 'react';
import { SUBTITLE_FONT_OPTIONS } from '@/lib/subtitles';
import type { CueLines, SubtitleStyle } from '@/lib/subtitles';

interface VideoPreviewProps {
  /** true면 자막을 끌어서 옮길 수 있다(선택된 자막이 지금 보일 때) */
  draggable?: boolean;
  onSubtitleMove?: (position: { x: number; y: number }) => void;
  subtitlePosition?: { x?: number; y?: number };
  onEnded?: () => void;
  onLoadedMetadata?: () => void;
  onTimeUpdate?: () => void;
  subtitleLines?: CueLines;
  subtitleStyle: SubtitleStyle;
  videoRef?: RefObject<HTMLVideoElement | null>;
  videoUrl?: string;
}

interface FrameSize {
  height: number;
  width: number;
}

export default function VideoPreview({ draggable = false, onEnded, onLoadedMetadata, onSubtitleMove, onTimeUpdate, subtitleLines, subtitlePosition, subtitleStyle, videoRef, videoUrl }: VideoPreviewProps) {
  const [boxElement, setBoxElement] = useState<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState<FrameSize | null>(null);
  const frameElementRef = useRef<HTMLDivElement>(null);

  // 영상은 object-contain으로 그려지므로, 자막 기준이 되는 "실제 영상 화면" 크기를 계산한다(내보낸 영상과 같은 비율).
  useEffect(() => {
    const video = videoRef?.current;
    if (!boxElement || !video) return;

    const measure = () => {
      if (!video.videoWidth || !video.videoHeight) return;

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

  const fontOption = SUBTITLE_FONT_OPTIONS.find((option) => option.id === subtitleStyle.font) ?? SUBTITLE_FONT_OPTIONS[0];
  const fontPx = frame ? (subtitleStyle.size / 100) * frame.height : 0;

  const x = subtitlePosition?.x ?? 50;
  const y = subtitlePosition?.y ?? subtitleStyle.position;

  const startSubtitleDrag = (event: MouseEvent<HTMLDivElement>) => {
    const frameElement = frameElementRef.current;
    if (!draggable || !frameElement || !onSubtitleMove) return;

    event.preventDefault();
    const rect = frameElement.getBoundingClientRect();
    const origin = { clientX: event.clientX, clientY: event.clientY, x, y };
    const onMove = (moveEvent: globalThis.MouseEvent) => {
      const nextX = origin.x + ((moveEvent.clientX - origin.clientX) / rect.width) * 100;
      const nextY = origin.y - ((moveEvent.clientY - origin.clientY) / rect.height) * 100;
      onSubtitleMove({ x: Math.min(95, Math.max(5, nextX)), y: Math.min(95, Math.max(0, nextY)) });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <div ref={setBoxElement} className="relative h-full max-h-full aspect-[9/16] overflow-hidden rounded-[10px] bg-[#0a0500]">
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
            <div
              className={`absolute w-[90%] -translate-x-1/2 text-center ${draggable ? 'pointer-events-auto cursor-move' : ''}`}
              onMouseDown={startSubtitleDrag}
              style={{ bottom: `${y}%`, left: `${x}%` }}
              title={draggable ? '끌어서 위치 이동' : undefined}
            >
              <span
                className={`inline-block px-[0.3em] leading-[1.25] whitespace-pre-line ${draggable ? 'outline outline-1 outline-dashed outline-white/70' : ''}`}
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
              </span>
            </div>
          </div>
        )}
        <div className="pointer-events-none absolute right-0 bottom-2.5 left-0 text-center">
          <span className="rounded bg-black/50 px-2 py-0.5 font-mono text-[9px] text-white/60">9:16 · 세로형 / 숏폼</span>
        </div>
      </div>
    </div>
  );
}
