# 하이라이트 추출 · 시나리오 추천 API (프론트가 기대하는 계약)

프론트(`clipcraft-web`)는 아래 세 엔드포인트를 호출합니다. 백엔드(`backend/server.py`)가 GPU 서버(`gpu-server/server.py`)로 넘기고, GPU 서버는 ReVision 서비스(`gpu-server/revision/revision_server.py`, 포트 8002)의 `/highlights`·`/recommend`를 부릅니다. 계산은 ClipCraft-AI의 `revisionllm.editing`(UniVTG + CLAP 오디오 점수)이 하고, 구간 이름과 추천 장면 이름은 OpenAI(gpt-4o-mini)가 영상 프레임을 보고 붙입니다.
개발 서버(`vite.config.ts`)와 운영 nginx(`clipcraft-web/nginx.prod.conf`)는 `/recommend`, `/highlights`를 백엔드로 넘기도록 이미 설정했습니다.

핸드오프 브리프의 제안과 다른 점은 두 가지입니다.

| 브리프 제안 | 구현 | 이유 |
|---|---|---|
| `{ videoId }`로 영상을 가리킨다 | 영상 파일을 multipart로 같이 보낸다 | 백엔드에 영상 ID 개념이 없고, `/analyze/jobs`도 파일을 그대로 올린다 |
| `POST /highlights`가 결과를 바로 돌려준다 | 작업을 시작하고 폴링한다 (`/highlights/jobs`) | 전체 길이 분석은 오래 걸리고, 분석 중 화면이 진행률·단계를 보여 준다 |

## 1. 장면 추천 — `POST /recommend`

요청: `multipart/form-data`, 필드 `video`(파일), `project_name`(선택, 영상 제목으로 쓴다)

응답:

```json
{ "scenes": [{ "text": "재료 손질", "start": 0.0, "end": 12.0 }, { "text": "물을 붓고 끓이기", "start": 12.0, "end": 24.0 }] }
```

- `start`/`end`는 그 장면이 영상의 어디인지(초)입니다. 추천은 영상 구간에서 나온 것이라 시간을 이미 알고 있습니다.
- 프론트는 이 시간을 장면과 함께 들고 있다가, 분석을 시작할 때 `known_segments`로 돌려 보냅니다(아래). 사용자가 문구를 고치면 시간을 버립니다.

- 영상 길이에 따라 **최대 8개**입니다(짧은 영상은 적을 수 있어요). 프론트는 8개까지만 씁니다. 한국어 장면 이름이어야 합니다.
- 추천만 하고 검색은 시작하지 않습니다. 응답이 오래 걸릴 수 있어 프론트는 로딩 표시를 합니다.
- 실패하면 4xx/5xx. 프론트는 "장면을 추천받지 못했어요" 안내를 띄웁니다.

## 2. 하이라이트 추출 시작 — `POST /highlights/jobs`

요청: `multipart/form-data`, 필드 `video`(파일), `project_name`(문자열)

응답: `{ "status": "queued", "job_id": "..." }`

## 3. 하이라이트 작업 상태 — `GET /highlights/jobs/{job_id}`

`/analyze/jobs/{id}`와 같은 모양에 `found`, `result`가 더해집니다.

```json
{
  "status": "running | success | error",
  "progress": 0,
  "step_id": 0,
  "step_label": "프레임 디코딩",
  "message": "전체 구간 디코딩 중...",
  "logs": ["✓  영상 파일 수신 중"],
  "project": "프로젝트 이름",
  "video_path": "/tmp/....mp4",
  "error": null,
  "found": [{ "id": 1, "start": 8, "end": 20, "label": "양념 재료 그릇에 넣기" }],
  "result": {
    "duration": 298,
    "highlights": [
      { "id": 1, "start": 8, "end": 20, "label": "양념 재료 그릇에 넣기", "thumbnail": "https://..." }
    ],
    "audio": { "barCount": 88, "amplitudes": [0.12, 0.8, "..."] }
  }
}
```

- `step_id`는 0~5(프론트의 `HIGHLIGHT_STEPS`와 같은 6단계)입니다.
- `found`는 **선택**입니다. 있으면 분석 중 화면의 스캔 줄에 구간이 나타납니다.
- `result`는 `status`가 `success`일 때만 채웁니다. `success`인데 `result`가 없으면 프론트는 실패로 처리합니다.
- `start`/`end`/`duration`은 **초**, `amplitudes`는 **0~1** 범위입니다. `barCount`는 `amplitudes.length`와 같아야 합니다.
- `thumbnail`은 **선택**입니다. 없으면 프론트가 올린 영상에서 구간 가운데 프레임을 직접 캡처합니다.
- `video_path`는 편집 화면의 내보내기가 GPU 서버의 영상 경로로 씁니다(`/analyze/jobs`와 동일).
- 구간 `id`는 한 작업 안에서 유일해야 합니다. 프론트는 시작 시각 순으로 정렬해 보여 줍니다.

## 4. 추천 구간을 그대로 쓰는 분석 — `POST /analyze/jobs`의 `known_segments`

`/analyze/jobs`에 선택 필드 `known_segments`(JSON 문자열)를 더 보낼 수 있습니다. `scenarios`와 같은 순서·길이의 배열이고,
이미 구간을 아는 장면은 `{"start": 12.0, "end": 24.0}`, 찾아야 하는 장면은 `null`입니다.

```json
["추상적 패턴의 형성", "바다 위를 나는 새"]   // scenarios
[{ "start": 12.0, "end": 24.0 }, null]          // known_segments
```

- 구간을 아는 장면은 ReVision으로 검색하지 않고 그 시간을 그대로 결과에 넣습니다(영어 번역도 하지 않습니다).
- 나머지만 검색합니다. 모든 장면의 구간을 알면 ReVision이 꺼져 있어도 분석이 끝납니다.
- 결과 순서는 `scenarios` 순서입니다.

## 5. 편집 화면의 시나리오 추가 — `POST /analyze/scenarios`

이미 분석한 영상에서 장면을 더 찾습니다. 영상은 다시 올리지 않고, 분석 작업이 돌려준 `video_path`를 씁니다.

요청(JSON): `{ "video_path": "/tmp/....mp4", "scenarios": ["그릇에 빨간 소스를 붓는 사람"] }`

응답: `{ "results": [{ "scenario": "...", "start": 30.0, "end": 58.1 }] }` — 영상에서 찾지 못한 장면은 `null`입니다.

- 구간만 돌려주고 오디오 파형은 만들지 않습니다.
- `video_path`는 분석 때 올라온 임시 폴더의 파일만 허용합니다(그 밖의 경로는 404).
