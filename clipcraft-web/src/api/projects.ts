import { requestApiV1 } from '@/api/v1Client';
import type { SubtitleSets, SubtitleStyle } from '@/lib/subtitles';
import type { EditorHighlightSegment, HighlightAnalysisData, SegmentEditSetting } from '@/types/app';

export interface ApiProject {
  id: string;
  title: string;
  status: 'analyzing' | 'completed' | 'draft' | 'editing' | 'failed';
  format: string;
  source_duration_seconds: number | null;
  exported_duration_seconds: number | null;
  scene_count: number;
  source_size_bytes: number | null;
  starred: boolean;
  preview_url: string | null;
  analysis_progress: number | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface ProjectPatchInput {
  version: number;
  title?: string;
  starred?: boolean;
  format?: string;
}

export async function listProjects(accessToken: string): Promise<ApiProject[]> {
  const { data } = await requestApiV1<ApiProject[]>('/projects?page_size=100', {}, accessToken);
  return data;
}

export async function createProject(accessToken: string, input: { title: string; format?: string }): Promise<ApiProject> {
  const { data } = await requestApiV1<ApiProject>('/projects', { method: 'POST', body: JSON.stringify(input) }, accessToken);
  return data;
}

export async function patchProject(accessToken: string, projectId: string, input: ProjectPatchInput): Promise<ApiProject> {
  const { data } = await requestApiV1<ApiProject>(`/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(input) }, accessToken);
  return data;
}

export async function deleteProject(accessToken: string, projectId: string, version: number): Promise<void> {
  await requestApiV1<void>(`/projects/${projectId}?version=${version}`, { method: 'DELETE' }, accessToken);
}

export async function restoreProject(accessToken: string, projectId: string, deletedVersion: number): Promise<ApiProject> {
  const { data } = await requestApiV1<ApiProject>(
    `/projects/${projectId}/restore`,
    { method: 'POST', body: JSON.stringify({ deleted_version: deletedVersion }) },
    accessToken,
  );
  return data;
}

export async function duplicateProject(accessToken: string, projectId: string, title?: string): Promise<ApiProject> {
  const { data } = await requestApiV1<ApiProject>(
    `/projects/${projectId}/duplicate`,
    { method: 'POST', body: JSON.stringify(title ? { title } : {}) },
    accessToken,
  );
  return data;
}

/** 편집 화면에서 저장·복원하는 편집 내용 (되돌리기 대상과 같다) */
export interface EditorSavedState {
  deletedSegmentIds: number[];
  extraSegments: EditorHighlightSegment[];
  segmentEditSettings: SegmentEditSetting[];
  segments: EditorHighlightSegment[];
  subtitleSets: SubtitleSets;
  subtitleStyle: SubtitleStyle;
  /** 구간 썸네일(작은 JPEG data URL). 키는 `id:시작:끝` */
  thumbnails?: Record<string, string>;
}

export interface ProjectState {
  project: ApiProject;
  analysis: HighlightAnalysisData | null;
  editor: EditorSavedState | null;
  job_id: string | null;
  video: { name: string | null; url: string | null; path: string | null } | null;
}

export interface ProjectStateInput {
  analysis?: HighlightAnalysisData;
  editor?: EditorSavedState;
  job_id?: string;
  video_path?: string;
  status?: 'editing' | 'completed';
  exported_duration_seconds?: number;
  preview_url?: string;
}

export async function getProjectState(accessToken: string, projectId: string): Promise<ProjectState> {
  const { data } = await requestApiV1<ProjectState>(`/projects/${projectId}/state`, {}, accessToken);
  return data;
}

export async function saveProjectState(accessToken: string, projectId: string, input: ProjectStateInput): Promise<ApiProject> {
  const { data } = await requestApiV1<ApiProject>(`/projects/${projectId}/state`, { method: 'PUT', body: JSON.stringify(input) }, accessToken);
  return data;
}
