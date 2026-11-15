import { requestJson } from '@/api/client';

const SCENARIO_API_URL = '/analyze/scenarios';

export interface FoundScenario {
  scenario: string;
  start: number;
  end: number;
}

/**
 * 이미 분석한 영상에서 장면을 더 찾는다(편집 화면의 "시나리오 추가").
 * 영상은 다시 올리지 않고 서버에 있는 분석용 영상(videoPath)을 쓴다.
 * 결과는 요청한 순서와 같고, 영상에서 찾지 못한 장면은 null이다.
 */
export async function findScenarios(videoPath: string, scenarios: string[]): Promise<(FoundScenario | null)[]> {
  const { results } = await requestJson<{ results: (FoundScenario | null)[] }>(SCENARIO_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_path: videoPath, scenarios }),
  });

  return results;
}
