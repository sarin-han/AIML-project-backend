import { useEffect, useRef, useState } from 'react';
import { downloadExportedVideo, requestExportVideo } from '@/api/export';
import { requestSubtitleSuggestions } from '@/api/suggest';
import type { SuggestTone } from '@/api/suggest';
import { translateCuesToKorean } from '@/api/translate';
import { requestSubtitles } from '@/api/transcribe';
import { useTheme } from '@/App';
import Logo from '@/components/Logo';
import PillButton from '@/components/PillButton';
import AiAssistant from '@/components/EditorScreen/AiAssistant';
import HighlightList from '@/components/EditorScreen/HighlightList';
import SubtitlePanel from '@/components/EditorScreen/SubtitlePanel';
import PlayerControls, { getScrubPosition } from '@/components/EditorScreen/PlayerControls';
import VideoPreview from '@/components/EditorScreen/VideoPreview';
import WaveformTimeline from '@/components/EditorScreen/WaveformTimeline';
import { applyEditorNaturalLanguageCommand } from '@/lib/editorNaturalLanguageCommands';
import { buildSrt, downloadTextFile, findActiveCue, getCueLines, loadSubtitles, mapCuesToTimeline, loadSubtitleStyle, saveSubtitles, saveSubtitleStyle } from '@/lib/subtitles';
import type { SubtitleStyle } from '@/lib/subtitles';
import { loadDeletedSegmentIds, loadSegmentEditSettings, saveDeletedSegmentIds, saveSegmentEditSettings } from '@/lib/editorStorage';
import type { EditorHighlightSegment, ExportState, SegmentEditSetting, SubtitleCue } from '@/types/app';
import type { EditorScreenProps, NaturalLanguageCommandResult } from '@/types/pages/EditorScreen';

const fallbackWaveHeights = Array.from(
  { length: 88 },
  (_, index) => 4 + Math.abs(Math.sin(index * 0.38 + 0.9) * 18) + Math.abs(Math.cos(index * 0.7) * 8),
);

function amplitudesToWaveHeights(amplitudes: number[]): number[] {
  if (amplitudes.length === 0) return fallbackWaveHeights;

  const maxAmplitude = Math.max(...amplitudes, 1);
  return amplitudes.map((amplitude) => 4 + (Math.max(0, amplitude) / maxAmplitude) * 28);
}

function filterDeletedSegments(segments: EditorHighlightSegment[], deletedSegmentIds: number[]): EditorHighlightSegment[] {
  const deletedIds = new Set(deletedSegmentIds);
  return segments.filter((segment) => !deletedIds.has(segment.id));
}

function filterStoredEditSettings(settings: SegmentEditSetting[], segments: EditorHighlightSegment[], deletedSegmentIds: number[]): SegmentEditSetting[] {
  const segmentIds = new Set(segments.map((segment) => segment.id));
  const deletedIds = new Set(deletedSegmentIds);
  return settings.filter((setting) => segmentIds.has(setting.segmentId) && !deletedIds.has(setting.segmentId));
}

function moveSegment(segments: EditorHighlightSegment[], fromIndex: number, toIndex: number): EditorHighlightSegment[] {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= segments.length || toIndex >= segments.length) return segments;

  const next = [...segments];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

interface CapturedFrame {
  brightness: number;
  url: string;
}

function getFrameBrightness(context: CanvasRenderingContext2D, width: number, height: number): number {
  const sampleWidth = Math.min(64, width);
  const sampleHeight = Math.min(36, height);
  const imageData = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
  let total = 0;

  for (let index = 0; index < imageData.length; index += 4) {
    total += (imageData[index] + imageData[index + 1] + imageData[index + 2]) / 3;
  }

  return total / (imageData.length / 4);
}

