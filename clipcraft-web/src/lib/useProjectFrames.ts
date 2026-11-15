import { useEffect, useMemo, useState } from 'react';
import { getVideoToken } from '@/api/projects';
import { useAuth } from '@/lib/authContext';

export type FrameUrl = (seconds: number, width?: number) => string;

/**
 * 서버에 저장된 프로젝트 영상의 미리보기 프레임 주소를 만든다.
 * 서버가 ffmpeg로 그 시각의 작은 JPEG만 뽑아 주므로, 브라우저가 영상을 받아 구간마다 시킹할 필요가 없다.
 * projectId가 없거나 토큰을 못 받으면 frameUrl은 null이고 ready는 true라서, 호출한 쪽이 영상에서 직접 캡처하는 방법으로 넘어간다.
 */
export function useProjectFrames(projectId: string | undefined): { frameUrl: FrameUrl | null; ready: boolean } {
  const { accessToken } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!projectId || !accessToken) return;
    let cancelled = false;
    setToken(null);
    setFailed(false);

    getVideoToken(accessToken, projectId)
      .then((value) => {
        if (!cancelled) setToken(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, accessToken]);

  // 같은 토큰이면 같은 함수를 돌려줘서, 이 함수를 의존성으로 쓰는 effect가 매 렌더마다 다시 돌지 않게 한다.
  const frameUrl = useMemo<FrameUrl | null>(
    () => (projectId && token ? (seconds, width = 320) => `/api/v1/projects/${projectId}/frame?t=${seconds.toFixed(1)}&w=${width}&token=${token}` : null),
    [projectId, token],
  );

  return { frameUrl, ready: !projectId || failed || token !== null };
}
