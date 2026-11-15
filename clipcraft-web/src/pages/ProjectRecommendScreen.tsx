import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { saveProjectState } from '@/api/projects';
import { getScenarioJob, startProjectScenarioJob } from '@/api/projectJobs';
import type { RecommendedScenario } from '@/api/projectJobs';
import ProjectJobProgress from '@/components/HighlightResult/ProjectJobProgress';
import ScenarioRecommendView from '@/components/HighlightResult/ScenarioRecommendView';
import { useAuth } from '@/lib/authContext';
import { appendSegmentsToProject } from '@/lib/projectEditorMerge';
import { useProjectState } from '@/lib/useProjectState';

type Phase = { kind: 'running'; message: string } | { kind: 'done'; plan: RecommendedScenario } | { kind: 'error'; message: string };

/** 편집 화면에서 연 시나리오 추천: 저장된 프로젝트 영상으로 추천받고, 고른 장면을 편집 목록 끝에 추가한다. */
export default function ProjectRecommendScreen() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { accessToken } = useAuth();
  const { loaded, error } = useProjectState(projectId);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: 'running', message: '시나리오 추천을 준비하는 중...' });
  const [saving, setSaving] = useState(false);
  const backToEditor = () => navigate(`/workspace/${projectId}`);

  useEffect(() => {
    if (!loaded || !projectId) return;
    let cancelled = false;
    let timer: number | undefined;
    setPhase({ kind: 'running', message: '시나리오 추천을 준비하는 중...' });

    const poll = (jobId: string) => {
      getScenarioJob(jobId)
        .then((job) => {
          if (cancelled) return;
          if (job.status === 'success' && job.result) {
            setPhase({ kind: 'done', plan: job.result });
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

    startProjectScenarioJob(projectId)
      .then((job) => {
        if (!cancelled) poll(job.job_id);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setPhase({ kind: 'error', message: reason instanceof Error ? reason.message : '시나리오 추천을 시작하지 못했어요.' });
      });

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loaded, projectId, attempt]);

  if (error) return <ProjectJobProgress title="" message="" error={error} backLabel="편집으로 돌아가기" onBack={() => navigate('/workspace')} />;
  if (!loaded || phase.kind === 'running') {
    return <ProjectJobProgress title="시나리오를 추천하고 있어요" message={phase.kind === 'running' ? phase.message : '프로젝트를 불러오는 중...'} backLabel="편집으로 돌아가기" onBack={backToEditor} />;
  }
  if (phase.kind === 'error') return <ProjectJobProgress title="" message="" error={phase.message} backLabel="편집으로 돌아가기" onBack={backToEditor} onRetry={() => setAttempt((value) => value + 1)} />;

  const analysis = loaded.state.analysis;

  return (
    <ScenarioRecommendView
      plan={phase.plan}
      duration={phase.plan.duration || analysis?.duration || 0}
      amplitudes={phase.plan.audio?.amplitudes ?? analysis?.amplitudes ?? []}
      videoUrl={loaded.videoUrl}
      projectId={projectId}
      backLabel="편집으로 돌아가기"
      confirmLabel="선택한 장면을 편집에 추가"
      saving={saving}
      onBack={backToEditor}
      onRetry={() => setAttempt((value) => value + 1)}
      onConfirm={(selectedScenes) => {
        if (!accessToken || !projectId || saving) return;
        setSaving(true);
        const merged = appendSegmentsToProject(loaded.state, selectedScenes.map((scene) => ({ scenario: scene.description, start: scene.start, end: scene.end })));
        saveProjectState(accessToken, projectId, { analysis: merged.analysis, editor: merged.editor })
          .then(backToEditor)
          .catch(() => {
            setSaving(false);
            setPhase({ kind: 'error', message: '편집 목록에 추가하지 못했어요. 잠시 후 다시 시도해 주세요.' });
          });
      }}
    />
  );
}