function captureVideoFrame(videoUrl: string, time: number): Promise<CapturedFrame> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    let timeoutId: number | undefined;
    let fallbackFrameId: number | undefined;
    let settled = false;

    const cleanup = () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (fallbackFrameId !== undefined) window.clearTimeout(fallbackFrameId);
      video.removeAttribute('src');
      video.load();
    };
    const capture = () => {
      if (settled) return;

      canvas.width = video.videoWidth || 320;
      canvas.height = video.videoHeight || 180;
      const context = canvas.getContext('2d');

      if (!context) {
        settled = true;
        cleanup();
        reject(new Error('CANVAS_CONTEXT_UNAVAILABLE'));
        return;
      }

      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const brightness = getFrameBrightness(context, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/jpeg', 0.78);
      settled = true;
      cleanup();
      resolve({
        brightness,
        url,
      });
    };

    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : time;
      video.currentTime = Math.min(Math.max(0, time), Math.max(0, duration - 0.05));
    };
    video.onseeked = () => {
      if ('requestVideoFrameCallback' in video) {
        video.requestVideoFrameCallback(() => capture());
      }

      fallbackFrameId = window.setTimeout(capture, 160);
    };
    video.onerror = () => {
      settled = true;
      cleanup();
      reject(new Error('VIDEO_FRAME_CAPTURE_FAILED'));
    };
    timeoutId = window.setTimeout(() => {
      settled = true;
      cleanup();
      reject(new Error('VIDEO_FRAME_CAPTURE_TIMEOUT'));
    }, 8000);
    video.src = videoUrl;
    video.load();
  });
}

async function captureSegmentThumbnail(videoUrl: string, start: number, end: number): Promise<string> {
  const safeStart = Math.max(0, start);
  const safeEnd = Math.max(safeStart + 0.1, end);
  const segmentDuration = safeEnd - safeStart;
  const candidates = [
    safeStart + segmentDuration * 0.15,
    safeStart + segmentDuration * 0.5,
    safeStart + segmentDuration * 0.25,
    safeStart + segmentDuration * 0.75,
    safeStart + Math.min(1, segmentDuration * 0.1),
    safeEnd - Math.min(0.1, segmentDuration * 0.1),
  ];
  let bestFrame: CapturedFrame | null = null;

  for (const time of candidates) {
    const frame = await captureVideoFrame(videoUrl, time);

    if (!bestFrame || frame.brightness > bestFrame.brightness) {
      bestFrame = frame;
    }

    if (frame.brightness > 14) {
      return frame.url;
    }
  }

  return bestFrame?.url ?? '';
}

