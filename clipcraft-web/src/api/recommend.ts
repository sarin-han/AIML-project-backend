import { uploadVideoInChunks } from '@/api/uploads';
import { getApiUrl, requestJson } from '@/api/client';

const DEFAULT_RECOMMEND_API_URL = '/recommend';

/** 한 번에 추천받는 장면 개수. 서버도 항상 이 개수로 응답한다. */
export const RECOMMEND_SCENE_COUNT = 8;

/** 추천받은 장면 하나. start/end는 그 장면이 영상의 어디인지(초)이다. */
export interface RecommendedScene {
  text: string;
  start: number;
  end: number;
}

export interface RecommendResponse {
  scenes: RecommendedScene[];
}

function getRecommendEndpoint(): string {
  return getApiUrl(import.meta.env.VITE_RECOMMEND_API_URL, DEFAULT_RECOMMEND_API_URL);
}

/**
 * 영상을 보고 찾아볼 만한 장면을 추천받는다. 추천만 하고 검색은 시작하지 않는다.
 * 백엔드에는 영상 ID 개념이 아직 없어서 분석 요청과 같이 영상 파일을 그대로 올린다.
 */
export async function recommendScenes(file: File, projectName?: string): Promise<RecommendedScene[]> {
  const formData = new FormData();
  formData.append('upload_id', await uploadVideoInChunks(file));
  if (projectName?.trim()) formData.append('project_name', projectName.trim());

  const response = await requestJson<RecommendResponse>(getRecommendEndpoint(), {
    method: 'POST',
    body: formData,
  });

  return (response.scenes ?? [])
    .map((scene) => ({ ...scene, text: scene.text.trim() }))
    .filter((scene) => scene.text && Number.isFinite(scene.start) && Number.isFinite(scene.end) && scene.end > scene.start)
    .slice(0, RECOMMEND_SCENE_COUNT);
}
