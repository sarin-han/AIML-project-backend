import { useEffect, useRef, useState } from 'react';
import { getAnalyzeJob, normalizeAnalyzeResponse, startAnalyzeJob } from '@/api/analyze';
import { getHighlightJob, normalizeHighlight, normalizeHighlightResult, startHighlightJob } from '@/api/highlights';
import type { HighlightApiItem } from '@/api/highlights';
import { useTheme } from '@/App';
import Logo from '@/components/Logo';
import MonoLabel from '@/components/MonoLabel';
import PillButton from '@/components/PillButton';
import { formatClock } from '@/lib/highlights';
import type { HighlightAnalysisResult, HighlightCandidate, HighlightExtractionResult, PendingHighlightAnalysis } from '@/types/app';

const ANALYSIS_STEPS = [
  { id: 0, label: '영상 파일 수신 중', sub: '분석 요청을 준비하는 중...' },
  { id: 1, label: '프레임 디코딩', sub: 'H.264 디코더 초기화 완료' },
  { id: 2, label: '씬 경계 감지', sub: 'Shot boundary detection 실행 중...' },
  { id: 3, label: '오디오 파형 분석', sub: '무음 구간 및 음성 타임라인 추출 중...' },
  { id: 4, label: '시나리오 매핑', sub: '입력하신 장면 순서와 대조 중...' },
  { id: 5, label: '하이라이트 구간 확정', sub: '편집 타임라인 생성 완료' },
];

// 서버(gpu-server)의 HIGHLIGHT_STEPS와 같은 6단계. 진행 표시는 서버가 알려 주는 실제 단계를 따른다.
const HIGHLIGHT_STEPS = [
  { id: 0, label: '영상 파일 수신 중', sub: '분석 요청을 준비하는 중...' },
  { id: 1, label: '프레임 디코딩', sub: '영상을 프레임으로 푸는 중...' },
  { id: 2, label: '프레임 특징 추출', sub: '프레임마다 장면의 특징을 계산하는 중...' },
  { id: 3, label: '오디오 분석', sub: '음량 · 음성 · 효과음 특징을 추출하는 중...' },
  { id: 4, label: '하이라이트 점수 계산', sub: '구간별 반응도 점수를 매기는 중...' },
  { id: 5, label: '후보 구간 확정', sub: '구간에 이름을 붙이고 정리하는 중...' },
];

// 하이라이트 스캔 줄의 바탕 그림. 결과가 아니라 "훑는 중"을 보여 주는 장식이다.
const SCAN_WAVE = Array.from({ length: 88 }, (_, i) => 4 + Math.abs(Math.sin(i * 0.38 + 0.9) * 18) + Math.abs(Math.cos(i * 0.7) * 8));

const analyzeJobIdsByRequest = new Map<string, string>();
const analyzeJobStartPromisesByRequest = new Map<string, Promise<string>>();

export interface HighlightExtractionDone extends HighlightExtractionResult {
  jobId?: string;
  projectName?: string;
  videoPath?: string;
}

interface AnalyzingScreenProps {
  request: PendingHighlightAnalysis;
  /** 시나리오 분석이 끝났을 때 */
  onDone: (result: HighlightAnalysisResult) => void;
  /** 하이라이트 추출이 끝났을 때 */
  onHighlightDone?: (result: HighlightExtractionDone) => void;
  /** 오류 후 돌아가기, 또는 진행 중 취소. 업로드 화면의 입력은 그대로 남는다. */
  onBack: () => void;
}

function getAnalyzeRequestKey(request: PendingHighlightAnalysis): string {
  return JSON.stringify({
    mode: request.mode ?? 'scenario',
    attempt: request.attempt ?? 0,
    fileName: request.file.name,
    fileSize: request.file.size,
    fileLastModified: request.file.lastModified,
    projectName: request.projectName,
    // 추천으로 받은 구간이 달라지면 다른 요청이다.
    scenarios: request.scenarios.map((scenario) => [scenario.ko, scenario.rec ? scenario.start : null, scenario.rec ? scenario.end : null]),
  });
}

