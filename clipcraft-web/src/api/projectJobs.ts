import { requestJson } from '@/api/client';

export interface ProjectJobStart {
  status: string;
  job_id: string;
  /** GPU 서버에 있는 분석용 영상 경로(내보내기·장면 찾기에 쓴다) */
  video_path?: string;
}

export interface RecommendedScenarioScene {
  order: number;
  start: number;
  end: number;
  /** 장면 이름 (예: 컵라면을 열고 재료를 꺼내는 모습) */
  description: string;
  /** 이 장면을 쓰면 좋은 이유 한 문장 */
  reason: string;
}

export interface RecommendedScenario {
  title: string;
  summary: string;
  scenes: RecommendedScenarioScene[];
  /** 영상 전체 길이(초)와 오디오 파형. 결과 화면의 타임라인에 쓴다. */
  duration?: number;
  audio?: { barCount: number; amplitudes: number[] };
}

export interface ScenarioJobStatus {
  status: 'queued' | 'running' | 'success' | 'error' | string;
  progress: number;
  message: string;
  video_path?: string | null;
  error?: string | null;
  result?: RecommendedScenario | null;
}

const postJson = (path: string, projectId: string) =>
  requestJson<ProjectJobStart>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: projectId }) });

/** 저장된 프로젝트 영상으로 하이라이트 추출을 시작한다. 영상을 다시 올리지 않는다. */
export const startProjectHighlightJob = (projectId: string) => postJson('/highlights/jobs/from-project', projectId);

/** 저장된 프로젝트 영상으로 시나리오(제목·요약·장면별 설명) 추천을 시작한다. */
export const startProjectScenarioJob = (projectId: string) => postJson('/scenario/jobs/from-project', projectId);

export const getScenarioJob = (jobId: string) => requestJson<ScenarioJobStatus>(`/scenario/jobs/${jobId}`);

/** 업로드 화면에서 올린 영상으로 시나리오 추천을 시작한다. 영상은 프로젝트에도 저장된다. */
export function startScenarioJob(file: File, projectName: string, projectId?: string) {
  const formData = new FormData();
  formData.append('video', file, file.name);
  formData.append('project_name', projectName);
  if (projectId) formData.append('project_id', projectId);

  return requestJson<ProjectJobStart>('/scenario/jobs', { method: 'POST', body: formData });
}
