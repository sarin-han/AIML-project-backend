import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { saveProjectState } from '@/api/projects';
import { getHighlightJob, normalizeHighlightResult } from '@/api/highlights';
import { startProjectHighlightJob } from '@/api/projectJobs';
import HighlightResultScreen from '@/pages/HighlightResultScreen';
import ProjectJobProgress from '@/components/HighlightResult/ProjectJobProgress';
import { useAuth } from '@/lib/authContext';
import { appendSegmentsToProject } from '@/lib/projectEditorMerge';
import { useProjectState } from '@/lib/useProjectState';
import type { HighlightExtractionResult } from '@/types/app';

type Phase = { kind: 'running'; progress: number; message: string } | { kind: 'done'; extraction: HighlightExtractionResult; jobId: string } | { kind: 'error'; message: string };

/** 저장된 프로젝트의 영상에서 하이라이트를 추출하고, 고른 구간을 편집 목록 끝에 추가한다. */
export default function ProjectHighlightsScreen() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { accessToken } = useAuth();
  const { loaded, error } = useProjectState(projectId);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: 'running', progress: 0, message: '하이라이트 추출을 준비하는 중...' });
  const backToEditor = () => navigate(`/workspace/${projectId}`);

  useEffect(() => {
    if (!loaded || !projectId) return;
    let cancelled = false;
    let timer: number | undefined;
    setPhase({ kind: 'running', progress: 0, message: '하이라이트 추출을 준비하는 중...' });

    const poll = (jobId: string) => {
      getHighlightJob(jobId)
        .then((job) => {
          if (cancelled) return;
          if (job.status === 'success' && job.result) {
            setPhase({ kind: 'done', extraction: normalizeHighlightResult(job.result), jobId });
            return;
          }
          if (job.status === 'error' || job.status === 'success') {
            setPhase({ kind: 'error', message: job.error || job.message || '하이라이트 추출에 실패했어요.' });
            return;
          }
          setPhase({ kind: 'running', progress: job.progress ?? 0, message: job.message || '영상을 분석하는 중...' });
          timer = window.setTimeout(() => poll(jobId), 1200);
        })
        .catch(() => {
          if (!cancelled) setPhase({ kind: 'error', message: '작업 상태를 가져오지 못했어요. 잠시 후 다시 시도해 주세요.' });
        });
    };

    startProjectHighlightJob(projectId)
      .then((job) => {
        if (!cancelled) poll(job.job_id);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setPhase({ kind: 'error', message: reason instanceof Error ? reason.message : '하이라이트 추출을 시작하지 못했어요.' });
      });

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loaded, projectId, attempt]);

  if (error) return <ProjectJobProgress title="" message="" error={error} backLabel="편집으로 돌아가기" onBack={() => navigate('/workspace')} />;
  if (!loaded || phase.kind === 'running') {
    return (
      <ProjectJobProgress
        title="하이라이트를 추출하고 있어요"
        message={phase.kind === 'running' ? phase.message : '프로젝트를 불러오는 중...'}
        progress={phase.kind === 'running' && phase.progress > 0 ? phase.progress : undefined}
        backLabel="편집으로 돌아가기"
        onBack={backToEditor}
      />
    );
  }
  if (phase.kind === 'error') return <ProjectJobProgress title="" message="" error={phase.message} backLabel="편집으로 돌아가기" onBack={backToEditor} onRetry={() => setAttempt((value) => value + 1)} />;

  return (
    <HighlightResultScreen
      extraction={phase.extraction}
      jobId={phase.jobId}
      projectName={loaded.state.project.title}
      videoPath={loaded.videoPath}
      videoUrl={loaded.videoUrl}
      videoName={loaded.videoName ?? ''}
      projectId={projectId}
      backLabel="편집으로 돌아가기"
      startLabel="선택한 구간을 편집에 추가"
      onBack={backToEditor}
      onRetry={() => setAttempt((value) => value + 1)}
      onNext={(selected) => {
        if (!accessToken || !projectId) return;
        const merged = appendSegmentsToProject(loaded.state, selected.segments.map((segment) => ({ scenario: segment.scenario, start: segment.start, end: segment.end })));
        saveProjectState(accessToken, projectId, { analysis: merged.analysis, editor: merged.editor })
          .then(backToEditor)
          .catch(() => setPhase({ kind: 'error', message: '편집 목록에 추가하지 못했어요. 잠시 후 다시 시도해 주세요.' }));
      }}
    />
  );
}
