import { useEffect, useRef, useState } from 'react';
import { downloadExportedVideo, requestExportVideo } from '@/api/export';
import { ApiError } from '@/api/client';
import { requestChatEdit } from '@/api/chatEdit';
import { requestSubtitleSuggestions } from '@/api/suggest';
import type { SuggestTone } from '@/api/suggest';
import { requestTranslations, translateCuesToKorean } from '@/api/translate';
import { requestSubtitles } from '@/api/transcribe';
import { useTheme } from '@/App';
import Icon from '@/components/Icon';
import { icons } from '@/components/icons';
import Logo from '@/components/Logo';
import PillButton from '@/components/PillButton';
import AiAssistant from '@/components/EditorScreen/AiAssistant';
import HighlightList from '@/components/EditorScreen/HighlightList';
import SubtitlePanel from '@/components/EditorScreen/SubtitlePanel';
import PlayerControls, { getScrubPosition } from '@/components/EditorScreen/PlayerControls';
import VideoPreview from '@/components/EditorScreen/VideoPreview';
import WaveformTimeline from '@/components/EditorScreen/WaveformTimeline';
import { ASPECT_OPTIONS, getAspectRatio, loadAspectSetting, saveAspectSetting, toExportAspect } from '@/lib/aspect';
import type { AspectSetting } from '@/lib/aspect';
import { applyChatEditCommands } from '@/lib/chatEditCommands';
import { applyEditorNaturalLanguageCommand } from '@/lib/editorNaturalLanguageCommands';
import { buildSrt, downloadTextFile, EXTRA_LANGUAGES, findActiveCue, cueUsedBySegments, getCueLines, loadSubtitleSets, mapCuesToTimeline, resolveCueStyle, loadSubtitleStyle, saveSubtitleSets, saveSubtitleStyle } from '@/lib/subtitles';
import type { SubtitleSetKey, SubtitleSets, SubtitleStyle } from '@/lib/subtitles';
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

/** 되돌리기 대상: 하이라이트 구간 편집, 배속·음소거, 삭제, 자막, 자막 기본 스타일 */
interface EditSnapshot {
  deletedSegmentIds: number[];
  segmentEditSettings: SegmentEditSetting[];
  segments: EditorHighlightSegment[];
  subtitleSets: SubtitleSets;
  subtitleStyle: SubtitleStyle;
}

const HISTORY_LIMIT = 100;
/** 이 시간(ms) 안에 이어진 변경(끌기, 연속 입력)은 한 번의 편집으로 묶는다. */
const HISTORY_MERGE_MS = 700;
/** 화면을 처음 열 때 저장값을 맞추는 자동 동기화는 편집으로 치지 않는다. */
const HISTORY_IGNORE_AFTER_MOUNT_MS = 800;

