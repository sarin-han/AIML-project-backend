import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { downloadExportedVideo, requestExportVideo } from '@/api/export';
import { ApiError } from '@/api/client';
import { requestChatEdit } from '@/api/chatEdit';
import { saveProjectState } from '@/api/projects';
import { useAuth } from '@/lib/authContext';
import { captureProjectThumbnail } from '@/lib/videoUpload';
import { useProjectFrames } from '@/lib/useProjectFrames';
import { requestSubtitleSuggestions } from '@/api/suggest';
import { requestTranslations, translateCuesToKorean } from '@/api/translate';
import { findScenarios } from '@/api/scenarios';
import type { FoundScenario } from '@/api/scenarios';
import { requestSubtitles } from '@/api/transcribe';
import { useTheme } from '@/App';
import Icon from '@/components/Icon';
import { icons } from '@/components/icons';
import Logo from '@/components/Logo';
import AiAssistant from '@/components/EditorScreen/AiAssistant';
import HighlightList from '@/components/EditorScreen/HighlightList';
import ScenarioAddBar from '@/components/EditorScreen/ScenarioAddBar';
import SubtitlePanel from '@/components/EditorScreen/SubtitlePanel';
import PlayerControls, { getScrubPosition } from '@/components/EditorScreen/PlayerControls';
import VideoPreview from '@/components/EditorScreen/VideoPreview';
import WaveformTimeline from '@/components/EditorScreen/WaveformTimeline';
import { applyChatEditCommands } from '@/lib/chatEditCommands';
import { applyEditorNaturalLanguageCommand } from '@/lib/editorNaturalLanguageCommands';
import { buildSrt, downloadTextFile, EXTRA_LANGUAGES, findActiveCue, cueUsedBySegments, getCueLines, loadSubtitleSets, mapCuesToTimeline, resolveCueStyle, loadSubtitleStyle, saveSubtitleSets, saveSubtitleStyle } from '@/lib/subtitles';
import type { SubtitleSetKey, SubtitleSets, SubtitleStyle } from '@/lib/subtitles';
import { loadDeletedSegmentIds, loadSegmentEditSettings, saveDeletedSegmentIds, saveSegmentEditSettings } from '@/lib/editorStorage';
import type { EditorHighlightSegment, ExportState, SegmentEditSetting, SubtitleCue } from '@/types/app';
import type { EditorScreenProps, NaturalLanguageCommandResult } from '@/types/pages/EditorScreen';
import { createId } from '@/lib/id';

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

      // 목록 썸네일은 작게만 만든다(원본 해상도로 만들면 느리고 저장 용량도 커진다).
      const sourceWidth = video.videoWidth || 320;
      const sourceHeight = video.videoHeight || 180;
      const scale = Math.min(1, 320 / sourceWidth);
      canvas.width = Math.round(sourceWidth * scale);
      canvas.height = Math.round(sourceHeight * scale);
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

    video.preload = 'metadata';
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
  /** 편집 화면에서 "시나리오 추가"로 더한 구간(분석 결과에는 없는 것) */
  extraSegments: EditorHighlightSegment[];
  segmentEditSettings: SegmentEditSetting[];
  segments: EditorHighlightSegment[];
  subtitleSets: SubtitleSets;
  subtitleStyle: SubtitleStyle;
}

const PANEL_DEFAULT = 380;
const PANEL_MIN = 300;
const PANEL_MAX = 640;
const PANEL_STORAGE_KEY = 'cc-ed-pw';

