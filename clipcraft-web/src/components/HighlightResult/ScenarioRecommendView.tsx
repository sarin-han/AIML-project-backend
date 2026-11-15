import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '@/App';
import type { RecommendedScenario, RecommendedScenarioScene } from '@/api/projectJobs';
import FullLengthTimeline from '@/components/HighlightResult/FullLengthTimeline';
import ScenarioSceneRow from '@/components/HighlightResult/ScenarioSceneRow';
import Icon from '@/components/Icon';
import Logo from '@/components/Logo';
import MonoLabel from '@/components/MonoLabel';
import PillButton from '@/components/PillButton';
import { icons } from '@/components/icons';
import { formatClock } from '@/lib/highlights';
import { useProjectFrames } from '@/lib/useProjectFrames';
import type { HighlightCandidate } from '@/types/app';

interface ScenarioRecommendViewProps {
  plan: RecommendedScenario;
  /** 영상 전체 길이(초)와 오디오 파형 */
  duration: number;
  amplitudes: number[];
  videoUrl: string;
  /** 서버에 저장된 프로젝트의 영상이면, 장면 미리보기를 서버가 뽑아 준다. */
  projectId?: string;
  backLabel: string;
  confirmLabel: string;
  saving?: boolean;
  onBack: () => void;
  onRetry: () => void;
  onConfirm: (scenes: RecommendedScenarioScene[]) => void;
}

