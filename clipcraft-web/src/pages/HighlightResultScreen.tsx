import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '@/App';
import FullLengthTimeline from '@/components/HighlightResult/FullLengthTimeline';
import HighlightRow from '@/components/HighlightResult/HighlightRow';
import Icon from '@/components/Icon';
import Logo from '@/components/Logo';
import MonoLabel from '@/components/MonoLabel';
import PillButton from '@/components/PillButton';
import { icons } from '@/components/icons';
import { buildEditorAnalysis, formatClock, totalDuration } from '@/lib/highlights';
import { captureVideoThumbnail } from '@/lib/videoUpload';
import type { HighlightAnalysisResult, HighlightCandidate, HighlightExtractionResult } from '@/types/app';

interface HighlightResultScreenProps {
  extraction: HighlightExtractionResult;
  jobId?: string;
  projectName?: string;
  videoPath?: string;
  videoUrl: string;
  videoName: string;
  onBack: () => void;
  onRetry: () => void;
  onNext: (analysis: HighlightAnalysisResult) => void;
}

export default function HighlightResultScreen({ extraction, jobId, projectName, videoPath, videoUrl, videoName, onBack, onRetry, onNext }: HighlightResultScreenProps) {
  const { accent } = useTheme();
  const { highlights, duration, amplitudes } = extraction;

  const [selected, setSelected] = useState<Set<number>>(() => new Set(highlights.map((item) => item.id)));
  const [activeId, setActiveId] = useState<number | null>(highlights[0]?.id ?? null);
  const [position, setPosition] = useState(highlights[0]?.start ?? 0);
  const [playing, setPlaying] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const videoRef = useRef<HTMLVideoElement>(null);

  const active = useMemo(() => highlights.find((item) => item.id === activeId) ?? null, [highlights, activeId]);
  const selectedHighlights = useMemo(() => highlights.filter((item) => selected.has(item.id)), [highlights, selected]);
  const selectedTotal = totalDuration(selectedHighlights);

  // 서버가 썸네일을 주지 않은 구간은 올린 영상에서 가운데 프레임을 직접 캡처한다.
  useEffect(() => {
    let cancelled = false;
    const pending = highlights.filter((item) => !item.thumbnail);
    (async () => {
      for (const item of pending) {
        try {
          const frame = await captureVideoThumbnail(videoUrl, duration, (item.start + item.end) / 2);
          if (cancelled) return;
          setThumbnails((current) => ({ ...current, [item.id]: frame }));
        } catch {
          // 썸네일이 없어도 목록은 쓸 수 있다.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [highlights, videoUrl, duration]);

  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (video) video.currentTime = seconds;
    setPosition(seconds);
  }, []);

  const pause = useCallback(() => {
    videoRef.current?.pause();
    setPlaying(false);
  }, []);

  const focusHighlight = (item: HighlightCandidate) => {
    setActiveId(item.id);
    pause();
    seekTo(item.start);
  };

  const seekOnTimeline = (seconds: number) => {
    pause();
    seekTo(seconds);
    const hit = highlights.find((item) => seconds >= item.start && seconds <= item.end);
    if (hit) setActiveId(hit.id);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video || !active) return;
    if (playing) {
      pause();
      return;
    }
    if (position < active.start || position >= active.end) seekTo(active.start);
    void video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };

  // 활성 구간 안에서만 재생하고, 끝에 닿으면 멈춘다.
  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    setPosition(video.currentTime);
    if (playing && active && video.currentTime >= active.end) {
      video.pause();
      setPlaying(false);
      setPosition(active.end);
    }
  };

  const toggleSelected = (id: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const startEditing = () => {
    if (selected.size === 0) return;
    onNext(buildEditorAnalysis(extraction, selected, { jobId, projectName, videoPath, videoUrl, videoName }));
  };

  const header = (
    <div className="mb-8 flex w-full max-w-[960px] items-center justify-between">
      <button
        type="button"
        onClick={onBack}
        data-testid="highlight-back"
        className="inline-flex cursor-pointer items-center gap-[7px] rounded-full border border-line-soft bg-glass py-1.5 pr-3 pl-2.5 text-[12.5px] font-[500] tracking-[-0.1px] text-ink-72 transition-colors hover:bg-glass-hover"
      >
        <Icon d={icons.arrowL} size={13} strokeWidth={2} />
        시나리오 입력으로
      </button>
      <Logo height={32} />
    </div>
  );

  // 하이라이트를 하나도 못 찾은 경우
  if (highlights.length === 0) {
    return (
      <div data-testid="highlight-result" className="flex min-h-screen flex-col items-center bg-canvas px-10 pt-[22px] pb-20 max-[760px]:px-5">
        {header}
        <div className="mt-10 flex max-w-[420px] flex-col items-center gap-4 text-center">
          <h1 className="text-[28px] font-[620] leading-[1.15] tracking-[-0.8px]">하이라이트를 찾지 못했어요</h1>
          <p className="text-sm leading-[1.6] tracking-[-0.1px] text-ink-56">반응이 큰 구간이 뚜렷하지 않은 영상이에요. 다시 추출하거나, 시나리오로 장면을 직접 찾아보세요.</p>
          <div className="flex gap-2.5">
            <PillButton variant="white" icon="zap" small onClick={onRetry}>
              다시 추출
            </PillButton>
            <PillButton variant="black" small onClick={onBack}>
              시나리오 입력으로
            </PillButton>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="highlight-result" className="flex min-h-screen flex-col items-center bg-canvas px-10 pt-[22px] pb-[120px] max-[760px]:px-5">
      {header}

      <div className="mb-7 max-w-[640px] text-center">
        <MonoLabel className="mb-3.5 block">Highlights · 전체 {formatClock(duration)} 분석</MonoLabel>
        <h1 className="mb-2.5 text-[38px] font-[620] leading-[1.1] tracking-[-1.1px] max-[760px]:text-[30px]" data-testid="highlight-title">
          하이라이트 {highlights.length}곳을 찾았어요
        </h1>
        <p className="text-sm leading-[1.6] tracking-[-0.1px] text-ink-56">
          영상 처음부터 끝까지 훑어서 반응이 컸던 구간을 골랐어요.
          <br />
          쓸 구간만 체크하고 편집을 시작하세요.
        </p>
      </div>

      <div className="grid w-full max-w-[960px] grid-cols-[1.2fr_1fr] items-stretch gap-4 max-[760px]:grid-cols-1">
        {/* 왼쪽: 프리뷰 + 전체 길이 타임라인 */}
        <section className="flex flex-col gap-4 rounded-[14px] border border-line-soft bg-white p-5">
          <div className="relative aspect-video w-full overflow-hidden rounded-[10px] bg-stage">
            <video ref={videoRef} src={videoUrl} playsInline preload="metadata" onLoadedMetadata={() => active && seekTo(active.start)} onTimeUpdate={handleTimeUpdate} onEnded={() => setPlaying(false)} className="h-full w-full object-contain" aria-label="영상 미리보기" />
            <button
              type="button"
              aria-label={playing ? '일시정지' : '재생'}
              data-testid="highlight-play"
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
            {active && (
              <span className="absolute top-2.5 right-3 inline-flex items-center gap-[5px] rounded-full px-[9px] py-[3px] text-[11px] font-[540] text-white" style={{ background: accent }}>
                <Icon d={icons.zap} size={10} stroke="#fff" strokeWidth={2} />
                {active.label}
              </span>
            )}
          </div>

          <FullLengthTimeline
            accent={accent}
            duration={duration}
            highlights={highlights}
            selected={selected}
            activeId={activeId}
            position={position}
            amplitudes={amplitudes}
            onSeek={seekOnTimeline}
            onFocusHighlight={focusHighlight}
          />
        </section>

        {/* 오른쪽: 하이라이트 구간 */}
        <section className="flex flex-col gap-3 rounded-[14px] border border-line-soft bg-white p-5">
          <MonoLabel>하이라이트 구간 · {highlights.length}</MonoLabel>
          <div className="flex flex-col gap-2" data-testid="highlight-list">
            {highlights.map((item) => (
              <HighlightRow
                key={item.id}
                accent={accent}
                highlight={item}
                thumbnail={item.thumbnail ?? thumbnails[item.id]}
                selected={selected.has(item.id)}
                active={activeId === item.id}
                onToggle={() => toggleSelected(item.id)}
                onFocus={() => focusHighlight(item)}
              />
            ))}
          </div>
        </section>
      </div>

      {/* 하단 고정 액션 바 */}
      <div className="fixed inset-x-0 bottom-0 z-10 flex justify-center border-t border-line-soft bg-white/95 px-10 py-3.5 backdrop-blur-[8px] max-[760px]:px-4 max-[760px]:py-2.5" data-testid="highlight-actionbar">
        <div className="flex w-full max-w-[960px] items-center gap-3 max-[760px]:flex-wrap max-[760px]:gap-2">
          <div className="flex-1 max-[760px]:flex max-[760px]:basis-full max-[760px]:items-baseline max-[760px]:gap-2">
            <div className="text-sm font-[540] tracking-[-0.2px]" data-testid="highlight-summary">
              {selected.size}개 선택 · 총 {formatClock(selectedTotal)}
            </div>
            {/* 좁은 화면에서도 "하나 이상 선택" 안내는 숨기지 않는다. */}
            <div role="status" className={selected.size === 0 ? 'text-[11.5px] text-danger-ink' : 'text-[11.5px] text-ink-56 max-[760px]:hidden'}>
              {selected.size === 0 ? '편집할 구간을 하나 이상 선택해 주세요.' : '선택한 구간은 시간 순서대로 이어 붙여요.'}
            </div>
          </div>
          <PillButton variant="white" icon="zap" small onClick={onRetry} testId="highlight-retry" className="max-[760px]:flex-1 max-[760px]:justify-center">
            다시 추출
          </PillButton>
          <PillButton
            variant="accent"
            icon="wand"
            disabled={selected.size === 0}
            onClick={startEditing}
            testId="highlight-start-editing"
            className="max-[760px]:flex-[2] max-[760px]:justify-center"
          >
            선택한 구간으로 편집 시작
          </PillButton>
        </div>
      </div>
    </div>
  );
}