function loadPanelWidth(): number {
  try {
    const saved = Number(localStorage.getItem(PANEL_STORAGE_KEY));
    return saved >= PANEL_MIN && saved <= PANEL_MAX ? saved : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}

/** 상단 바에서만 쓰는 아이콘(공용 아이콘 세트에 없는 것) */
const editorIcons = {
  arrowLeft: 'M19 12H5M12 19l-7-7 7-7',
  redo: 'M21 7v6h-6M21 13a9 9 0 11-9-9 9 9 0 016.7 3',
  undo: 'M3 7v6h6M3 13a9 9 0 109-9 9 9 0 00-6.7 3',
};

const HISTORY_LIMIT = 100;
/** 이 시간(ms) 안에 이어진 변경(끌기, 연속 입력)은 한 번의 편집으로 묶는다. */
const HISTORY_MERGE_MS = 700;
/** 화면을 처음 열 때 저장값을 맞추는 자동 동기화는 편집으로 치지 않는다. */
const HISTORY_IGNORE_AFTER_MOUNT_MS = 800;

function snapshotsDiffer(a: EditSnapshot, b: EditSnapshot): boolean {
  return (Object.keys(a) as Array<keyof EditSnapshot>).some((key) => a[key] !== b[key]);
}

export default function EditorWorkspace({ analysis, onBack, projectName, videoPath, videoName, videoUrl, projectId, jobId, initialEditor, hasPreview, onOpenRecommend, onOpenHighlights }: EditorScreenProps) {
  const { accent } = useTheme();
  const { accessToken } = useAuth();
  // 서버 프로젝트의 편집이면 브라우저 저장값(모든 프로젝트가 같이 쓰는 키) 대신 서버에 저장된 내용으로 시작한다.
  const storedDeletedIds = projectId ? [] : loadDeletedSegmentIds();
  const [deletedSegmentIds, setDeletedSegmentIds] = useState<number[]>(() => initialEditor?.deletedSegmentIds ?? storedDeletedIds);
  const [extraSegments, setExtraSegments] = useState<EditorHighlightSegment[]>(() => initialEditor?.extraSegments ?? []);
  const [segments, setSegments] = useState<EditorHighlightSegment[]>(() => initialEditor?.segments ?? filterDeletedSegments(analysis?.segments ?? [], storedDeletedIds));
  const duration = analysis?.duration && analysis.duration > 0 ? analysis.duration : 15 * 60;
  const waveHeights = amplitudesToWaveHeights(analysis?.amplitudes ?? []);
  const [playing, setPlaying] = useState(false);
  const [playbackDuration, setPlaybackDuration] = useState(duration);
  const [progress, setProgress] = useState(0.52);
  const [activeSegment, setActiveSegment] = useState<number | null>(null);
  const [exportState, setExportState] = useState<ExportState>('idle');
  const [exportProgress, setExportProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [muted, setMuted] = useState(false);
  const [segmentEditSettings, setSegmentEditSettings] = useState<SegmentEditSetting[]>(() =>
    initialEditor?.segmentEditSettings ?? filterStoredEditSettings(projectId ? [] : loadSegmentEditSettings(), analysis?.segments ?? [], storedDeletedIds),
  );
  const [segmentThumbnails, setSegmentThumbnails] = useState<Record<number, string>>({});
  const [subtitleSets, setSubtitleSets] = useState<SubtitleSets>(() => initialEditor?.subtitleSets ?? (projectId ? { voice: [], scenario: [], active: 'voice' } : loadSubtitleSets(videoPath)));
  // 지금 보이는(편집·내보내기 대상) 자막은 active인 쪽이다.
  const subtitles = subtitleSets[subtitleSets.active];
  const setSubtitles = (update: SubtitleCue[] | ((current: SubtitleCue[]) => SubtitleCue[])) =>
    setSubtitleSets((current) => ({ ...current, [current.active]: typeof update === 'function' ? update(current[current.active]) : update }));
  /** 새로 만든 자막을 해당 종류에 저장하고, 내용이 있으면 그쪽으로 전환한다. */
  const storeSubtitleSet = (key: SubtitleSetKey, cues: SubtitleCue[]) => {
    beginEdit();
    setSubtitleSets((current) => ({ ...current, [key]: cues, active: cues.length > 0 ? key : current.active }));
    setSelectedCueId(null);
    if (cues.length > 0) setSubtitleTrackOpen(true);
  };
  const [subtitleGenerating, setSubtitleGenerating] = useState(false);
  const [subtitleProgress, setSubtitleProgress] = useState(0);
  const [subtitleLanguage, setSubtitleLanguage] = useState('');
  const [subtitleTranslate, setSubtitleTranslate] = useState(true);
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>(() => initialEditor?.subtitleStyle ?? loadSubtitleStyle());
  const [tab, setTab] = useState<'scenes' | 'subs'>('scenes');
  const [subtitleTrackOpen, setSubtitleTrackOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth);
  const rootRef = useRef<HTMLDivElement>(null);
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
  // 저장된 편집으로 열었을 때는 처음 한 번 분석 결과로 구간을 다시 만들지 않는다(저장된 구간을 그대로 쓴다).
  const skipSegmentSyncRef = useRef(Boolean(initialEditor));
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

    // 분석 결과 + 편집 화면에서 추가한 구간
    const sourceSegments = [...(analysis?.segments ?? []), ...extraSegments];

    setSegments(filterDeletedSegments(sourceSegments, deletedSegmentIds));
    setSegmentEditSettings((current) => filterStoredEditSettings(current, sourceSegments, deletedSegmentIds));
  }, [analysis?.segments, extraSegments, deletedSegmentIds]);

  useEffect(() => {
    saveSegmentEditSettings(segmentEditSettings);
  }, [segmentEditSettings]);

  useEffect(() => {
    saveSubtitleStyle(subtitleStyle);
  }, [subtitleStyle]);

  useEffect(() => {
    saveSubtitleSets(videoPath, subtitleSets);
  }, [subtitleSets, videoPath]);

  useEffect(() => {
    saveDeletedSegmentIds(deletedSegmentIds);
  }, [deletedSegmentIds]);

  // 구간 썸네일: 이미 만든 것(서버에 저장된 것 포함)은 다시 만들지 않고, 없는 것만 세 개씩 나눠서 만든다.
  const { frameUrl, ready: framesReady } = useProjectFrames(projectId);
  const thumbCacheRef = useRef<Record<string, string>>({ ...(initialEditor?.thumbnails ?? {}) });
  const thumbKey = (segment: EditorHighlightSegment) => `${segment.id}:${segment.start.toFixed(2)}:${segment.end.toFixed(2)}`;
  useEffect(() => {
    if (!videoUrl || segments.length === 0) {
      setSegmentThumbnails({});
      return;
    }

    // 서버에 저장된 영상이면 서버가 그 시각의 작은 이미지를 바로 뽑아 준다. 토큰을 받는 동안은 기다린다.
    if (projectId && !framesReady) return;
    if (frameUrl) {
      setSegmentThumbnails(Object.fromEntries(segments.map((segment) => [segment.id, frameUrl((segment.start + segment.end) / 2)])));
      return;
    }

    const cache = thumbCacheRef.current;
    const fromCache = () => Object.fromEntries(segments.filter((segment) => cache[thumbKey(segment)]).map((segment) => [segment.id, cache[thumbKey(segment)]]));
    setSegmentThumbnails(fromCache());

    const missing = segments.filter((segment) => !cache[thumbKey(segment)]);
    if (missing.length === 0) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const queue = [...missing];
      const worker = async () => {
        while (queue.length > 0 && !cancelled) {
          const segment = queue.shift()!;
          try {
            const url = await captureSegmentThumbnail(videoUrl, segment.start, segment.end);
            if (url) {
              cache[thumbKey(segment)] = url;
              if (!cancelled) setSegmentThumbnails(fromCache());
            }
          } catch {
            // 이 구간 썸네일만 비워 둔다.
          }
        }
      };
      void Promise.all([worker(), worker(), worker()]);
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [segments, videoUrl, projectId, frameUrl, framesReady]);

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

  /** 목록의 × 버튼: 채팅으로 지우는 것과 같은 방식으로 구간을 빼고, 되돌리기 한 번으로 복구할 수 있게 한다. */
  const onSegmentDelete = (segmentId: number) => {
    beginEdit();
    skipSegmentSyncRef.current = true;
    setDeletedSegmentIds((current) => (current.includes(segmentId) ? current : [...current, segmentId]));
    setSegments((current) => current.filter((segment) => segment.id !== segmentId));
    setActiveSegment(null);
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

  /** 영상에서 새 장면을 찾아 구간 목록 끝에 추가한다. 실패하면 화면에 보여 줄 문구를, 성공하면 null을 돌려준다. */
  const onScenarioAdd = async (scenario: string): Promise<string | null> => {
    if (!videoPath) return '서버에 올라간 분석 영상 정보가 없어서 장면을 더 찾을 수 없어요. 영상을 다시 올려 주세요.';

    let found: FoundScenario | null;
    try {
      [found] = await findScenarios(videoPath, [scenario]);
    } catch (error) {
      return error instanceof ApiError ? error.message : '장면을 찾지 못했어요. 잠시 후 다시 시도해 주세요.';
    }

    if (!found) return `영상에서 “${scenario}” 장면을 찾지 못했어요. 다른 표현으로 다시 시도해 보세요.`;

    const start = Math.max(0, found.start);
    // 서버가 분석한 영상 길이 안으로 자른다(브라우저가 읽은 길이는 인코딩에 따라 조금 다를 수 있다).
    const end = Math.min(duration, Math.max(found.end, start + 0.2));
    if (segments.some((segment) => Math.abs(segment.start - start) < 0.5 && Math.abs(segment.end - end) < 0.5)) {
      return '이미 목록에 있는 구간이에요.';
    }

    // 삭제했던 구간의 번호와 겹치지 않게 지금까지 쓴 가장 큰 번호 다음을 쓴다.
    const usedIds = [...(analysis?.segments ?? []).map((item) => item.id), ...extraSegments.map((item) => item.id), ...segments.map((item) => item.id), ...deletedSegmentIds];
    const id = Math.max(0, ...usedIds) + 1;
    const added: EditorHighlightSegment = { id, sourceId: id, scenario, title: scenario, start, end };

    // 지금까지의 구간 편집(자르기·순서)이 분석 결과로 덮이지 않도록 한 번은 자동 동기화를 건너뛴다.
    skipSegmentSyncRef.current = true;
    setExtraSegments((current) => [...current, added]);
    setSegments((current) => [...current, added]);
    setActiveSegment(segments.length);
    setProgress(Math.min(1, Math.max(0, start / playbackDuration)));
    setPlaying(false);
    showExportToast('장면을 추가했어요');
    return null;
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

  const onSuggestSubtitles = async () => {
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
      const captions = await requestSubtitleSuggestions(items, 'scenario');
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
    setSubtitleTrackOpen(true);
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

  // 프로젝트 목록 썸네일: 목록에 아직 썸네일이 없으면 영상 중간 프레임을 한 번 만들어 저장한다.
  const thumbnailTriedRef = useRef(Boolean(hasPreview));
  useEffect(() => {
    if (thumbnailTriedRef.current || !projectId || !accessToken || !videoUrl || !analysis?.duration) return;
    thumbnailTriedRef.current = true;

    captureProjectThumbnail(videoUrl, analysis.duration)
      .then((preview) => saveProjectState(accessToken, projectId, { preview_url: preview }))
      .catch(() => {
        // 썸네일은 꼭 필요한 게 아니므로 실패해도 넘어간다.
      });
  }, [projectId, accessToken, videoUrl, analysis?.duration]);

  /** 서버에 저장하는 분석 결과 + 편집 내용 */
  const buildStatePayload = () => ({
    analysis: { segments: analysis?.segments ?? [], duration: analysis?.duration ?? 0, barCount: analysis?.barCount ?? 0, amplitudes: analysis?.amplitudes ?? [] },
    editor: {
      deletedSegmentIds,
      extraSegments,
      segmentEditSettings,
      segments,
      subtitleSets,
      subtitleStyle,
      // 만들어 둔 구간 썸네일도 저장해서, 프로젝트를 다시 열 때 영상에서 다시 뽑지 않게 한다.
      thumbnails: Object.fromEntries(segments.filter((segment) => thumbCacheRef.current[thumbKey(segment)]).map((segment) => [thumbKey(segment), thumbCacheRef.current[thumbKey(segment)]])),
    },
    job_id: jobId,
    video_path: videoPath,
  });

  /** 다른 화면(추천·하이라이트 추출)으로 나가기 전에 지금까지의 편집을 바로 저장한다. 그 화면이 서버에 저장된 편집 내용에 구간을 더하기 때문이다. */
  const saveThenGo = async (go?: () => void) => {
    if (projectId && accessToken) {
      try {
        await saveProjectState(accessToken, projectId, buildStatePayload());
      } catch {
        // 저장에 실패해도 이동은 막지 않는다.
      }
    }
    go?.();
  };

  // 서버 프로젝트의 편집 내용을 잠깐 모아서 저장한다. 저장된 내용으로 막 열었을 때는 바뀐 게 없으므로 첫 실행은 건너뛴다.
  const skipFirstSaveRef = useRef(Boolean(initialEditor));
  useEffect(() => {
    if (!projectId || !accessToken) return;
    if (skipFirstSaveRef.current) {
      skipFirstSaveRef.current = false;
      return;
    }

    const timer = window.setTimeout(() => {
      saveProjectState(accessToken, projectId, buildStatePayload()).catch((error) => console.error('프로젝트 저장 실패', error));
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [projectId, accessToken, analysis, jobId, videoPath, deletedSegmentIds, extraSegments, segmentEditSettings, segments, subtitleSets, subtitleStyle, segmentThumbnails]);

  // 편집 상태가 바뀔 때마다 이전 상태를 기록한다.
  useEffect(() => {
    const history = historyRef.current;
    const snapshot: EditSnapshot = { deletedSegmentIds, extraSegments, segmentEditSettings, segments, subtitleSets, subtitleStyle };
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
  }, [deletedSegmentIds, extraSegments, segmentEditSettings, segments, subtitleSets, subtitleStyle]);

  const applySnapshot = (target: EditSnapshot): boolean => {
    const history = historyRef.current;
    if (!history.present || !snapshotsDiffer(target, history.present)) return false;

    if (target.deletedSegmentIds !== history.present.deletedSegmentIds || target.extraSegments !== history.present.extraSegments) skipSegmentSyncRef.current = true;
    history.applying = true;
    // 되돌리기·다시 실행 직후의 편집은 이전 편집과 묶이지 않고 새 기록이 되도록 한다.
    history.lastChange = 0;
    setDeletedSegmentIds(target.deletedSegmentIds);
    setExtraSegments(target.extraSegments);
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

    setExportProgress(0);
    setExportState('loading');
    try {
      const subtitleCues = exportWithSubtitles ? mapCuesToTimeline(subtitles, segments, segmentEditSettings, subtitleStyle.bilingual, subtitleStyle.showExtra) : [];
      const blob = await requestExportVideo(videoPath, segments, segmentEditSettings, subtitleCues.length > 0 ? { cues: subtitleCues, style: subtitleStyle } : undefined, undefined, setExportProgress);
      downloadExportedVideo(blob);
      if (projectId && accessToken) {
        const exportedSeconds = segments.reduce((total, segment) => total + Math.max(0, segment.end - segment.start) / (segmentEditSettings.find((item) => item.segmentId === segment.id)?.speed || 1), 0);
        saveProjectState(accessToken, projectId, { status: 'completed', exported_duration_seconds: Math.round(exportedSeconds * 10) / 10 }).catch(() => undefined);
      }
      setExportState('done');
      showExportToast('내보내기가 완료됐어요');
      window.setTimeout(() => setExportState('idle'), 1800);
    } catch (error) {
      console.error(error);
      setExportState('idle');
      showExportToast(error instanceof Error && error.message ? `내보내기에 실패했어요: ${error.message}` : '내보내기에 실패했습니다. 백엔드 서버와 영상 경로를 확인해 주세요.');
    }
  };

  // 채팅 편집 Agent 대화 한 줄기. 백엔드가 이 id로 이전 대화와 직전 편집을 기억한다.
  const chatThreadRef = useRef<string>(createId());
  const resetChatThread = () => {
    chatThreadRef.current = createId();
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

  // 자막 탭은 지금 재생 위치가 속한 클립의 자막을 모아서 보여 준다(클립이 바뀌면 따라 바뀐다). 클립 밖이면 마지막으로 고른 클립.
  const playheadClipIndex = segments.findIndex((segment) => currentTime >= segment.start && currentTime < segment.end);
  const subtitleClipIndex = playheadClipIndex >= 0 ? playheadClipIndex : activeSegment !== null && segments[activeSegment] ? activeSegment : null;
  const subtitleClip = subtitleClipIndex !== null ? { end: segments[subtitleClipIndex].end, index: subtitleClipIndex, start: segments[subtitleClipIndex].start } : null;

  const clampPanelWidth = (value: number) => {
    const rootWidth = rootRef.current?.getBoundingClientRect().width ?? 1200;
    return Math.round(Math.max(PANEL_MIN, Math.min(value, PANEL_MAX, rootWidth * 0.55)));
  };
  const savePanelWidth = (value: number) => {
    try {
      localStorage.setItem(PANEL_STORAGE_KEY, String(value));
    } catch {
      // 저장소를 쓸 수 없어도 화면은 그대로 동작한다.
    }
  };
  const startPanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const widthAt = (clientX: number) => clampPanelWidth((rootRef.current?.getBoundingClientRect().right ?? clientX) - clientX);
    const onMove = (moveEvent: PointerEvent) => setPanelWidth(widthAt(moveEvent.clientX));
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      savePanelWidth(widthAt(upEvent.clientX));
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const ghostButton =
    'ed-pill ed-pill-ghost';

  return (
    <div className="ed-root" ref={rootRef} style={{ '--ed-pw': `${panelWidth}px` } as CSSProperties}>
      <header className="ed-top">
        <button className="ed-ibtn" onClick={onBack} type="button" aria-label="이전 단계" title="이전 단계">
          <Icon d={editorIcons.arrowLeft} size={15} strokeWidth={1.6} />
        </button>
        <button className="cursor-pointer border-0 bg-transparent p-0" onClick={onBack} type="button" aria-label="업로드 화면으로 돌아가기">
          <Logo height={24} />
        </button>
        <div className="ed-sep" />
        <span className="ed-pname" title={projectName ?? videoName ?? '하이라이트 편집'}>
          {projectName ?? videoName ?? '하이라이트 편집'}
        </span>
        <div style={{ flex: 1 }} />
        <button aria-label="되돌리기" className="ed-ibtn" data-testid="undo-button" disabled={!canUndo} onClick={undo} title="이전 편집으로 되돌리기 (⌘/Ctrl + Z)" type="button">
          <Icon d={editorIcons.undo} size={15} strokeWidth={1.6} />
        </button>
        <button aria-label="다시 실행" className="ed-ibtn" data-testid="redo-button" disabled={!canRedo} onClick={redo} title="되돌린 편집 다시 실행 (⌘/Ctrl + Shift + Z)" type="button">
          <Icon d={editorIcons.redo} size={15} strokeWidth={1.6} />
        </button>
        {/* TODO: 작업 기록 버튼은 지금 사용하지 않아 주석 처리함. 나중에 기능(작업 기록 목록/복원)을 구현할 때 다시 살려야 함.
        <button className={ghostButton} title="작업 기록" type="button">
          <Icon d={icons.history} size={14} strokeWidth={1.6} />
          <span className="ed-lbl-h">작업 기록</span>
        </button>
        */}
        <button
          aria-expanded={assistantOpen}
          aria-label={assistantOpen ? 'AI 어시스턴트 닫기' : 'AI 어시스턴트 열기'}
          className={ghostButton}
          data-testid="assistant-toggle"
          onClick={() => setAssistantOpen((open) => !open)}
          style={assistantOpen ? { background: `${accent}14`, color: accent, boxShadow: `0 0 0 1px ${accent}55` } : undefined}
          type="button"
        >
          <Icon d={icons.sparkles} size={14} strokeWidth={1.6} />
          <span className="ed-lbl">AI 어시스턴트</span>
        </button>
        {subtitles.length > 0 && (
          <label className="flex flex-none cursor-pointer items-center gap-1.5 text-[12.5px] whitespace-nowrap text-[rgba(0,0,0,0.65)]">
            <input checked={exportWithSubtitles} onChange={(event) => setExportWithSubtitles(event.target.checked)} type="checkbox" />
            자막 포함
          </label>
        )}
        <button
          className="ed-pill"
          disabled={!videoPath || segments.length === 0 || exportState === 'loading'}
          onClick={onExport}
          style={{ background: accent, color: '#fff' }}
          type="button"
        >
          <Icon d={exportState === 'done' ? icons.check : icons.download} size={14} strokeWidth={1.6} />
          <span>
            {exportState === 'loading' ? (
              exportProgress > 0 ? `내보내는 중… ${exportProgress}%` : '내보내는 중…'
            ) : exportState === 'done' ? (
              '완료!'
            ) : (
              <>
                <span className="ed-lbl-full">MP4로 </span>내보내기
              </>
            )}
          </span>
        </button>
      </header>

      <main className="ed-stage">
        <div className="ed-vwrap">
          <VideoPreview
            aspect="source"
            videoRef={videoRef}
            videoUrl={videoUrl}
            onEnded={() => setPlaying(false)}
            onLoadedMetadata={syncVideoMetadata}
            onTimeUpdate={syncVideoProgress}
            draggable={Boolean(activeCue && activeCue.id === selectedCueId)}
            onSubtitleMove={(position) => activeCue && onCuePositionChange(activeCue.id, position)}
            onSubtitleResize={(size) => activeCue && onCueSizeChange(activeCue.id, size)}
            subtitleLines={activeCue ? getCueLines(activeCue, subtitleStyle.bilingual, subtitleStyle.showExtra) : undefined}
            subtitlePosition={activeCue ? { x: activeCue.x, y: activeCue.y } : undefined}
            subtitleStyle={resolveCueStyle(activeCue, subtitleStyle)}
          />
        </div>
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

      <section className="ed-tl">
        <WaveformTimeline
          accent={accent}
          duration={duration}
          activeCueId={activeCue?.id}
          onCueAdd={onCueAdd}
          onCueMove={onCueMove}
          onCueSelect={(cueId) => {
            setSelectedCueId(cueId);
            setTab('subs');
          }}
          selectedCueId={selectedCueId}
          onCueTimeChange={onCueTimeChange}
          onSegmentChange={onSegmentChange}
          onSegmentPick={onSegmentClick}
          activeSegmentId={activeSegment !== null ? segments[activeSegment]?.id ?? null : null}
          subtitleTrackOpen={subtitleTrackOpen}
          onSubtitleTrackToggle={() => setSubtitleTrackOpen((open) => !open)}
          progress={progress}
          segments={segments}
          setPlaying={setPlaying}
          setProgress={setProgress}
          subtitleCues={subtitles}
          waveHeights={waveHeights}
        />
      </section>

      <aside className="ed-panel">
        <div
          aria-label="패널 너비 조절 (←/→, 더블클릭으로 초기화)"
          aria-orientation="vertical"
          aria-valuemax={PANEL_MAX}
          aria-valuemin={PANEL_MIN}
          aria-valuenow={panelWidth}
          className="ed-resize"
          onDoubleClick={() => {
            setPanelWidth(PANEL_DEFAULT);
            savePanelWidth(PANEL_DEFAULT);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const next = clampPanelWidth(panelWidth + (event.key === 'ArrowLeft' ? 16 : -16));
            setPanelWidth(next);
            savePanelWidth(next);
          }}
          onPointerDown={startPanelResize}
          role="separator"
          tabIndex={0}
        />
        <div className="flex-none px-4 pt-3">
          <div className="flex gap-0.5 rounded-full bg-black/5 p-[3px]" role="tablist">
            {(
              [
                ['scenes', '시나리오', segments.length],
                ['subs', '자막', subtitles.length],
              ] as const
            ).map(([id, label, count]) => (
              <button
                aria-selected={tab === id}
                className="inline-flex h-[30px] flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full border-0 text-[13px] font-[520] whitespace-nowrap"
                data-testid={`editor-tab-${id}`}
                key={id}
                onClick={() => setTab(id)}
                role="tab"
                style={{ background: tab === id ? '#fff' : 'transparent', boxShadow: tab === id ? '0 1px 3px rgba(0,0,0,0.12)' : 'none', color: tab === id ? '#000' : 'rgba(0,0,0,0.5)' }}
                type="button"
              >
                {label}
                <span className="font-mono text-[11px] opacity-55">{count}</span>
              </button>
            ))}
          </div>
        </div>

        {tab === 'scenes' ? (
          <>
            <HighlightList
              activeSegment={activeSegment}
              currentTime={currentTime}
              onSegmentClick={onSegmentClick}
              onSegmentDelete={onSegmentDelete}
              onSegmentsReorder={onSegmentsReorder}
              segmentEditSettings={segmentEditSettings}
              segments={segments}
              thumbnails={segmentThumbnails}
            />
            <ScenarioAddBar accent={accent} onAdd={onScenarioAdd} onOpenHighlights={onOpenHighlights && projectId ? () => void saveThenGo(onOpenHighlights) : undefined} onOpenRecommend={onOpenRecommend && projectId ? () => void saveThenGo(onOpenRecommend) : undefined} />
          </>
        ) : (
          <SubtitlePanel
            activeClip={subtitleClip}
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
        )}
      </aside>

      {/* AI 어시스턴트는 필요할 때만 오른쪽에서 밀려 나오는 서랍. 닫아도 대화 기록이 사라지지 않도록 화면에서만 숨긴다. */}
      {assistantOpen && <div className="fixed inset-0 z-[70] bg-black/[0.12]" onClick={() => setAssistantOpen(false)} />}
      <div aria-hidden={!assistantOpen} className="ed-drawer" data-open={assistantOpen ? 1 : 0} data-testid="assistant-drawer">
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
