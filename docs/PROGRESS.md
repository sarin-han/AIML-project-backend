# ClipCraft 진행 기록

> 기준일: 2026-10-29
> 세부 구현보다 "무엇을 만들었고, 어떻게 돌리고, 무엇이 남았는지"를 정리한 문서입니다. API 계약은 [API_SPEC.md](API_SPEC.md)를 봅니다.

## 1. 이번에 만든 것

### 자동 자막
| 기능 | 내용 |
|---|---|
| 말소리 인식 | GPU 서버에서 `faster-whisper large-v3`(float16, GPU)로 음성을 자막 구간으로 변환. 언어는 자동 감지 / 한국어 / 영어 선택 |
| 한국어 번역 | 영어 등 한국어가 아닌 자막을 OpenAI(`gpt-4o-mini`)로 번역. 원문은 `original`에 보관 |
| 두 언어 표시 | 원문(위, 회색) + 번역(아래)을 두 줄로 표시 |
| 시나리오대로 만들기 | 말소리가 없는 영상용. 분석에서 얻은 시나리오 문장으로 짧은 자막 문구 생성(톤: 설명형 / 감성형 / 유머형) |
| 자막 수정 | 문장 수정·삭제, 파형 아래 자막 줄에서 길이 조절·이동, 영상 화면에서 끌어서 위치 이동(자막별) |
| 자막 스타일 | 폰트 11종, 크기(숫자), 위치(상단/중앙/하단), 색(기본색 + 팔레트), 배경 박스 |
| 내보내기 | "MP4로 내보내기"에 자막 포함 옵션. 구간 순서·배속에 맞춰 시간을 다시 계산하고 영상에 입힘. SRT 파일만 따로 받기도 가능 |

### 동작 흐름
```text
업로드 → 분석(CLIP + VideoLLaVA) → 편집 화면
  → 말소리로 자막 만들기:  프론트 → 백엔드 /transcribe → GPU 서버 /transcribe/jobs(Whisper)
                            → (필요 시) 백엔드 /translate (OpenAI)
  → 시나리오대로 만들기:    프론트 → 백엔드 /suggest-subtitles (OpenAI)
  → 내보내기:               프론트 → 백엔드 /export → GPU 서버 /export (ffmpeg로 구간 이어붙이기 + 자막 입히기)
```

### 추가·변경된 API
| 위치 | 경로 | 설명 |
|---|---|---|
| GPU 서버 | `POST /transcribe/jobs`, `GET /transcribe/jobs/{id}` | Whisper 작업 시작/조회 (job 방식) |
| GPU 서버 | `POST /export` | 요청에 `subtitle_cues`, `subtitle_style` 추가. ASS 자막 파일을 만들어 ffmpeg로 입힘 |
| 백엔드 | `/transcribe/jobs`, `/transcribe/jobs/{id}` | GPU 서버로 중계 |
| 백엔드 | `POST /translate` | 자막 한국어 번역 (OpenAI) |
| 백엔드 | `POST /suggest-subtitles` | 시나리오 기반 자막 문구 생성 (OpenAI) |

OpenAI 키는 로컬 백엔드(`OPENAI_API_KEY`)에서만 사용하고 GPU 서버로는 보내지 않습니다.

## 2. 실행 방법 (현재 환경)

- **프론트엔드·백엔드**: 로컬에서 직접 실행(맥에 Docker 없음). Docker가 있으면 README의 `docker compose up -d --build`를 사용.
  - 백엔드는 `OPENAI_API_KEY`를 환경 변수로 받아야 번역·시나리오 자막이 동작합니다. `docker-compose.yml`에 전달 설정을 추가했습니다.
- **GPU 서버**(컨테이너 안, Python 3.10 필요):
  ```bash
  cd ~/ClipCraft/gpu-server
  PYTHONPATH=/shareHost/jiyes/packages /usr/bin/python3 -m uvicorn server:app --host 0.0.0.0 --port 8001
  ```
  기본 `python3`(conda 3.9)로 실행하면 `TypeAlias` 임포트 오류가 납니다. 컨테이너가 꺼져 있으면 먼저 시작해야 하고, 재시작하면 서버를 다시 띄워야 합니다.