/** 시나리오 추천 결과: 왼쪽은 영상과 오디오 파형, 오른쪽은 추천 구성(제목·요약·장면). 쓸 장면만 골라 넘긴다. */
export default function ScenarioRecommendView({ plan, duration, amplitudes, videoUrl, projectId, backLabel, confirmLabel, saving = false, onBack, onRetry, onConfirm }: ScenarioRecommendViewProps) {
  const { accent } = useTheme();
  const { frameUrl } = useProjectFrames(projectId);
  const scenes = plan.scenes;
  const [activeOrder, setActiveOrder] = useState<number | null>(scenes[0]?.order ?? null);
  const [position, setPosition] = useState(scenes[0]?.start ?? 0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set(scenes.map((scene) => scene.order)));
  const [fallbackThumbnails, setFallbackThumbnails] = useState<Record<number, string>>({});
  const videoRef = useRef<HTMLVideoElement>(null);

  const markers: HighlightCandidate[] = useMemo(() => scenes.map((scene) => ({ id: scene.order, start: scene.start, end: scene.end, label: scene.description })), [scenes]);
  const selectedScenes = useMemo(() => scenes.filter((scene) => selected.has(scene.order)), [scenes, selected]);
  const activeScene = scenes.find((scene) => scene.order === activeOrder) ?? null;
  const totalSeconds = selectedScenes.reduce((sum, scene) => sum + Math.max(0, scene.end - scene.start), 0);

  // 썸네일: 서버에 저장된 영상이면 주소만 만들면 되고, 아니면 올린 영상에서 가운데 프레임을 직접 캡처한다.
  const thumbnails = useMemo<Record<number, string>>(
    () => (frameUrl ? Object.fromEntries(scenes.map((scene) => [scene.order, frameUrl((scene.start + scene.end) / 2)])) : fallbackThumbnails),
    [frameUrl, scenes, fallbackThumbnails],
  );

  useEffect(() => {
    if (frameUrl || projectId) return;
    let cancelled = false;

    (async () => {
      const { captureProjectThumbnail } = await import('@/lib/videoUpload');
      for (const scene of scenes) {
        try {
          const frame = await captureProjectThumbnail(videoUrl, duration, (scene.start + scene.end) / 2);
          if (cancelled) return;
          setFallbackThumbnails((current) => ({ ...current, [scene.order]: frame }));
        } catch {
          // 썸네일이 없어도 목록은 쓸 수 있다.
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [frameUrl, projectId, scenes, videoUrl, duration]);

  const toggleSelected = (order: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(order)) next.delete(order);
      else next.add(order);
      return next;
    });

  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (video) video.currentTime = seconds;
    setPosition(seconds);
  }, []);

  const pause = useCallback(() => {
    videoRef.current?.pause();
    setPlaying(false);
  }, []);

  const focusScene = (order: number) => {
    const scene = scenes.find((item) => item.order === order);
    if (!scene) return;
    setActiveOrder(order);
    pause();
    seekTo(scene.start);
  };

  const seekOnTimeline = (seconds: number) => {
    pause();
    seekTo(seconds);
    const hit = scenes.find((scene) => seconds >= scene.start && seconds <= scene.end);
    if (hit) setActiveOrder(hit.order);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video || !activeScene) return;
    if (playing) {
      pause();
      return;
    }
    if (position < activeScene.start || position >= activeScene.end) seekTo(activeScene.start);
    void video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    setPosition(video.currentTime);
    if (playing && activeScene && video.currentTime >= activeScene.end) {
      video.pause();
      setPlaying(false);
      setPosition(activeScene.end);
    }
  };

  return (
    <div data-testid="scenario-recommend" className="flex min-h-screen flex-col items-center bg-canvas px-10 pt-[22px] pb-[120px] max-[760px]:px-5">
      <div className="mb-8 flex w-full max-w-[1080px] items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          data-testid="recommend-back"
          className="inline-flex cursor-pointer items-center gap-[7px] rounded-full border border-line-soft bg-glass py-1.5 pr-3 pl-2.5 text-[12.5px] font-[500] tracking-[-0.1px] text-ink-72 transition-colors hover:bg-glass-hover"
        >
          <Icon d={icons.arrowL} size={13} strokeWidth={2} />
          {backLabel}
        </button>
        <Logo height={32} />
      </div>

      <div className="grid w-full max-w-[1080px] grid-cols-[1fr_1.15fr] items-stretch gap-4 max-[900px]:grid-cols-1">
        {/* 왼쪽: 프리뷰 + 전체 길이 타임라인 */}
        <section className="flex flex-col gap-4 rounded-[14px] border border-line-soft bg-white p-5">
          <div className="relative aspect-video w-full overflow-hidden rounded-[10px] bg-stage">
            <video ref={videoRef} src={videoUrl} playsInline preload="metadata" onLoadedMetadata={() => activeScene && seekTo(activeScene.start)} onTimeUpdate={handleTimeUpdate} onEnded={() => setPlaying(false)} className="h-full w-full object-contain" aria-label="영상 미리보기" />
            <button
              type="button"
              aria-label={playing ? '일시정지' : '재생'}
              data-testid="recommend-play"
              onClick={togglePlay}
              className="absolute top-1/2 left-1/2 flex h-[52px] w-[52px] -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border-0 bg-white/90 shadow-[0_6px_20px_rgba(0,0,0,0.3)] focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-dashed focus-visible:outline-white"
              style={{ opacity: playing ? 0 : 1, transition: 'opacity 0.18s' }}
              onFocus={(event) => (event.currentTarget.style.opacity = '1')}
              onBlur={(event) => (event.currentTarget.style.opacity = playing ? '0' : '1')}
            >
              <Icon d={playing ? icons.pause : icons.play} size={18} stroke="#000" fill="#000" />
            </button>
            <span className="absolute bottom-2.5 left-3 rounded-[4px] bg-black/55 px-2 py-[3px] font-mono text-[11px] text-white">
              {formatClock(position)} / {formatClock(duration)}
            </span>
          </div>

          <FullLengthTimeline
            accent={accent}
            duration={duration}
            highlights={markers}
            selected={selected}
            activeId={activeOrder}
            position={position}
            amplitudes={amplitudes}
            onSeek={seekOnTimeline}
            onFocusHighlight={(marker) => focusScene(marker.id)}
          />
        </section>

        {/* 오른쪽: 추천 시나리오 구성. 박스 높이는 왼쪽에 맞추고, 장면이 넘치면 안에서 스크롤한다. */}
        <section className="relative rounded-[18px] border border-line-soft bg-white max-[900px]:min-h-0 min-[901px]:min-h-[420px]">
          <div className="flex flex-col gap-4 p-6 min-[901px]:absolute min-[901px]:inset-0">
            <div className="shrink-0">
              <MonoLabel>추천 시나리오 · {scenes.length}장면</MonoLabel>
              <h1 className="mt-3 text-[26px] font-[650] leading-[1.2] tracking-[-0.6px]" data-testid="recommend-title">{plan.title || '추천 시나리오'}</h1>
              {plan.summary && <p className="mt-2 text-[14px] leading-[1.55] tracking-[-0.1px] text-ink-56">{plan.summary}</p>}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-1 max-[900px]:max-h-[520px]" data-testid="recommend-list">
              {scenes.map((scene) => (
                <ScenarioSceneRow
                  key={scene.order}
                  accent={accent}
                  scene={scene}
                  thumbnail={thumbnails[scene.order]}
                  active={activeOrder === scene.order}
                  selected={selected.has(scene.order)}
                  onToggle={() => toggleSelected(scene.order)}
                  onFocus={() => focusScene(scene.order)}
                />
              ))}
            </div>
          </div>
        </section>
      </div>

      {/* 하단 고정 액션 바 */}
      <div className="fixed inset-x-0 bottom-0 z-10 flex justify-center border-t border-line-soft bg-white/95 px-10 py-3.5 backdrop-blur-[8px] max-[760px]:px-4 max-[760px]:py-2.5" data-testid="recommend-actionbar">
        <div className="flex w-full max-w-[1080px] items-center gap-3 max-[760px]:flex-wrap max-[760px]:gap-2">
          <div className="flex-1 max-[760px]:basis-full">
            <div className="text-sm font-[540] tracking-[-0.2px]">
              {selected.size}장면 선택 · 총 {formatClock(totalSeconds)}
            </div>
            <div className="text-[11.5px] text-ink-56">선택한 장면을 시간 순서대로 이어 붙여요.</div>
          </div>
          <PillButton variant="white" icon="wand" small onClick={onRetry} testId="recommend-retry" className="max-[760px]:flex-1 max-[760px]:justify-center">
            다시 추천
          </PillButton>
          <PillButton variant="accent" icon="wand" disabled={saving || selected.size === 0} onClick={() => onConfirm(selectedScenes)} testId="recommend-add" className="max-[760px]:flex-[2] max-[760px]:justify-center">
            {confirmLabel}
          </PillButton>
        </div>
      </div>
    </div>
  );
}
