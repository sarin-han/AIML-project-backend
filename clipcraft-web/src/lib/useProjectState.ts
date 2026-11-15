import { useEffect, useState } from 'react';
import { getProjectState } from '@/api/projects';
import type { ProjectState } from '@/api/projects';
import { useAuth } from '@/lib/authContext';

export interface LoadedProject {
  state: ProjectState;
  videoUrl: string;
  videoPath?: string;
  videoName?: string;
}

/** 프로젝트의 저장된 영상·분석 결과·편집 내용을 불러온다. 영상이나 분석 결과가 없으면 error를 돌려준다. */
export function useProjectState(projectId: string | undefined): { loaded: LoadedProject | null; error: string | null } {
  const { accessToken } = useAuth();
  const [loaded, setLoaded] = useState<LoadedProject | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || !accessToken) return;
    let cancelled = false;

    getProjectState(accessToken, projectId)
      .then((state) => {
        if (cancelled) return;
        if (!state.analysis || !state.video?.url) {
          setError('이 프로젝트에 저장된 영상이나 분석 결과가 없어요.');
          return;
        }
        setLoaded({ state, videoUrl: state.video.url, videoPath: state.video.path ?? undefined, videoName: state.video.name ?? undefined });
      })
      .catch(() => {
        if (!cancelled) setError('프로젝트를 불러오지 못했어요.');
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, accessToken]);

  return { loaded, error };
}