- **로컬 ↔ GPU 서버 연결**: GPU 컨테이너의 8001 포트는 외부에 열려 있지 않아서 SSH 포트 포워딩(`localhost:8001`)으로 연결합니다.
- **설치 위치(GPU 컨테이너)**
  - Whisper 패키지: `/shareHost/jiyes/packages` (`faster-whisper`, `ctranslate2`, `onnxruntime`)
  - Whisper 모델: `/shareHost/jiye_model` (`Systran/faster-whisper-large-v3`)
  - 자막 폰트: `/shareHost/jiyes/fonts` (나눔고딕, 고딕 A1, IBM Plex Sans KR, 나눔명조, 블랙한산스, 도현, 주아, 고운돋움, 나눔손글씨 펜 — 모두 무료 오픈 라이선스)
- 자막 폰트 id ↔ 폰트 이름은 GPU 서버 `SUBTITLE_FONTS`와 프론트 `SUBTITLE_FONT_OPTIONS`가 같아야 합니다.

측정값(TTS 샘플 기준): 7분 45초 한국어 음성의 Whisper 인식 약 14초.

## 3. ClipCraft-AI(ReVisionLLM + 오디오) 연동 검토

`ClipCraft-AI`를 기존 CLIP 검색 + VideoLLaVA 검증 대체로 쓸 수 있는지 검토했습니다(코드는 `.gitignore`로 제외, 별도 클론).

- 영상 + 문장 → 시작/끝 구간을 직접 예측하는 모델이라 출력 형태는 기존 분석 결과와 맞습니다. 다중 쿼리·feature 캐시 구조도 우리 흐름에 적합합니다.
- 막힌 점: 저장소에 **가중치가 없음**(R2 체크포인트, 공개 ReVisionLLM, Vicuna-7B, CLIP, CLAP), 패키지 버전이 GPU 서버 환경과 충돌(`torch 2.4.1`, `transformers 4.41.2` 등), 의미 캐시에 PostgreSQL + pgvector 필요.
- 품질 위험: 학습·평가가 Charades-STA(약 30초 실내 영상) 위주라 **긴 영상·요리 영상 성능이 검증되지 않음**, 영어 쿼리 전제, 비상업 연구용 라이선스.
- 다음 단계: 팀원에게 R2 체크포인트와 실행 환경을 받아 같은 샘플로 기존 방식과 비교한 뒤 결정.

## 4. 분석(구간 선택) 점검 결과

증상: 여러 시나리오가 모두 `0초~몇 초` 구간으로 겹쳐 나옴.

- **원인**: GPU 서버 프로세스에 `OPENAI_API_KEY`가 없어서 시나리오가 영어로 변환되지 않고(`[expand] OPENAI_API_KEY is not set`), 한국어 문장이 영어 전용 CLIP(ViT-L/14)에 그대로 들어감.
- **검증**: 같은 영상·같은 모델에서 서로 다른 한국어 시나리오 3개가 거의 같은 구간(0~3초, 75~87초, 229~236초)과 같은 최고점(192초)을 냈고, 영어로 바꾸면 시나리오마다 다른 구간과 더 높은 점수가 나옴.
- **함께 있는 약점**: 점수가 낮아도 항상 상위 3개 구간을 반환(최소 점수 기준 없음), 프레임 샘플링 0.5fps, VideoLLaVA 검증에도 한국어 시나리오를 그대로 전달.
- **해결 방향**: 시나리오를 영어로 변환해서 CLIP과 VideoLLaVA에 넘긴다. 키를 GPU 서버에 두는 방법과, 로컬 백엔드에서 변환해 GPU 서버로 넘기는 방법이 있으며 아직 적용 전.

## 5. 남은 일·알려진 한계

- 분석 쿼리의 영어 변환 적용(위 4번), 낮은 점수 구간 걸러내기.
- 말소리가 없는 영상의 "소리 없음" 안내는 있으나, 영상 내용을 보고 만드는 자막(프레임 기반)은 UI에서 뺐음(백엔드 API는 남아 있음).
- 겹치는 자막은 자동 정리하지 않음. 편집 화면 미리보기에서는 선택한 자막을 우선 표시.
- 번역은 한국어 쪽만 지원.
- 인증·프로젝트 저장 등 [API_SPEC.md](API_SPEC.md)의 미구현 API는 그대로 남아 있음.