function getOrStartAnalyzeJob(requestKey: string, request: PendingHighlightAnalysis): Promise<string> {
  const cachedJobId = analyzeJobIdsByRequest.get(requestKey);
  if (cachedJobId) return Promise.resolve(cachedJobId);

  const cachedStartPromise = analyzeJobStartPromisesByRequest.get(requestKey);
  if (cachedStartPromise) return cachedStartPromise;

  const start = request.mode === 'highlight' ? startHighlightJob(request.file, request.projectName) : startAnalyzeJob(request.file, request.scenarios, request.projectName);
  const startPromise = start
    .then((job) => {
      analyzeJobIdsByRequest.set(requestKey, job.job_id);
      return job.job_id;
    })
    .catch((error) => {
      analyzeJobStartPromisesByRequest.delete(requestKey);
      throw error;
    });

  analyzeJobStartPromisesByRequest.set(requestKey, startPromise);
  return startPromise;
}

export default function AnalyzingScreen({ request, onDone, onHighlightDone, onBack }: AnalyzingScreenProps) {
  const { accent } = useTheme();
  const isHighlight = request.mode === 'highlight';
  const steps = isHighlight ? HIGHLIGHT_STEPS : ANALYSIS_STEPS;

  const [stepIdx, setStepIdx] = useState(0);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [statusMessage, setStatusMessage] = useState(steps[0].sub);
  const [found, setFound] = useState<HighlightCandidate[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const jobIdRef = useRef<string | null>(null);
  const requestKeyRef = useRef(getAnalyzeRequestKey(request));
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const onHighlightDoneRef = useRef(onHighlightDone);
  onHighlightDoneRef.current = onHighlightDone;

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | undefined;
    let doneTimer: number | undefined;
    const apiStart = performance.now();
    const requestKey = requestKeyRef.current;

    const applyProgress = (job: { progress: number; step_id: number; step_label: string; message: string; logs: string[] }) => {
      setProgress(Math.min(100, Math.max(0, job.progress)));
      setStepIdx(Math.min(steps.length - 1, Math.max(0, job.step_id)));
      setStatusMessage(job.message || job.step_label || steps[job.step_id]?.sub || steps[0].sub);
      setLogLines(job.logs ?? []);
    };

    const finish = (deliver: () => void) => {
      console.log(`[ClipCraft] API 응답 시간: ${((performance.now() - apiStart) / 1000).toFixed(2)}s`);
      setProgress(100);
      setStepIdx(steps.length - 1);
      setDone(true);
      doneTimer = window.setTimeout(() => {
        if (!cancelled) deliver();
      }, 700);
    };

    const pollScenarioJob = (jobId: string) => {
      getAnalyzeJob(jobId)
        .then((job) => {
          if (cancelled) return;
          applyProgress(job);

          if (job.status === 'success') {
            finish(() =>
              onDoneRef.current({
                ...normalizeAnalyzeResponse(job.results),
                jobId,
                projectName: job.project,
                videoPath: job.video_path ?? request.videoPath,
                videoUrl: request.videoUrl,
                videoName: request.videoName,
              }),
            );
            return;
          }

          if (job.status === 'error') {
            setError(job.error || job.message || '분석 요청에 실패했습니다. API 주소와 서버 상태를 확인해 주세요.');
            return;
          }

          pollTimer = window.setTimeout(() => pollScenarioJob(jobId), 900);
        })
        .catch(() => {
          if (cancelled) return;
          setError('분석 상태를 가져오지 못했습니다. API 주소와 서버 상태를 확인해 주세요.');
        });
    };

    const pollHighlightJob = (jobId: string) => {
      getHighlightJob(jobId)
        .then((job) => {
          if (cancelled) return;
          applyProgress(job);
          if (job.found) setFound(job.found.map((item: HighlightApiItem) => normalizeHighlight(item)));

          if (job.status === 'success' && job.result) {
            const result = job.result;
            finish(() => onHighlightDoneRef.current?.({ ...normalizeHighlightResult(result), jobId, projectName: job.project, videoPath: job.video_path ?? request.videoPath }));
            return;
          }

          if (job.status === 'error' || (job.status === 'success' && !job.result)) {
            setError(job.error || job.message || '하이라이트 추출에 실패했습니다. API 주소와 서버 상태를 확인해 주세요.');
            return;
          }

          pollTimer = window.setTimeout(() => pollHighlightJob(jobId), 900);
        })
        .catch(() => {
          if (cancelled) return;
          setError('분석 상태를 가져오지 못했습니다. API 주소와 서버 상태를 확인해 주세요.');
        });
    };

    const pollJob = isHighlight ? pollHighlightJob : pollScenarioJob;

    const startJob = async () => {
      try {
        const existingJobId = jobIdRef.current;
        if (existingJobId) {
          pollJob(existingJobId);
          return;
        }

        const jobId = await getOrStartAnalyzeJob(requestKey, request);
        if (cancelled) return;

        jobIdRef.current = jobId;
        pollJob(jobId);
      } catch {
        if (!cancelled) {
          setError('분석 요청에 실패했습니다. API 주소와 서버 상태를 확인해 주세요.');
        }
      }
    };

    void startJob();

    return () => {
      cancelled = true;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      if (doneTimer !== undefined) window.clearTimeout(doneTimer);
    };
  }, [request.file, request.projectName, request.scenarios, request.videoName, request.videoUrl, request.mode, request.attempt]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  const currentStep = steps[stepIdx];
  const overallPct = Math.min(100, progress);
  const totalSeconds = request.videoDuration ?? 0;

  const title = done
    ? isHighlight
      ? '하이라이트를 찾았어요'
      : '분석 완료!'
    : isHighlight
      ? '영상 전체를 훑어보고 있어요'
      : '영상을 분석하고 있어요';

  const description = error
    ? error
    : done
      ? isHighlight
        ? '결과 화면으로 이동합니다...'
        : '편집 화면으로 이동합니다...'
      : isHighlight
        ? '시나리오 없이 처음부터 끝까지 분석해요.\n반응이 큰 구간을 골라 드릴게요.'
        : '백엔드에서 영상과 시나리오를 처리 중입니다.\n잠시만 기다려 주세요.';

  return (
    <div data-testid="loading-page" className="relative flex min-h-screen flex-col items-center justify-center bg-canvas p-10 max-[480px]:p-5">
      <div className="absolute top-8 left-10 max-[480px]:left-5">
        <Logo height={32} />
      </div>

      <div className={`flex w-full flex-col items-center gap-8 ${isHighlight ? 'max-w-[520px]' : 'max-w-[440px]'}`}>
        <div className="flex flex-col items-center gap-4">
          <div className="relative h-[72px] w-[72px]">
            <svg
              className="absolute inset-0"
              style={{ animation: done || error ? 'none' : 'analyzing-spin 1.4s linear infinite' }}
              width="72"
              height="72"
              viewBox="0 0 72 72"
              fill="none"
            >
              <style>{`@keyframes analyzing-spin { to { transform: rotate(360deg); } }`}</style>
              <circle cx="36" cy="36" r="32" stroke="rgba(0,0,0,0.06)" strokeWidth="4" />
              <circle cx="36" cy="36" r="32" stroke={accent} strokeWidth="4" strokeDasharray="50 151" strokeLinecap="round" style={{ transformOrigin: '36px 36px' }} />
            </svg>
            <div
              className="absolute flex items-center justify-center rounded-[14px] transition-all duration-[400ms]"
              style={{
                inset: 12,
                background: done ? accent : '#fff',
                border: `1.5px solid ${done ? accent : 'rgba(0,0,0,0.1)'}`,
                boxShadow: done ? `0 4px 20px ${accent}44` : '0 2px 8px rgba(0,0,0,0.07)',
              }}
            >
              {done ? (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <rect x="9" y="9" width="6" height="6" rx="1" />
                  <line x1="9" y1="1" x2="9" y2="4" />
                  <line x1="15" y1="1" x2="15" y2="4" />
                  <line x1="9" y1="20" x2="9" y2="23" />
                  <line x1="15" y1="20" x2="15" y2="23" />
                  <line x1="20" y1="9" x2="23" y2="9" />
                  <line x1="20" y1="15" x2="23" y2="15" />
                  <line x1="1" y1="9" x2="4" y2="9" />
                  <line x1="1" y1="15" x2="4" y2="15" />
                </svg>
              )}
            </div>
          </div>

          <div className="text-center">
            <MonoLabel className="mb-2 block">{isHighlight ? 'Highlights · Analyzing' : 'Backend · Analyzing'}</MonoLabel>
            <h2 className="mb-1.5 text-[28px] font-[620] leading-[1.15] tracking-[-0.8px]">{title}</h2>
            <p className="whitespace-pre-line text-[14px] leading-[1.55] tracking-[-0.1px] text-ink-56" role={error ? 'alert' : undefined}>
              {description}
            </p>
          </div>
        </div>

        <div className="flex w-full flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-[480] tracking-[-0.1px] text-ink-56">{done ? '완료' : currentStep.label}</span>
            <span className="font-mono text-[12px] font-[500]" style={{ color: accent }}>
              {overallPct}%
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[rgba(0,0,0,0.07)]">
            <div className="h-full rounded-full" style={{ width: `${overallPct}%`, background: accent, transition: 'width 0.1s linear' }} />
          </div>
          {!done && !error && <span className="font-mono text-[11.5px] tracking-[0.1px] text-ink-56">{statusMessage}</span>}
        </div>

        {/* 하이라이트: 스캔 헤드가 영상 전체를 훑고, 찾은 구간이 그 뒤에서 나타난다 */}
        {isHighlight && (
          <div className="flex w-full flex-col gap-2" data-testid="scan-strip">
            <div className="flex items-center justify-between">
              <MonoLabel>Full video · 00:00 – {totalSeconds > 0 ? formatClock(totalSeconds) : '--:--'}</MonoLabel>
              <span className="text-xs tracking-[-0.1px] text-ink-56">
                찾은 하이라이트{' '}
                <b className="font-[620]" style={{ color: accent }}>
                  {found.length}
                </b>
                곳
              </span>
            </div>
            <div className="relative flex h-[52px] items-center overflow-hidden rounded-[10px] border border-line-soft bg-white px-0.5" aria-hidden="true">
              {SCAN_WAVE.map((value, index) => (
                <div
                  key={index}
                  className="flex-1 rounded-[1px]"
                  style={{ height: Math.max(3, value * 0.8), background: (index / SCAN_WAVE.length) * 100 < overallPct ? `${accent}88` : 'rgba(0,0,0,0.09)' }}
                />
              ))}
              {totalSeconds > 0 &&
                found.map((item) => (
                  <div
                    key={item.id}
                    className="absolute inset-y-0 animate-[fadeIn_0.3s_ease]"
                    style={{
                      left: `${(item.start / totalSeconds) * 100}%`,
                      width: `${((item.end - item.start) / totalSeconds) * 100}%`,
                      background: `${accent}26`,
                      borderLeft: `2px solid ${accent}`,
                    }}
                  />
                ))}
              <div className="absolute inset-y-0 w-0.5" style={{ left: `${overallPct}%`, background: accent, boxShadow: `0 0 12px ${accent}` }} />
            </div>
          </div>
        )}

        {logLines.length > 0 && (
          <div ref={logRef} className="max-h-[132px] w-full overflow-y-auto rounded-[8px] border border-line-soft bg-white px-3 py-2 text-left">
            {logLines.map((line, index) => (
              <div key={`${line}-${index}`} className="font-mono text-[11px] leading-[1.8] text-ink-56">
                {line}
              </div>
            ))}
          </div>
        )}

        {error ? (
          <PillButton variant="white" onClick={onBack} className="px-6 py-3 text-sm font-semibold">
            업로드 화면으로 돌아가기
          </PillButton>
        ) : (
          !done && (
            <button type="button" data-testid="analysis-cancel" onClick={onBack} className="cursor-pointer border-0 bg-transparent p-1 text-[12.5px] tracking-[-0.1px] text-ink-56 underline">
              분석 취소하고 돌아가기
            </button>
          )
        )}
      </div>
    </div>
  );
}