function snapshotsDiffer(a: EditSnapshot, b: EditSnapshot): boolean {
  return (Object.keys(a) as Array<keyof EditSnapshot>).some((key) => a[key] !== b[key]);
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
  const [subtitleSets, setSubtitleSets] = useState<SubtitleSets>(() => loadSubtitleSets(videoPath));
  // 지금 보이는(편집·내보내기 대상) 자막은 active인 쪽이다.
  const subtitles = subtitleSets[subtitleSets.active];
  const setSubtitles = (update: SubtitleCue[] | ((current: SubtitleCue[]) => SubtitleCue[])) =>
    setSubtitleSets((current) => ({ ...current, [current.active]: typeof update === 'function' ? update(current[current.active]) : update }));
  /** 새로 만든 자막을 해당 종류에 저장하고, 내용이 있으면 그쪽으로 전환한다. */
  const storeSubtitleSet = (key: SubtitleSetKey, cues: SubtitleCue[]) => {
    beginEdit();
    setSubtitleSets((current) => ({ ...current, [key]: cues, active: cues.length > 0 ? key : current.active }));
    setSelectedCueId(null);
  };
  const [subtitleGenerating, setSubtitleGenerating] = useState(false);
  const [subtitleProgress, setSubtitleProgress] = useState(0);
  const [subtitleLanguage, setSubtitleLanguage] = useState('');
  const [subtitleTranslate, setSubtitleTranslate] = useState(true);
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>(loadSubtitleStyle);
  const [aspect, setAspect] = useState<AspectSetting>(loadAspectSetting);
  const [sourceRatio, setSourceRatio] = useState<number | null>(null);
  const [exportWithSubtitles, setExportWithSubtitles] = useState(true);
  const [selectedCueId, setSelectedCueId] = useState<number | null>(null);
  const [focusCueId, setFocusCueId] = useState<number | null>(null);
  const [extraBusy, setExtraBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [subtitleNotice, setSubtitleNotice] = useState<string | null>(null);
  const [subtitleError, setSubtitleError] = useState<string | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [exportToast, setExportToast] = useState<string | null>(null);
  const scrubberRef = useRef<HTMLDivElement>(null);
  const exportToastTimerRef = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const skipSegmentSyncRef = useRef(false);
  const historyRef = useRef<{ applying: boolean; future: EditSnapshot[]; lastChange: number; mountedAt: number; past: EditSnapshot[]; present: EditSnapshot | null }>({
    applying: false,
    future: [],
    lastChange: 0,
    mountedAt: Date.now(),
    past: [],
    present: null,
  });
  const [, setHistoryVersion] = useState(0);
  /** 한 번에 끝나는 작업(추가·삭제·맞추기 등)은 직전 편집과 묶이지 않고 새 되돌리기 기록이 되도록 한다. */
  const beginEdit = () => {
    historyRef.current.lastChange = 0;
  };

  useEffect(() => {
    return () => {
      if (exportToastTimerRef.current !== null) window.clearTimeout(exportToastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    // 되돌리기로 구간 편집 내용을 복원할 때는 분석 결과로 다시 덮어쓰지 않는다.
    if (skipSegmentSyncRef.current) {
      skipSegmentSyncRef.current = false;
      return;
    }

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
    saveAspectSetting(aspect);
  }, [aspect]);

  useEffect(() => {
    saveSubtitleSets(videoPath, subtitleSets);
  }, [subtitleSets, videoPath]);

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

    if (video.videoWidth > 0 && video.videoHeight > 0) setSourceRatio(video.videoWidth / video.videoHeight);
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
        storeSubtitleSet('voice', []);
        setSubtitleNotice('말소리를 찾지 못했어요. "자동 자막 생성하기"에서 "시나리오대로 만들기"를 눌러 보세요.');
        return;
      }

      if (!subtitleTranslate) {
        storeSubtitleSet('voice', recognized);
      } else {
        try {
          storeSubtitleSet('voice', await translateCuesToKorean(recognized));
        } catch (translateError) {
          console.error(translateError);
          storeSubtitleSet('voice', recognized);
          setSubtitleError(`번역하지 못해 원문 자막을 표시합니다. (${translateError instanceof Error ? translateError.message : '알 수 없는 오류'})`);
        }
      }
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : '자막 생성에 실패했습니다.';

      if (message.includes('오디오 추출')) {
        setSubtitleNotice('이 영상에는 소리가 없어요. "자동 자막 생성하기"에서 "시나리오대로 만들기"를 눌러 보세요.');
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
    beginEdit();
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

      let nextId = 1;
      const created = segments.flatMap((segment) => {
        const text = captionById.get(segment.id);
        if (!text) return [];

        const end = Math.min(segment.end, segment.start + 3.5);
        return [{ id: nextId++, start: segment.start, end: Math.max(end, segment.start + 1), text }];
      });

      storeSubtitleSet('scenario', created.sort((a, b) => a.start - b.start));
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

  const onCuePatch = (cueId: number, patch: Partial<SubtitleCue>) => {
    setSubtitles((current) => current.map((cue) => (cue.id === cueId ? { ...cue, ...patch } : cue)));
  };

  const onCuePositionChange = (cueId: number, position: { x: number; y: number }) => onCuePatch(cueId, position);

  const onCueSizeChange = (cueId: number, size: number) => {
    const cue = subtitles.find((item) => item.id === cueId);
    if (cue) onCuePatch(cueId, { style: { ...cue.style, size } });
  };

  const onCueStyleReset = (cueId: number) => {
    setSubtitles((current) =>
      current.map((cue) => {
        if (cue.id !== cueId) return cue;

        const { style: _style, x: _x, y: _y, ...rest } = cue;
        return rest;
      }),
    );
  };

  /** 자막 추가: 시간을 주면 그 위치, 없으면 현재 재생 위치에 2초짜리 빈 자막을 만들고 바로 입력할 수 있게 한다. */
  const onCueAdd = (at?: number) => {
    beginEdit();
    const length = 2;
    const start = Math.min(Math.max(0, Math.round((at ?? currentTime) * 10) / 10), Math.max(0, playbackDuration - 0.5));
    const end = Math.min(playbackDuration, start + length);
    const id = subtitles.reduce((max, cue) => Math.max(max, cue.id), 0) + 1;

    setSubtitles((current) => [...current, { id, start, end, text: '' }].sort((a, b) => a.start - b.start));
    setSelectedCueId(id);
    setFocusCueId(id);
    setProgress(Math.min(1, Math.max(0, start / playbackDuration)));
    setPlaying(false);
  };

  /** 자막 길이를 겹치는 장면(하이라이트 구간)의 길이에 맞춘다. */
  const onCueFitToClip = (cueId: number) => {
    beginEdit();
    const cue = subtitles.find((item) => item.id === cueId);
    if (!cue || segments.length === 0) return;

    const overlap = (segment: EditorHighlightSegment) => Math.min(cue.end, segment.end) - Math.max(cue.start, segment.start);
    const midpoint = (cue.start + cue.end) / 2;
    const distance = (segment: EditorHighlightSegment) => Math.abs((segment.start + segment.end) / 2 - midpoint);
    const target = segments.reduce((best, segment) => (overlap(segment) > overlap(best) || (overlap(segment) === overlap(best) && distance(segment) < distance(best)) ? segment : best));

    onCuePatch(cueId, { start: target.start, end: target.end });
    setProgress(Math.min(1, Math.max(0, target.start / playbackDuration)));
  };

  /** 선택한 장면에 걸치지 않는 자막은 내보내기에 쓰이지 않으므로 한 번에 지울 수 있게 한다(되돌리기 가능). */
  const onDeleteCuesOutsideSegments = () => {
    beginEdit();
    const ranges = segments.map((segment) => ({ start: segment.start, end: segment.end }));
    const removed = subtitles.filter((cue) => !cueUsedBySegments(cue, ranges)).length;
    if (removed === 0) return;

    setSubtitles((current) => current.filter((cue) => cueUsedBySegments(cue, ranges)));
    setSelectedCueId(null);
    setSubtitleNotice(`장면 밖 자막 ${removed}개를 지웠어요. 되돌리기(⌘/Ctrl + Z)로 복구할 수 있어요.`);
  };

  /** 지금 보이는 자막을 다른 언어로 번역해 아래 줄 자막으로 추가한다. 이미 있으면 새 언어로 다시 변환한다. */
  const onAddExtraLanguage = async (language: string) => {
    if (subtitles.length === 0 || extraBusy) return;

    const label = EXTRA_LANGUAGES.find((item) => item.code === language)?.label ?? language;
    const targets = subtitles.filter((cue) => cue.text.trim());
    if (targets.length === 0) return;

    setExtraBusy(true);
    setSubtitleError(null);
    setSubtitleNotice(null);
    try {
      const translations = await requestTranslations(targets.map((cue) => cue.text), language);
      const extraById = new Map(targets.map((cue, index) => [cue.id, translations[index] ?? '']));

      beginEdit();
      setSubtitles((current) => current.map((cue) => (extraById.has(cue.id) ? { ...cue, extra: extraById.get(cue.id) } : cue)));
      setSubtitleStyle((current) => ({ ...current, extraLang: language, showExtra: true }));
      setSubtitleNotice(`${label} 자막 ${targets.length}개를 아래 줄에 추가했어요. 문장은 직접 고칠 수 있어요.`);
    } catch (error) {
      console.error(error);
      setSubtitleError(error instanceof Error ? error.message : '자막을 변환하지 못했습니다.');
    } finally {
      setExtraBusy(false);
    }
  };

  const onRemoveExtraLanguage = () => {
    beginEdit();
    setSubtitles((current) => current.map(({ extra: _extra, ...rest }) => rest));
    setSubtitleStyle((current) => ({ ...current, showExtra: false }));
  };

  const onActiveSetChange = (key: SubtitleSetKey) => {
    beginEdit();
    setSubtitleSets((current) => ({ ...current, active: key }));
    setSelectedCueId(null);
  };

  /** 목록에서 끌어온 자막을 파형 위에 놓으면 그 시간으로 옮긴다(길이는 유지). */
  const onCueDropOnTimeline = (cueId: number, time: number) => {
    beginEdit();
    onCueMove(cueId, time);
    setSelectedCueId(cueId);
    setProgress(Math.min(1, Math.max(0, time / playbackDuration)));
    setPlaying(false);
  };

  /** 목록에서 끌어온 자막을 영상 화면에 놓으면 그 위치로 옮기고, 보이도록 자막 시작 위치로 이동한다. */
  const onCueDropOnScreen = (cueId: number, position: { x: number; yCenter: number }) => {
    beginEdit();
    const cue = subtitles.find((item) => item.id === cueId);
    if (!cue) return;

    const style = resolveCueStyle(cue, subtitleStyle);
    const lineCount = cue.text.split('\n').length + (subtitleStyle.bilingual && cue.original ? cue.original.split('\n').length : 0);
    const heightPct = style.size * 1.25 * lineCount;

    onCuePatch(cueId, { x: Math.min(95, Math.max(5, position.x)), y: Math.min(95, Math.max(0, position.yCenter - heightPct / 2)) });
    setSelectedCueId(cueId);
    setProgress(Math.min(1, Math.max(0, cue.start / playbackDuration)));
    setPlaying(false);
  };

  const onDownloadSrt = () => {
    downloadTextFile(buildSrt(subtitles, segments, segmentEditSettings, subtitleStyle.bilingual, subtitleStyle.showExtra), 'clipcraft_subtitles.srt');
  };

  const showExportToast = (message: string) => {
    if (exportToastTimerRef.current !== null) window.clearTimeout(exportToastTimerRef.current);

    setExportToast(message);
    exportToastTimerRef.current = window.setTimeout(() => {
      setExportToast(null);
      exportToastTimerRef.current = null;
    }, 3200);
  };

  // 편집 상태가 바뀔 때마다 이전 상태를 기록한다.
  useEffect(() => {
    const history = historyRef.current;
    const snapshot: EditSnapshot = { deletedSegmentIds, segmentEditSettings, segments, subtitleSets, subtitleStyle };
    const previous = history.present;

    history.present = snapshot;
    if (!previous) return;
    if (history.applying) {
      history.applying = false;
      return;
    }
    if (!snapshotsDiffer(snapshot, previous)) return;

    const now = Date.now();
    if (now - history.mountedAt < HISTORY_IGNORE_AFTER_MOUNT_MS) return;

    if (now - history.lastChange > HISTORY_MERGE_MS) {
      history.past.push(previous);
      if (history.past.length > HISTORY_LIMIT) history.past.shift();
    }
    history.future = [];
    history.lastChange = now;
    setHistoryVersion((version) => version + 1);
  }, [deletedSegmentIds, segmentEditSettings, segments, subtitleSets, subtitleStyle]);

  const applySnapshot = (target: EditSnapshot): boolean => {
    const history = historyRef.current;
    if (!history.present || !snapshotsDiffer(target, history.present)) return false;

    if (target.deletedSegmentIds !== history.present.deletedSegmentIds) skipSegmentSyncRef.current = true;
    history.applying = true;
    // 되돌리기·다시 실행 직후의 편집은 이전 편집과 묶이지 않고 새 기록이 되도록 한다.
    history.lastChange = 0;
    setDeletedSegmentIds(target.deletedSegmentIds);
    setSegments(target.segments);
    setSegmentEditSettings(target.segmentEditSettings);
    setSubtitleSets(target.subtitleSets);
    setSubtitleStyle(target.subtitleStyle);
    setSelectedCueId(null);
    return true;
  };

  const undo = () => {
    const history = historyRef.current;
    const present = history.present;
    const target = history.past.pop();
    if (!target || !present) return;

    if (applySnapshot(target)) {
      history.future.push(present);
      showExportToast('이전 편집으로 되돌렸어요');
    }
    setHistoryVersion((version) => version + 1);
  };

  const redo = () => {
    const history = historyRef.current;
    const present = history.present;
    const target = history.future.pop();
    if (!target || !present) return;

    if (applySnapshot(target)) {
      history.past.push(present);
      showExportToast('다시 실행했어요');
    }
    setHistoryVersion((version) => version + 1);
  };

  // ⌘/Ctrl + Z 되돌리기, ⌘/Ctrl + Shift + Z (또는 Ctrl + Y) 다시 실행. 글자를 입력하는 중에는 브라우저 기본 동작을 따른다.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;

      const target = event.target;
      const isEditableTarget =
        target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (isEditableTarget) return;

      event.preventDefault();
      if (key === 'y' || event.shiftKey) redo();
      else undo();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // undo·redo는 ref와 setter만 쓰므로 한 번만 등록한다.
  }, []);

  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;

  const onExport = async () => {
    if (exportState !== 'idle') return;
    if (!videoPath || segments.length === 0) return;

    setExportState('loading');
    try {
      const subtitleCues = exportWithSubtitles ? mapCuesToTimeline(subtitles, segments, segmentEditSettings, subtitleStyle.bilingual, subtitleStyle.showExtra) : [];
      const blob = await requestExportVideo(videoPath, segments, segmentEditSettings, subtitleCues.length > 0 ? { cues: subtitleCues, style: subtitleStyle } : undefined, toExportAspect(aspect));
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

  // 채팅 편집 Agent 대화 한 줄기. 백엔드가 이 id로 이전 대화와 직전 편집을 기억한다.
  const chatThreadRef = useRef<string>(crypto.randomUUID());
  const resetChatThread = () => {
    chatThreadRef.current = crypto.randomUUID();
  };

  const applyLocalNaturalLanguageCommand = (command: string): NaturalLanguageCommandResult => {
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

  const applyNaturalLanguageCommand = async (command: string, confirm?: boolean): Promise<NaturalLanguageCommandResult> => {
    try {
      const response = await requestChatEdit({
        threadId: chatThreadRef.current,
        message: command,
        confirm,
        videoDuration: playbackDuration,
        clips: segments.map((segment) => {
          const setting = segmentEditSettings.find((item) => item.segmentId === segment.id);
          return {
            id: segment.id,
            scenario: segment.scenario,
            title: segment.title,
            start: segment.start,
            end: segment.end,
            speed: setting?.speed ?? 1,
            muted: setting?.muted ?? false,
            subtitle: subtitles.find((cue) => (cue.start + cue.end) / 2 >= segment.start && (cue.start + cue.end) / 2 <= segment.end)?.text || undefined,
          };
        }),
      });

      let skippedNote = '';
      if (response.commands.length > 0) {
        const activeSegmentId = activeSegment !== null ? segments[activeSegment]?.id : null;
        const next = applyChatEditCommands(
          { deletedSegmentIds, segmentEditSettings, segments, subtitles, baseSubtitleSize: subtitleStyle.size, baseSubtitlePosition: subtitleStyle.position },
          response.commands,
        );

        // 말 한 번 = 되돌리기 한 번. 삭제가 있으면 분석 결과로 구간을 다시 덮어쓰지 않게 한다.
        beginEdit();
        if (next.deletedSegmentIds !== deletedSegmentIds) skipSegmentSyncRef.current = true;
        setSegments(next.segments);
        setSegmentEditSettings(next.segmentEditSettings);
        setDeletedSegmentIds(next.deletedSegmentIds);
        if (next.subtitles !== subtitles) setSubtitles(next.subtitles);
        if (next.skippedSubtitleCommands > 0) skippedNote = ` (자막이 없는 클립 ${next.skippedSubtitleCommands}곳은 건너뛰었어요)`;

        if (activeSegmentId !== null) {
          const nextActive = next.segments.findIndex((segment) => segment.id === activeSegmentId);
          setActiveSegment(nextActive >= 0 ? nextActive : null);
        }
      }

      return { message: `${response.reply}${skippedNote}`, status: response.needs_confirm || response.commands.length > 0 ? 'success' : 'error', needsConfirm: response.needs_confirm };
    } catch (error) {
      // 서버에 닿지 않거나 키가 없을 때는 예전의 정해진 명령(배속·음소거·삭제)만이라도 처리한다.
      if (!(error instanceof ApiError) || error.status >= 500) return applyLocalNaturalLanguageCommand(command);
      return { message: error.message, status: 'error' };
    }
  };

  // 가로·정사각형 화면은 폭이 있어야 커 보이므로 왼쪽(영상) 열을 넓힌다. 세로 화면은 높이가 꽉 차서 지금 폭으로 충분하다.
  const wideFrame = (aspect === 'source' ? sourceRatio ?? 0 : getAspectRatio(aspect, null)) >= 1;

  return (
    <div
      className={`editor-shell grid h-screen w-full grid-rows-[52px_minmax(0,1fr)] overflow-hidden bg-white max-[1180px]:h-auto max-[1180px]:min-h-screen max-[1180px]:grid-cols-1 max-[1180px]:overflow-visible ${
        assistantOpen
          ? `${wideFrame ? 'grid-cols-[minmax(380px,1.4fr)_minmax(0,1.6fr)_320px]' : 'grid-cols-[minmax(300px,0.75fr)_minmax(0,1.6fr)_320px]'} max-[1180px]:grid-rows-[52px_minmax(520px,70vh)_auto_minmax(360px,auto)]`
          : `${wideFrame ? 'grid-cols-[minmax(380px,1.4fr)_minmax(0,1.6fr)]' : 'grid-cols-[minmax(300px,0.75fr)_minmax(0,1.6fr)]'} max-[1180px]:grid-rows-[52px_minmax(520px,70vh)_auto]`
      }`}
    >
      <header className="col-[1/-1] flex items-center gap-3.5 border-b border-[rgba(0,0,0,0.08)] px-8">
        <button className="cursor-pointer border-0 bg-transparent p-0" onClick={onBack} type="button" aria-label="업로드 화면으로 돌아가기">
          <Logo height={26} />
        </button>
        <div className="h-4 w-px bg-[rgba(0,0,0,0.1)]" />
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] text-[rgba(0,0,0,0.4)]">프로젝트:</span>
          <span className="text-[13px] font-[480] tracking-[-0.1px]">{projectName ?? videoName ?? '하이라이트 편집'}</span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <button
            aria-label="되돌리기"
            className="flex h-[30px] cursor-pointer items-center gap-1.5 rounded-lg border border-[rgba(0,0,0,0.12)] bg-white px-3 text-[12.5px] font-[500] text-black/70 hover:bg-black/[0.03] disabled:cursor-default disabled:opacity-35 disabled:hover:bg-white"
            data-testid="undo-button"
            disabled={!canUndo}
            onClick={undo}
            title="이전 편집으로 되돌리기 (⌘/Ctrl + Z)"
            type="button"
          >
            ↶ 되돌리기
          </button>
          <button
            aria-label="다시 실행"
            className="flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-lg border border-[rgba(0,0,0,0.12)] bg-white text-[14px] text-black/70 hover:bg-black/[0.03] disabled:cursor-default disabled:opacity-35 disabled:hover:bg-white"
            data-testid="redo-button"
            disabled={!canRedo}
            onClick={redo}
            title="되돌린 편집 다시 실행 (⌘/Ctrl + Shift + Z)"
            type="button"
          >
            ↷
          </button>
        </div>
        <PillButton variant="white" icon="history" small>
          작업 기록
        </PillButton>
        <button
          aria-expanded={assistantOpen}
          aria-label={assistantOpen ? 'AI 어시스턴트 닫기' : 'AI 어시스턴트 열기'}
          className={`flex h-[30px] cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-[12.5px] font-[500] ${assistantOpen ? 'border-transparent text-white' : 'border-[rgba(0,0,0,0.12)] bg-white text-black/70 hover:bg-black/[0.03]'}`}
          data-testid="assistant-toggle"
          onClick={() => setAssistantOpen((open) => !open)}
          style={assistantOpen ? { background: accent } : undefined}
          type="button"
        >
          <Icon d={icons.bot} size={13} stroke={assistantOpen ? '#fff' : 'rgba(0,0,0,0.6)'} />
          AI 어시스턴트
        </button>
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

      <main className="flex min-h-0 flex-col overflow-hidden px-8 py-6">
        <div className="mb-3 flex shrink-0 items-center justify-center gap-1.5" data-testid="aspect-select" role="group" aria-label="화면 비율">
          {ASPECT_OPTIONS.map((option) => (
            <button
              aria-pressed={aspect === option.value}
              className={`cursor-pointer rounded-lg border px-2.5 py-1 text-[12px] transition-colors ${
                aspect === option.value ? 'border-[#5b4bff] bg-[#5b4bff]/10 font-semibold text-[#5b4bff]' : 'border-black/[0.1] bg-transparent text-[rgba(0,0,0,0.55)] hover:bg-black/[0.04]'
              }`}
              data-testid={`aspect-${option.value}`}
              key={option.value}
              onClick={() => setAspect(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        <VideoPreview
          aspect={aspect}
          videoRef={videoRef}
          videoUrl={videoUrl}
          onEnded={() => setPlaying(false)}
          onLoadedMetadata={syncVideoMetadata}
          onTimeUpdate={syncVideoProgress}
          draggable={Boolean(activeCue && activeCue.id === selectedCueId)}
          onCueDrop={onCueDropOnScreen}
          onSubtitleMove={(position) => activeCue && onCuePositionChange(activeCue.id, position)}
          onSubtitleResize={(size) => activeCue && onCueSizeChange(activeCue.id, size)}
          subtitleLines={activeCue ? getCueLines(activeCue, subtitleStyle.bilingual, subtitleStyle.showExtra) : undefined}
          subtitlePosition={activeCue ? { x: activeCue.x, y: activeCue.y } : undefined}
          subtitleStyle={resolveCueStyle(activeCue, subtitleStyle)}
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

      <section className={`flex min-h-0 flex-col overflow-hidden py-5 pl-4 ${assistantOpen ? 'pr-6' : 'pr-10'}`}>
        <WaveformTimeline
          accent={accent}
          duration={duration}
          activeCueId={activeCue?.id}
          onCueAdd={onCueAdd}
          onCueDrop={onCueDropOnTimeline}
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
          activeClip={activeSegment !== null && segments[activeSegment] ? { end: segments[activeSegment].end, index: activeSegment, start: segments[activeSegment].start } : null}
          activeSet={subtitleSets.active}
          cues={subtitles}
          extraBusy={extraBusy}
          focusCueId={focusCueId}
          onAddExtraLanguage={onAddExtraLanguage}
          onRemoveExtraLanguage={onRemoveExtraLanguage}
          onActiveSetChange={onActiveSetChange}
          onCueAdd={() => onCueAdd()}
          onCueFitToClip={onCueFitToClip}
          onDeleteOutside={onDeleteCuesOutsideSegments}
          onFocusHandled={() => setFocusCueId(null)}
          segmentRanges={segments.map((segment) => ({ start: segment.start, end: segment.end }))}
          scenarioCount={subtitleSets.scenario.length}
          voiceCount={subtitleSets.voice.length}
          disabled={!videoPath}
          error={subtitleError}
          generating={subtitleGenerating}
          language={subtitleLanguage}
          notice={subtitleNotice}
          onCueChange={onCueChange}
          onCueDelete={onCueDelete}
          onCuePatch={onCuePatch}
          onCueStyleReset={onCueStyleReset}
          onCueTimeChange={onCueTimeChange}
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

      {/* 대화 기록이 사라지지 않도록 닫아도 화면에서만 숨긴다. */}
      <div className={`min-h-0 flex-col border-l border-[rgba(0,0,0,0.08)] max-[1180px]:border-t max-[1180px]:border-l-0 ${assistantOpen ? 'flex' : 'hidden'}`}>
        <AiAssistant accent={accent} onApplyCommand={applyNaturalLanguageCommand} onReset={resetChatThread} onClose={() => setAssistantOpen(false)} />
      </div>

      {exportToast && (
        <div className="fixed bottom-7 left-1/2 z-[2000] flex -translate-x-1/2 animate-[fadeIn_0.2s_ease] items-center gap-2.5 rounded-full bg-[#0a0a0a] px-[18px] py-3 text-[13.5px] font-[480] tracking-[-0.1px] text-white shadow-[0_10px_30px_rgba(0,0,0,0.25)]">
          <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-white text-[11px] font-bold text-black">✓</span>
          {exportToast}
        </div>
      )}
    </div>
  );
}
