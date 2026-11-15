import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { FindMethod, ScenarioItem } from '@/types/app';
import type { UploadedVideo } from '@/types/pages/UploadScreen';

/**
 * 업로드 화면의 입력 상태를 화면 밖에 둔다.
 * 분석 중 "취소"로 돌아오거나 결과 화면에서 "시나리오 입력으로" 돌아와도
 * 올린 영상, 고른 방법, 입력한 장면이 그대로 남는다.
 */
interface UploadSessionValue {
  uploadedVideo: UploadedVideo | null;
  /** 영상을 바꾸거나 비울 때 이전 영상의 object URL을 해제한다. */
  setUploadedVideo: (video: UploadedVideo | null) => void;
  method: FindMethod;
  setMethod: (method: FindMethod) => void;
  /** 업로드 화면에서 입력하는 프로젝트 제목. 하이라이트 추출·시나리오 추천의 기준이 된다. */
  projectTitle: string;
  setProjectTitle: (title: string) => void;
  items: ScenarioItem[];
  setItems: (updater: ScenarioItem[] | ((current: ScenarioItem[]) => ScenarioItem[])) => void;
}

const UploadSessionContext = createContext<UploadSessionValue | null>(null);

export function UploadSessionProvider({ children }: { children: ReactNode }) {
  const [uploadedVideo, setUploadedVideoState] = useState<UploadedVideo | null>(null);
  const [method, setMethod] = useState<FindMethod>('manual');
  const [items, setItems] = useState<ScenarioItem[]>([]);
  const [projectTitle, setProjectTitle] = useState('');

  const setUploadedVideo = useCallback((next: UploadedVideo | null) => {
    setUploadedVideoState((previous) => {
      if (previous && previous.objectUrl !== next?.objectUrl) URL.revokeObjectURL(previous.objectUrl);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ uploadedVideo, setUploadedVideo, method, setMethod, items, setItems, projectTitle, setProjectTitle }),
    [uploadedVideo, setUploadedVideo, method, items, projectTitle],
  );

  return <UploadSessionContext.Provider value={value}>{children}</UploadSessionContext.Provider>;
}

export function useUploadSession(): UploadSessionValue {
  const context = useContext(UploadSessionContext);
  if (!context) throw new Error('useUploadSession은 UploadSessionProvider 안에서만 쓸 수 있어요.');
  return context;
}
