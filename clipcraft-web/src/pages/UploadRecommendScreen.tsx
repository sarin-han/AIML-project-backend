import { useEffect, useState } from 'react';
import { getScenarioJob, startScenarioJob } from '@/api/projectJobs';
import type { RecommendedScenario } from '@/api/projectJobs';
import ProjectJobProgress from '@/components/HighlightResult/ProjectJobProgress';
import ScenarioRecommendView from '@/components/HighlightResult/ScenarioRecommendView';
import { buildScenarioAnalysis } from '@/lib/highlights';
import type { HighlightAnalysisResult, PendingHighlightAnalysis } from '@/types/app';

interface UploadRecommendScreenProps {
  request: PendingHighlightAnalysis;
  onBack: () => void;
  onRetry: () => void;
  onNext: (analysis: HighlightAnalysisResult) => void;
}

type Phase = { kind: 'running'; message: string } | { kind: 'done'; plan: RecommendedScenario; jobId: string; videoPath?: string } | { kind: 'error'; message: string };

// 같은 요청(화면이 다시 그려지거나 개발 모드에서 두 번 실행돼도)은 영상을 한 번만 올린다.
const jobIdsByRequest = new Map<string, Promise<string>>();

function requestKey(request: PendingHighlightAnalysis): string {
  return JSON.stringify([request.file.name, request.file.size, request.file.lastModified, request.projectName, request.projectId, request.attempt ?? 0]);
}

/** 업로드 화면에서 "추천받기"로 시작한 흐름: 영상을 올려 시나리오를 추천받고, 고른 장면으로 편집을 시작한다. */
export default function UploadRecommendScreen({ request, onBack, onRetry, onNext }: UploadRecommendScreenProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'running', message: '영상을 올리는 중이에요...' });

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const key = requestKey(request);

    const poll = (jobId: string) => {
      getScenarioJob(jobId)
        .then((job) => {
          if (cancelled) return;
          if (job.status === 'success' && job.result) {
            setPhase({ kind: 'done', plan: job.result, jobId, videoPath: job.video_path ?? undefined });
            return;
          }
          if (job.status === 'error' || job.status === 'success') {
            setPhase({ kind: 'error', message: job.error || job.message || '시나리오 추천에 실패했어요.' });
            return;
          }
          setPhase({ kind: 'running', message: job.message || '영상을 훑어서 시나리오를 만드는 중...' });
          timer = window.setTimeout(() => poll(jobId), 1500);
        })
        .catch(() => {
          if (!cancelled) setPhase({ kind: 'error', message: '작업 상태를 가져오지 못했어요. 잠시 후 다시 시도해 주세요.' });
        });
    };

    let start = jobIdsByRequest.get(key);
    if (!start) {
      start = startScenarioJob(request.file, request.projectName, request.projectId).then((job) => job.job_id);
      start.catch(() => jobIdsByRequest.delete(key));
      jobIdsByRequest.set(key, start);
    }

    start
      .then((jobId) => {
        if (cancelled) return;
        setPhase({ kind: 'running', message: '영상을 훑어서 시나리오를 만드는 중...' });
        poll(jobId);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setPhase({ kind: 'error', message: reason instanceof Error ? reason.message : '시나리오 추천을 시작하지 못했어요.' });
      });

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [request]);

  if (phase.kind === 'running') return <ProjectJobProgress title="시나리오를 추천하고 있어요" message={phase.message} backLabel="업로드로 돌아가기" onBack={onBack} />;
  if (phase.kind === 'error') return <ProjectJobProgress title="" message="" error={phase.message} backLabel="업로드로 돌아가기" onBack={onBack} onRetry={onRetry} />;

  const { plan, jobId, videoPath } = phase;

  return (
    <ScenarioRecommendView
      plan={plan}
      duration={plan.duration ?? 0}
      amplitudes={plan.audio?.amplitudes ?? []}
      videoUrl={request.videoUrl}
      projectId={request.projectId}
      backLabel="업로드로 돌아가기"
      confirmLabel="선택한 장면으로 편집 시작"
      onBack={onBack}
      onRetry={onRetry}
      onConfirm={(scenes) =>
        onNext(
          buildScenarioAnalysis(plan, scenes, {
            jobId,
            projectId: request.projectId,
            projectName: request.projectName,
            videoPath: videoPath ?? request.videoPath,
            videoUrl: request.videoUrl,
            videoName: request.videoName,
          }),
        )
      }
    />
  );
}