export default function EditorWorkspace({ analysis, onBack, projectName, videoPath, videoName, videoUrl }: EditorScreenProps) {
  const { accent } = useTheme();
  const [deletedSegmentIds, setDeletedSegmentIds] = useState<number[]>(loadDeletedSegmentIds);
  const [segments, setSegments] = useState<EditorHighlightSegment[]>(() => filterDeletedSegments(analysis?.segments ?? [], loadDeletedSegmentIds()));
  const duration = analysis?.duration && analysis.duration > 0 ? analysis.duration : 15 * 60;
  const waveHeights = amplitudesToWaveHeights(analysis?.amplitudes ?? []);
  const [playing, setPlaying] = useState(false);
  const [playbackDuration, setPlaybackDuration] = useState(duration);
  const [progress, setProgress] = useState(0.52);
  const [activeSegment, setActiveSegment] = useState<number | null>(null);
  const [exportState, setExportState] = useState<ExportState>('idle');
  const [dragging, setDragging] = useState(false);
  const [muted, setMuted] = useState(false);
  const [segmentEditSettings, setSegmentEditSettings] = useState<SegmentEditSetting[]>(() =>
    filterStoredEditSettings(loadSegmentEditSettings(), analysis?.segments ?? [], loadDeletedSegmentIds()),
  );
  const [segmentThumbnails, setSegmentThumbnails] = useState<Record<number, string>>({});
  const [subtitles, setSubtitles] = useState<SubtitleCue[]>(() => loadSubtitles(videoPath));
  const [subtitleGenerating, setSubtitleGenerating] = useState(false);
  const [subtitleProgress, setSubtitleProgress] = useState(0);
  const [subtitleLanguage, setSubtitleLanguage] = useState('');
  const [subtitleTranslate, setSubtitleTranslate] = useState(true);
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>(loadSubtitleStyle);
  const [exportWithSubtitles, setExportWithSubtitles] = useState(true);
  const [selectedCueId, setSelectedCueId] = useState<number | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [subtitleNotice, setSubtitleNotice] = useState<string | null>(null);
  const [subtitleError, setSubtitleError] = useState<string | null>(null);
  const [exportToast, setExportToast] = useState<string | null>(null);
  const scrubberRef = useRef<HTMLDivElement>(null);
  const exportToastTimerRef = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    return () => {
      if (exportToastTimerRef.current !== null) window.clearTimeout(exportToastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const sourceSegments = analysis?.segments ?? [];

    setSegments(filterDeletedSegments(sourceSegments, deletedSegmentIds));
    setSegmentEditSettings((current) => filterStoredEditSettings(current, sourceSegments, deletedSegmentIds));
  }, [analysis?.segments, deletedSegmentIds]);

  useEffect(() => {
    saveSegmentEditSettings(segmentEditSettings);
  }, [segmentEditSettings]);

  useEffect(() => {
    saveSubtitleStyle(subtitleStyle);
  }, [subtitleStyle]);

  useEffect(() => {
    saveSubtitles(videoPath, subtitles);
  }, [subtitles, videoPath]);

  useEffect(() => {
    saveDeletedSegmentIds(deletedSegmentIds);
  }, [deletedSegmentIds]);

  useEffect(() => {
    if (!videoUrl || segments.length === 0) {
      setSegmentThumbnails({});
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void Promise.all(
        segments.map(async (segment) => {
          try {
            return [segment.id, await captureSegmentThumbnail(videoUrl, segment.start, segment.end)] as const;
          } catch {
            return [segment.id, ''] as const;
          }
        }),
      ).then((entries) => {
        if (cancelled) return;

        setSegmentThumbnails(
          Object.fromEntries(entries.filter(([, thumbnail]) => thumbnail)),
        );
      });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [segments, videoUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (playing) {
      void video.play().catch(() => setPlaying(false));
      return;
    }

    video.pause();
  }, [playing, videoUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;

    const targetTime = progress * video.duration;
    if (Math.abs(video.currentTime - targetTime) > 0.35 || dragging) {
      video.currentTime = targetTime;
    }
  }, [dragging, progress]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      const isEditableTarget =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);

      if (event.code !== 'Space' || isEditableTarget) return;

      event.preventDefault();
      setPlaying((current) => !current);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const onMove = (event: globalThis.MouseEvent) => {
      if (dragging && scrubberRef.current) {
        setProgress(getScrubPosition(event, scrubberRef.current));
      }
    };
    const onUp = () => setDragging(false);

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  const seekToSegment = (segment: EditorHighlightSegment, index: number) => {
    const target = segment.start;
    setActiveSegment(index);
    setProgress(Math.min(1, Math.max(0, target / playbackDuration)));
    setPlaying(false);
  };

  const onSegmentClick = (index: number) => {
    const segment = segments[index];
    if (!segment) return;

    seekToSegment(segment, index);
  };

  const onSegmentChange = (segmentId: number, edge: 'start' | 'end', time: number) => {
    setSegments((current) =>
      current.map((segment) => {
        if (segment.id !== segmentId) return segment;

        const minDuration = 0.2;
        const nextTime = Math.min(playbackDuration, Math.max(0, time));

        if (edge === 'start') {
          return {
            ...segment,
            start: Math.min(nextTime, Math.max(0, segment.end - minDuration)),
          };
        }

        return {
          ...segment,
          end: Math.max(nextTime, Math.min(playbackDuration, segment.start + minDuration)),
        };
      }),
    );
  };

  const onSegmentsReorder = (fromIndex: number, toIndex: number) => {
    const activeSegmentId = activeSegment !== null ? segments[activeSegment]?.id : null;

    setSegments((current) => {
      const next = moveSegment(current, fromIndex, toIndex);

      if (activeSegmentId !== null) {
        const nextActiveIndex = next.findIndex((segment) => segment.id === activeSegmentId);
        setActiveSegment(nextActiveIndex === -1 ? null : nextActiveIndex);
      }

      return next;
    });
  };

  const syncVideoProgress = () => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;

    setProgress(Math.min(1, Math.max(0, video.currentTime / video.duration)));
  };

  const syncVideoMetadata = () => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;

    video.muted = muted;
    setPlaybackDuration(video.duration);
    setProgress(Math.min(1, Math.max(0, video.currentTime / video.duration)));
  };

  const seekForwardTenSeconds = () => {
    const video = videoRef.current;

    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = Math.min(video.duration, video.currentTime + 10);
      setProgress(Math.min(1, Math.max(0, video.currentTime / video.duration)));
      return;
    }

    setProgress((current) => Math.min(1, current + 10 / playbackDuration));
  };

  const currentTime = progress * playbackDuration;
  const activeCue = findActiveCue(subtitles, currentTime, selectedCueId);

  const onGenerateSubtitles = async () => {
    if (!videoPath || subtitleGenerating) return;

    setSubtitleGenerating(true);
    setSubtitleProgress(0);
    setSubtitleError(null);
    setSubtitleNotice(null);
    try {
      const recognized = await requestSubtitles(videoPath, setSubtitleProgress, subtitleLanguage || null);

      if (recognized.length === 0) {
        setSubtitles([]);
        setSubtitleNotice('말소리를 찾지 못했어요. "시나리오로 자막 추천"을 누르거나 자막을 직접 추가해 보세요.');
        return;
      }

      if (!subtitleTranslate) {
        setSubtitles(recognized);
      } else {
        try {
          setSubtitles(await translateCuesToKorean(recognized));
        } catch (translateError) {
          console.error(translateError);
          setSubtitles(recognized);
          setSubtitleError(`번역하지 못해 원문 자막을 표시합니다. (${translateError instanceof Error ? translateError.message : '알 수 없는 오류'})`);
        }
      }
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : '자막 생성에 실패했습니다.';

      if (message.includes('오디오 추출')) {
        setSubtitleNotice('이 영상에는 소리가 없어요. "시나리오로 자막 추천"을 누르거나 자막을 직접 추가해 보세요.');
      } else {
        setSubtitleError(message);
      }
    } finally {
      setSubtitleGenerating(false);
    }
  };

  const onCueChange = (cueId: number, text: string) => {
    setSubtitles((current) => current.map((cue) => (cue.id === cueId ? { ...cue, text } : cue)));
  };

  const onCueDelete = (cueId: number) => {
    setSubtitles((current) => current.filter((cue) => cue.id !== cueId));
    setSelectedCueId((current) => (current === cueId ? null : current));
  };

  const onSuggestSubtitles = async (tone: SuggestTone) => {
    if (segments.length === 0 || suggesting) return;

    setSuggesting(true);
    setSubtitleError(null);
    setSubtitleNotice(null);
    try {
      const items = segments.map((segment) => ({
        id: segment.id,
        scenario: segment.scenario,
        title: segment.title,
        duration: segment.end - segment.start,
        frames: [],
      }));
      const captions = await requestSubtitleSuggestions(items, tone, 'scenario');
      const captionById = new Map(captions.map((caption) => [caption.id, caption.text]));

      setSubtitles((current) => {
        let nextId = current.reduce((max, cue) => Math.max(max, cue.id), 0) + 1;
        const added = segments.flatMap((segment) => {
          const text = captionById.get(segment.id);
          if (!text) return [];

          const end = Math.min(segment.end, segment.start + 3.5);
          return [{ id: nextId++, start: segment.start, end: Math.max(end, segment.start + 1), text }];
        });

        return [...current, ...added].sort((a, b) => a.start - b.start);
      });
      setSubtitleNotice(`시나리오대로 ${captions.length}개 구간에 자막을 만들었어요. 문장은 직접 고치고, 시간은 파형 아래 자막 줄에서 조절하세요.`);
    } catch (error) {
      console.error(error);
      setSubtitleError(error instanceof Error ? error.message : '자막 만들기에 실패했습니다.');
    } finally {
      setSuggesting(false);
    }
  };

  const onCueTimeChange = (cueId: number, edge: 'start' | 'end', time: number) => {
    if (!Number.isFinite(time)) return;

    const minLength = 0.2;
    const clamped = Math.min(playbackDuration, Math.max(0, time));

    setSubtitles((current) =>
      current.map((cue) => {
        if (cue.id !== cueId) return cue;

        return edge === 'start'
          ? { ...cue, start: Math.min(clamped, Math.max(0, cue.end - minLength)) }
          : { ...cue, end: Math.max(clamped, Math.min(playbackDuration, cue.start + minLength)) };
      }),
    );
  };

  const onCueMove = (cueId: number, start: number) => {
    setSubtitles((current) =>
      current.map((cue) => {
        if (cue.id !== cueId) return cue;

        const length = cue.end - cue.start;
        const nextStart = Math.min(Math.max(0, start), Math.max(0, playbackDuration - length));
        return { ...cue, start: nextStart, end: nextStart + length };
      }),
    );
  };

  const onCueSelect = (cueId: number) => {
    setSelectedCueId(cueId);

    const cue = subtitles.find((item) => item.id === cueId);
    if (cue) {
      setProgress(Math.min(1, Math.max(0, cue.start / playbackDuration)));
      setPlaying(false);
    }
  };

  const onCuePositionChange = (cueId: number, position: { x: number; y: number }) => {
    setSubtitles((current) => current.map((cue) => (cue.id === cueId ? { ...cue, x: position.x, y: position.y } : cue)));
  };

  const onCuePositionReset = (cueId: number) => {
    setSubtitles((current) =>
      current.map((cue) => {
        if (cue.id !== cueId) return cue;

        const { x: _x, y: _y, ...rest } = cue;
        return rest;
      }),
    );
  };

  const onDownloadSrt = () => {
    downloadTextFile(buildSrt(subtitles, segments, segmentEditSettings, subtitleStyle.bilingual), 'clipcraft_subtitles.srt');
  };

  const showExportToast = (message: string) => {
    if (exportToastTimerRef.current !== null) window.clearTimeout(exportToastTimerRef.current);

    setExportToast(message);
    exportToastTimerRef.current = window.setTimeout(() => {
      setExportToast(null);
      exportToastTimerRef.current = null;
    }, 3200);
  };

  const onExport = async () => {
    if (exportState !== 'idle') return;
    if (!videoPath || segments.length === 0) return;

    setExportState('loading');
    try {
      const subtitleCues = exportWithSubtitles ? mapCuesToTimeline(subtitles, segments, segmentEditSettings, subtitleStyle.bilingual) : [];
      const blob = await requestExportVideo(videoPath, segments, segmentEditSettings, subtitleCues.length > 0 ? { cues: subtitleCues, style: subtitleStyle } : undefined);
      downloadExportedVideo(blob);
      setExportState('done');
      showExportToast('내보내기가 완료됐어요');
      window.setTimeout(() => setExportState('idle'), 1800);
    } catch (error) {
      console.error(error);
      setExportState('idle');
      showExportToast('내보내기에 실패했습니다. 백엔드 서버와 영상 경로를 확인해 주세요.');
    }
  };

  const applyNaturalLanguageCommand = (command: string): NaturalLanguageCommandResult => {
    return applyEditorNaturalLanguageCommand({
      activeSegment,
      command,
      playbackDuration,
      progress,
      seekToSegment,
      segments,
      setActiveSegment,
      setDeletedSegmentIds,
      setPlaying,
      setProgress,
      setSegmentEditSettings,
      setSegments,
    });
  };

  return (
    <div className="editor-shell grid h-screen w-full grid-cols-[minmax(360px,1fr)_minmax(360px,1fr)_320px] grid-rows-[52px_minmax(0,1fr)] overflow-hidden bg-white max-[1180px]:h-auto max-[1180px]:min-h-screen max-[1180px]:grid-cols-1 max-[1180px]:grid-rows-[52px_minmax(520px,70vh)_auto_minmax(360px,auto)] max-[1180px]:overflow-visible">
      <header className="col-[1/-1] flex items-center gap-3.5 border-b border-[rgba(0,0,0,0.08)] px-5">
        <button className="cursor-pointer border-0 bg-transparent p-0" onClick={onBack} type="button" aria-label="업로드 화면으로 돌아가기">
          <Logo height={26} />
        </button>
        <div className="h-4 w-px bg-[rgba(0,0,0,0.1)]" />
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] text-[rgba(0,0,0,0.4)]">프로젝트:</span>
          <span className="text-[13px] font-[480] tracking-[-0.1px]">{projectName ?? videoName ?? '하이라이트 편집'}</span>
        </div>
        <div className="flex-1" />
        <PillButton variant="white" icon="history" small>
          작업 기록
        </PillButton>
        {subtitles.length > 0 && (
          <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-[rgba(0,0,0,0.65)]">
            <input checked={exportWithSubtitles} onChange={(event) => setExportWithSubtitles(event.target.checked)} type="checkbox" />
            자막 포함
          </label>
        )}
        <PillButton
          variant="accent"
          disabled={!videoPath || segments.length === 0}
          icon={exportState === 'done' ? 'check' : 'download'}
          loading={exportState === 'loading'}
          small
          onClick={onExport}
          style={{ transition: 'all 0.3s' }}
        >
          {exportState === 'loading' ? '내보내는 중...' : exportState === 'done' ? '완료!' : 'MP4로 내보내기'}
        </PillButton>
      </header>

      <main className="flex min-h-0 flex-col overflow-hidden px-5 py-4">
        <VideoPreview
          videoRef={videoRef}
          videoUrl={videoUrl}
          onEnded={() => setPlaying(false)}
          onLoadedMetadata={syncVideoMetadata}
          onTimeUpdate={syncVideoProgress}
          draggable={Boolean(activeCue && activeCue.id === selectedCueId)}
          onSubtitleMove={(position) => activeCue && onCuePositionChange(activeCue.id, position)}
          subtitleLines={activeCue ? getCueLines(activeCue, subtitleStyle.bilingual) : undefined}
          subtitlePosition={activeCue ? { x: activeCue.x, y: activeCue.y } : undefined}
          subtitleStyle={subtitleStyle}
        />
        <PlayerControls
          accent={accent}
          dragging={dragging}
          duration={playbackDuration}
          muted={muted}
          onSeekForward={seekForwardTenSeconds}
          onToggleMute={() => setMuted((current) => !current)}
          playing={playing}
          progress={progress}
          scrubberRef={scrubberRef}
          setDragging={setDragging}
          setPlaying={setPlaying}
          setProgress={setProgress}
        />
      </main>

      <section className="flex min-h-0 flex-col overflow-hidden">
        <WaveformTimeline
          accent={accent}
          duration={duration}
          activeCueId={activeCue?.id}
          onCueMove={onCueMove}
          onCueSelect={setSelectedCueId}
          selectedCueId={selectedCueId}
          onCueTimeChange={onCueTimeChange}
          onSegmentChange={onSegmentChange}
          progress={progress}
          segments={segments}
          setPlaying={setPlaying}
          setProgress={setProgress}
          subtitleCues={subtitles}
          waveHeights={waveHeights}
        />
        <HighlightList
          activeSegment={activeSegment}
          onSegmentClick={onSegmentClick}
          onSegmentsReorder={onSegmentsReorder}
          segmentEditSettings={segmentEditSettings}
          segments={segments}
          thumbnails={segmentThumbnails}
        />
        <SubtitlePanel
          cues={subtitles}
          disabled={!videoPath}
          error={subtitleError}
          generating={subtitleGenerating}
          language={subtitleLanguage}
          notice={subtitleNotice}
          onCueChange={onCueChange}
          onCueDelete={onCueDelete}
          onCuePositionReset={onCuePositionReset}
          onCueSelect={onCueSelect}
          onDownload={onDownloadSrt}
          onGenerate={onGenerateSubtitles}
          onLanguageChange={setSubtitleLanguage}
          onStyleChange={setSubtitleStyle}
          onSuggest={onSuggestSubtitles}
          onTranslateChange={setSubtitleTranslate}
          progress={subtitleProgress}
          selectedCueId={selectedCueId}
          style={subtitleStyle}
          suggestDisabled={segments.length === 0}
          suggesting={suggesting}
          translate={subtitleTranslate}
        />
      </section>

      <AiAssistant accent={accent} onApplyCommand={applyNaturalLanguageCommand} />

      {exportToast && (
        <div className="fixed bottom-7 left-1/2 z-[2000] flex -translate-x-1/2 animate-[fadeIn_0.2s_ease] items-center gap-2.5 rounded-full bg-[#0a0a0a] px-[18px] py-3 text-[13.5px] font-[480] tracking-[-0.1px] text-white shadow-[0_10px_30px_rgba(0,0,0,0.25)]">
          <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-white text-[11px] font-bold text-black">✓</span>
          {exportToast}
        </div>
      )}
    </div>
  );
}
