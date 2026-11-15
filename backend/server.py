import json
import os

import httpx
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from app import models, security, uploads
from app.database import get_db, init_db
from app.envelope import register_error_handlers
from app.routers import auth as auth_router
from app.routers import projects as projects_router
from app.routers import uploads as uploads_router
from app.routers.projects import ensure_project_gpu_video
from app.projects_storage import save_project_video
from sqlalchemy.orm import Session
from edit_agent import make_graph, run_edit


app = FastAPI(title="ClipCraft Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 회원가입·로그인·프로젝트(/api/v1). 영상 분석 등 기존 경로는 그대로 둔다.
init_db()
register_error_handlers(app)
app.include_router(auth_router.router)
app.include_router(projects_router.router)
app.include_router(uploads_router.router)

GPU_SERVER_URL = os.environ.get("GPU_SERVER_URL", "http://host.docker.internal:8001").rstrip("/")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
TRANSLATE_MODEL = os.environ.get("TRANSLATE_MODEL", "gpt-4o-mini")
TRANSLATE_BATCH_SIZE = 40


def raise_upstream_error(response: httpx.Response) -> None:
    if response.is_success:
        return

    try:
        payload = response.json()
        detail = payload.get("detail") or payload.get("message") or payload.get("error")
    except ValueError:
        detail = response.text

    raise HTTPException(
        status_code=response.status_code,
        detail=detail or "GPU server request failed",
    )


@app.get("/health")
async def health():
    return {"status": "ok", "gpu_server_url": GPU_SERVER_URL}


@app.post("/analyze/jobs")
async def start_analyze_job(
    video: UploadFile | None = File(None),
    upload_id: str | None = Form(None),
    project_name: str = Form(...),
    scenarios: str = Form(...),
    known_segments: str | None = Form(None),
    project_id: str | None = Form(None),
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    upload_key, source = await incoming_video(video, upload_id, current_user)
    try:
        return await run_analyze_job(db, current_user, source, project_id, project_name, scenarios, known_segments)
    finally:
        uploads.discard_upload(upload_key)


async def run_analyze_job(db: Session, current_user: models.User, source: uploads.UploadedVideo, project_id: str | None, project_name: str, scenarios: str, known_segments: str | None) -> dict:
    store_project_video(db, current_user, project_id, source)
    data = {"project_name": project_name, "scenarios": scenarios}

    # GPU 서버의 ReVision은 영어 질문 기준이다. OpenAI 키는 이 백엔드에만 있으므로 여기서 번역해서 함께 보낸다.
    try:
        scenario_list = json.loads(scenarios)
    except ValueError:
        scenario_list = []
    # 추천으로 받은 장면은 이미 구간 시간(known_segments)을 알고 있어서 다시 찾지 않는다. 번역도 찾을 장면만 한다.
    known: list = []
    if known_segments:
        try:
            parsed = json.loads(known_segments)
            known = parsed if isinstance(parsed, list) else []
        except ValueError:
            known = []
        data["known_segments"] = json.dumps(known, ensure_ascii=False)

    if isinstance(scenario_list, list):
        to_find = [index for index in range(len(scenario_list)) if index >= len(known) or not known[index]]
        translated = await scenarios_to_english([scenario_list[index] for index in to_find]) if to_find else []
        if translated and len(translated) == len(to_find):
            queries_en = list(scenario_list)
            for index, query in zip(to_find, translated):
                queries_en[index] = query
            data["queries_en"] = json.dumps(queries_en, ensure_ascii=False)

    response = await forward_video("/analyze/jobs", source, data)
    raise_upstream_error(response)
    return response.json()


@app.get("/analyze/jobs/{job_id}", dependencies=[Depends(security.get_current_user)])
async def get_analyze_job(job_id: str):
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(f"{GPU_SERVER_URL}/analyze/jobs/{job_id}")

    raise_upstream_error(response)
    return response.json()


async def project_title_en(project_name: str | None) -> str | None:
    """하이라이트 점수의 기준이 되는 영상 제목. 모델이 영어를 기대해서 프로젝트 이름을 영어로 바꿔 보낸다."""
    name = (project_name or "").strip()
    if not name:
        return None
    translated = await scenarios_to_english([name])
    return translated[0] if translated else None


async def incoming_video(video: UploadFile | None, upload_id: str | None, user: models.User) -> tuple[str, uploads.UploadedVideo]:
    """분석할 영상을 받는다. 조각 업로드(upload_id)를 쓰거나, 기존처럼 multipart로 바로 받는다."""
    if upload_id:
        return upload_id, uploads.get_upload(user.id, upload_id)
    if video is None:
        raise HTTPException(status_code=422, detail="영상 또는 upload_id가 필요해요.")
    temp_id = uploads.new_temp_upload(user.id, video.filename, video.content_type, await video.read())
    return temp_id, uploads.get_upload(user.id, temp_id)


def store_project_video(db: Session, user: models.User, project_id: str | None, source: uploads.UploadedVideo) -> None:
    """분석하려고 올린 영상을 프로젝트에 저장해 두어, 나중에 프로젝트를 열 때 다시 올리지 않게 한다."""
    if not project_id:
        return
    project = db.get(models.Project, project_id)
    if not project or project.user_id != user.id or project.deleted_at is not None:
        raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없어요.")
    save_project_video(db, project, source.filename, source.content_type, source.path)


async def forward_video(path: str, source: uploads.UploadedVideo, data: dict) -> httpx.Response:
    with source.path.open("rb") as handle:
        files = {"video": (source.filename or "video.mp4", handle, source.content_type or "application/octet-stream")}
        async with httpx.AsyncClient(timeout=None) as client:
            return await client.post(f"{GPU_SERVER_URL}{path}", files=files, data=data)


@app.post("/recommend")
async def recommend_scenes(
    video: UploadFile | None = File(None),
    upload_id: str | None = Form(None),
    project_name: str | None = Form(None),
    current_user: models.User = Depends(security.get_current_user),
):
    """영상을 보고 찾아볼 만한 장면을 추천한다. 검색은 하지 않는다."""
    data = {}
    if title_en := await project_title_en(project_name):
        data["title_en"] = title_en

    upload_key, source = await incoming_video(video, upload_id, current_user)
    try:
        response = await forward_video("/recommend", source, data)
    finally:
        uploads.discard_upload(upload_key)
    raise_upstream_error(response)
    return response.json()


@app.post("/highlights/jobs")
async def start_highlight_job(
    video: UploadFile | None = File(None),
    upload_id: str | None = Form(None),
    project_name: str = Form(...),
    project_id: str | None = Form(None),
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """시나리오 없이 영상 전체 길이에서 하이라이트 구간을 찾는 작업을 시작한다."""
    data = {"project_name": project_name}
    if title_en := await project_title_en(project_name):
        data["title_en"] = title_en

    upload_key, source = await incoming_video(video, upload_id, current_user)
    try:
        store_project_video(db, current_user, project_id, source)
        response = await forward_video("/highlights/jobs", source, data)
    finally:
        uploads.discard_upload(upload_key)
    raise_upstream_error(response)
    return response.json()


class FromProjectBody(BaseModel):
    project_id: str


async def start_job_from_project(kind: str, body: FromProjectBody, user: models.User, db: Session) -> dict:
    """저장된 프로젝트 영상으로 하이라이트 추출·시나리오 추천을 시작한다. 영상을 브라우저에서 다시 올리지 않는다."""
    project = db.get(models.Project, body.project_id)
    if not project or project.user_id != user.id or project.deleted_at is not None:
        raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없어요.")

    video_path = await ensure_project_gpu_video(db, project.id)
    if not video_path:
        raise HTTPException(status_code=404, detail="이 프로젝트에 저장된 영상이 없어요. 영상을 다시 올려 주세요.")

    payload = {"video_path": video_path, "project_name": project.title}
    if title_en := await project_title_en(project.title):
        payload["title_en"] = title_en

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(f"{GPU_SERVER_URL}/{kind}/jobs/from-path", json=payload)

    raise_upstream_error(response)
    return {**response.json(), "video_path": video_path}


@app.post("/scenario/jobs")
async def start_scenario_job(
    video: UploadFile | None = File(None),
    upload_id: str | None = Form(None),
    project_name: str = Form(...),
    project_id: str | None = Form(None),
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """업로드 화면에서 올린 영상으로 시나리오 추천을 시작한다. 영상은 프로젝트에도 저장한다."""
    data = {"project_name": project_name}
    if title_en := await project_title_en(project_name):
        data["title_en"] = title_en

    upload_key, source = await incoming_video(video, upload_id, current_user)
    try:
        store_project_video(db, current_user, project_id, source)
        response = await forward_video("/scenario/jobs", source, data)
    finally:
        uploads.discard_upload(upload_key)
    raise_upstream_error(response)
    return response.json()


@app.post("/highlights/jobs/from-project")
async def start_highlight_job_from_project(body: FromProjectBody, current_user: models.User = Depends(security.get_current_user), db: Session = Depends(get_db)):
    return await start_job_from_project("highlights", body, current_user, db)


@app.post("/scenario/jobs/from-project")
async def start_scenario_job_from_project(body: FromProjectBody, current_user: models.User = Depends(security.get_current_user), db: Session = Depends(get_db)):
    return await start_job_from_project("scenario", body, current_user, db)


@app.get("/scenario/jobs/{job_id}", dependencies=[Depends(security.get_current_user)])
async def get_scenario_job(job_id: str):
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(f"{GPU_SERVER_URL}/scenario/jobs/{job_id}")

    raise_upstream_error(response)
    return response.json()


@app.get("/highlights/jobs/{job_id}", dependencies=[Depends(security.get_current_user)])
async def get_highlight_job(job_id: str):
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(f"{GPU_SERVER_URL}/highlights/jobs/{job_id}")

    raise_upstream_error(response)
    return response.json()


class ScenarioFindBody(BaseModel):
    video_path: str
    scenarios: list[str]


@app.post("/analyze/scenarios", dependencies=[Depends(security.get_current_user)])
async def find_scenarios(body: ScenarioFindBody):
    """편집 화면에서 시나리오를 더 추가할 때: 이미 올라간 영상에서 새 장면만 찾는다."""
    data: dict = {"video_path": body.video_path, "scenarios": body.scenarios}
    if queries_en := await scenarios_to_english(body.scenarios):
        data["queries_en"] = queries_en

    async with httpx.AsyncClient(timeout=None) as client:
        response = await client.post(f"{GPU_SERVER_URL}/analyze/scenarios", json=data)

    raise_upstream_error(response)
    return response.json()


@app.post("/analyze", dependencies=[Depends(security.get_current_user)])
async def analyze(request: Request):
    async with httpx.AsyncClient(timeout=None) as client:
        response = await client.post(
            f"{GPU_SERVER_URL}/analyze",
            content=await request.body(),
            headers={"content-type": request.headers.get("content-type", "application/json")},
        )

    raise_upstream_error(response)
    return response.json()


@app.post("/transcribe/jobs", dependencies=[Depends(security.get_current_user)])
async def start_transcribe_job(request: Request):
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{GPU_SERVER_URL}/transcribe/jobs",
            content=await request.body(),
            headers={"content-type": request.headers.get("content-type", "application/json")},
        )

    raise_upstream_error(response)
    return response.json()


@app.get("/transcribe/jobs/{job_id}", dependencies=[Depends(security.get_current_user)])
async def get_transcribe_job(job_id: str):
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(f"{GPU_SERVER_URL}/transcribe/jobs/{job_id}")

    raise_upstream_error(response)
    return response.json()


class TranslateRequest(BaseModel):
    texts: list[str]
    target: str = "ko"


TRANSLATE_LANGUAGES = {
    "ko": "Korean",
    "en": "English",
    "ja": "Japanese",
    "zh": "Simplified Chinese",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "vi": "Vietnamese",
    "th": "Thai",
}


async def translate_batch(client: httpx.AsyncClient, texts: list[str], target: str) -> list[str]:
    numbered = "\n".join(f"{index + 1}. {text}" for index, text in enumerate(texts))
    response = await client.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
        json={
            "model": TRANSLATE_MODEL,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": (
                        f"You translate video subtitles into natural, concise {TRANSLATE_LANGUAGES[target]}. "
                        "Keep the meaning and tone, keep proper nouns readable, and do not merge or split lines. "
                        'Reply with JSON only: {"translations": ["...", ...]} with exactly one entry per input line, in order.'
                    ),
                },
                {"role": "user", "content": numbered},
            ],
        },
    )
    if not response.is_success:
        raise HTTPException(status_code=502, detail=f"번역 API 요청에 실패했습니다 ({response.status_code}).")

    try:
        translations = json.loads(response.json()["choices"][0]["message"]["content"])["translations"]
    except (KeyError, IndexError, ValueError, TypeError):
        raise HTTPException(status_code=502, detail="번역 응답을 해석하지 못했습니다.")

    if not isinstance(translations, list) or len(translations) != len(texts):
        raise HTTPException(status_code=502, detail="번역 결과의 줄 수가 원문과 다릅니다.")
    return [str(item) for item in translations]


async def scenarios_to_english(scenarios: list[str]) -> list[str] | None:
    """시나리오 문장을 영상 탐색용 짧은 영어 문장으로 바꾼다. 실패하면 None(GPU 서버가 원문으로 대신 탐색)."""
    if not OPENAI_API_KEY or not scenarios or not all(isinstance(item, str) for item in scenarios):
        return None

    numbered = "\n".join(f"{index + 1}. {text}" for index, text in enumerate(scenarios))
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                json={
                    "model": TRANSLATE_MODEL,
                    "temperature": 0,
                    "response_format": {"type": "json_object"},
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You turn scene descriptions into short English queries for a video moment-retrieval model. "
                                "Write one plain sentence per input that describes the visible action, in the style of "
                                '"a person pours sauce into a bowl". Present tense, concrete, no quotes, no extra details, '
                                "keep the original meaning. If an input is already English, keep it simple. "
                                'Reply with JSON only: {"queries": ["...", ...]} with exactly one entry per input line, in order.'
                            ),
                        },
                        {"role": "user", "content": numbered},
                    ],
                },
            )
        response.raise_for_status()
        queries = json.loads(response.json()["choices"][0]["message"]["content"])["queries"]
    except (httpx.HTTPError, KeyError, IndexError, ValueError, TypeError) as error:
        print(f"[analyze] 시나리오 영어 변환 실패, 원문으로 탐색합니다: {error}")
        return None

    if not isinstance(queries, list) or len(queries) != len(scenarios) or not all(isinstance(q, str) and q.strip() for q in queries):
        print("[analyze] 시나리오 영어 변환 결과의 줄 수가 맞지 않아 원문으로 탐색합니다.")
        return None
    return [q.strip() for q in queries]


@app.post("/translate", dependencies=[Depends(security.get_current_user)])
async def translate_to_korean(request: TranslateRequest):
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY가 설정되지 않아 번역할 수 없습니다.")
    if request.target not in TRANSLATE_LANGUAGES:
        raise HTTPException(status_code=400, detail=f"지원하지 않는 번역 언어입니다: {request.target}")

    results: list[str] = []
    async with httpx.AsyncClient(timeout=60.0) as client:
        for start in range(0, len(request.texts), TRANSLATE_BATCH_SIZE):
            results.extend(await translate_batch(client, request.texts[start:start + TRANSLATE_BATCH_SIZE], request.target))
    return {"translations": results}


SUGGEST_BATCH_SIZE = 5
SUGGEST_MAX_ITEMS = 30
SUGGEST_MAX_FRAMES = 3
SUGGEST_MAX_FRAME_CHARS = 700_000
SUGGEST_BASES = {"scenario", "video"}


class SuggestItem(BaseModel):
    id: int
    scenario: str = ""
    title: str | None = None
    duration: float = 0
    frames: list[str] = []


class SuggestRequest(BaseModel):
    # scenario: 시나리오 문장만 근거로 / video: 영상 프레임만 근거로
    basis: str = "scenario"
    items: list[SuggestItem]


async def suggest_batch(client: httpx.AsyncClient, items: list[SuggestItem], basis: str) -> dict[int, str]:
    content: list[dict] = []
    for item in items:
        if basis == "video":
            label = f"클립 {item.id}"
            if item.duration:
                label += f" | 길이: {item.duration:.1f}초"
            content.append({"type": "text", "text": label})
            for frame in item.frames[:SUGGEST_MAX_FRAMES]:
                content.append({"type": "image_url", "image_url": {"url": frame, "detail": "low"}})
        else:
            label = f"클립 {item.id} | 시나리오: {item.scenario}"
            if item.title:
                label += f" | 제목: {item.title}"
            if item.duration:
                label += f" | 길이: {item.duration:.1f}초"
            content.append({"type": "text", "text": label})

    if basis == "video":
        grounding = (
            "각 클립의 프레임(시간 순서대로 여러 장)에서 실제로 보이는 인물, 행동, 장소, 분위기만 근거로 쓴다. "
            "프레임에 없는 인물 이름이나 사실은 지어내지 않는다. "
        )
    else:
        grounding = (
            "각 클립의 장면 설명을 자막으로 바꾼다. 장면 설명은 '~하는 장면' 꼴이므로 '장면'이라는 말을 빼고 현재형 평서문(~합니다, ~ㅂ니다)으로 쓴다. "
            "예: '키위를 자르는 장면' -> '키위를 자릅니다.', '여자가 잠에서 깨는 장면' -> '여자가 잠에서 깹니다.', '김치찌개가 끓는 장면' -> '김치찌개가 끓습니다.' "
            "설명에 없는 내용(감정, 분위기, 꾸미는 말, 상황)은 절대 덧붙이지 않고, 설명에 있는 동작·대상·장소는 빠뜨리지 않는다(예: '남자가 문을 열고 들어오는 장면' -> '남자가 문을 열고 들어옵니다.'). "
        )

    response = await client.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
        json={
            "model": TRANSLATE_MODEL,
            "temperature": 0 if basis != "video" else 0.7,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "너는 영상의 한국어 자막 문구를 쓰는 작가다. 클립마다 자막을 정확히 하나 쓴다. "
                        "자막은 한 줄이 기본이다. 공백 포함 14자를 넘을 때만 \\n으로 두 줄로 나누고(전체 28자 이내), 14자 이하면 줄바꿈 없이 쓴다. "
                        f"{grounding}"
                        'JSON으로만 답한다: {"captions": [{"id": 클립번호, "text": "자막"}, ...]}'
                    ),
                },
                {"role": "user", "content": content},
            ],
        },
    )
    if not response.is_success:
        raise HTTPException(status_code=502, detail=f"자막 추천 API 요청에 실패했습니다 ({response.status_code}).")

    try:
        captions = json.loads(response.json()["choices"][0]["message"]["content"])["captions"]
        return {int(entry["id"]): str(entry["text"]).strip() for entry in captions}
    except (KeyError, IndexError, ValueError, TypeError):
        raise HTTPException(status_code=502, detail="자막 추천 응답을 해석하지 못했습니다.")


@app.post("/suggest-subtitles", dependencies=[Depends(security.get_current_user)])
async def suggest_subtitles(request: SuggestRequest):
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY가 설정되지 않아 자막을 추천할 수 없습니다.")
    if request.basis not in SUGGEST_BASES:
        raise HTTPException(status_code=400, detail=f"지원하지 않는 추천 기준입니다: {request.basis}")
    if not request.items or len(request.items) > SUGGEST_MAX_ITEMS:
        raise HTTPException(status_code=400, detail=f"구간은 1~{SUGGEST_MAX_ITEMS}개여야 합니다.")
    for item in request.items:
        for frame in item.frames:
            if not frame.startswith("data:image/jpeg;base64,") or len(frame) > SUGGEST_MAX_FRAME_CHARS:
                raise HTTPException(status_code=400, detail="프레임은 700KB 이하의 JPEG data URL이어야 합니다.")

    # 영상 기준은 프레임이 있는 클립만, 시나리오 기준은 시나리오 문장이 있는 클립만 보낸다.
    usable = [item for item in request.items if (item.frames if request.basis == "video" else item.scenario.strip())]
    if not usable:
        raise HTTPException(status_code=400, detail="추천에 쓸 수 있는 " + ("프레임이" if request.basis == "video" else "시나리오가") + " 없습니다.")

    suggestions: dict[int, str] = {}
    async with httpx.AsyncClient(timeout=90.0) as client:
        for start in range(0, len(usable), SUGGEST_BATCH_SIZE):
            suggestions.update(await suggest_batch(client, usable[start:start + SUGGEST_BATCH_SIZE], request.basis))

    return {"suggestions": [{"id": item.id, "text": suggestions[item.id]} for item in usable if suggestions.get(item.id)]}


@app.post("/export", dependencies=[Depends(security.get_current_user)])
async def export_video(request: Request):
    async with httpx.AsyncClient(timeout=None) as client:
        response = await client.post(
            f"{GPU_SERVER_URL}/export",
            content=await request.body(),
            headers={"content-type": request.headers.get("content-type", "application/json")},
        )

    raise_upstream_error(response)
    headers = {}
    if content_disposition := response.headers.get("content-disposition"):
        headers["content-disposition"] = content_disposition
    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=response.headers.get("content-type", "video/mp4"),
        headers=headers,
    )


@app.post("/export/jobs", dependencies=[Depends(security.get_current_user)])
async def start_export_job(request: Request):
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{GPU_SERVER_URL}/export/jobs",
            content=await request.body(),
            headers={"content-type": request.headers.get("content-type", "application/json")},
        )

    raise_upstream_error(response)
    return response.json()


@app.get("/export/jobs/{job_id}", dependencies=[Depends(security.get_current_user)])
async def get_export_job(job_id: str):
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(f"{GPU_SERVER_URL}/export/jobs/{job_id}")

    raise_upstream_error(response)
    return response.json()


@app.get("/export/jobs/{job_id}/download", dependencies=[Depends(security.get_current_user)])
async def download_export_job(job_id: str):
    # 결과 영상은 크기가 커서 한꺼번에 메모리에 올리지 않고 받는 대로 흘려 보낸다.
    client = httpx.AsyncClient(timeout=None)
    upstream = await client.send(client.build_request("GET", f"{GPU_SERVER_URL}/export/jobs/{job_id}/download"), stream=True)
    if not upstream.is_success:
        await upstream.aread()
        await client.aclose()
        raise_upstream_error(upstream)

    async def stream():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    headers = {}
    if content_disposition := upstream.headers.get("content-disposition"):
        headers["content-disposition"] = content_disposition
    if content_length := upstream.headers.get("content-length"):
        headers["content-length"] = content_length
    return StreamingResponse(stream(), media_type=upstream.headers.get("content-type", "video/mp4"), headers=headers)


class ChatClip(BaseModel):
    id: int
    scenario: str = ""
    title: str | None = None
    start: float
    end: float
    speed: float = 1
    muted: bool = False
    # 이 클립에 붙은 자막 문구(있으면). "자막 위로" 같은 말의 맥락으로 쓴다.
    subtitle: str | None = None


class ChatEditRequest(BaseModel):
    thread_id: str
    message: str
    clips: list[ChatClip]
    video_duration: float = 0
    # 확인 질문에 대한 버튼 응답. 글자로 "응"/"아니"를 보내도 같은 결과다.
    confirm: bool | None = None


_edit_graph = None


@app.post("/chat/edit", dependencies=[Depends(security.get_current_user)])
async def chat_edit(request: ChatEditRequest):
    global _edit_graph
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY가 설정되지 않아 채팅 편집을 쓸 수 없습니다.")
    if not request.message.strip() and request.confirm is None:
        raise HTTPException(status_code=400, detail="message가 비어 있습니다.")
    if _edit_graph is None:
        _edit_graph = make_graph({"api_key": OPENAI_API_KEY, "model": os.environ.get("CHAT_EDIT_MODEL", TRANSLATE_MODEL)})
    return await run_edit(
        _edit_graph,
        request.thread_id,
        request.message,
        [clip.model_dump() for clip in request.clips],
        request.video_duration,
        request.confirm,
    )


STT_MODEL = os.environ.get("STT_MODEL", "whisper-1")
STT_MAX_BYTES = 10 * 1024 * 1024


@app.post("/chat/transcribe", dependencies=[Depends(security.get_current_user)])
async def chat_transcribe(audio: UploadFile = File(...), language: str = Form("ko")):
    """채팅 편집용 음성 -> 글자. 브라우저 녹음(Chrome webm, Safari mp4)을 그대로 Whisper에 보낸다."""
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY가 설정되지 않아 음성 인식을 쓸 수 없습니다.")
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="녹음된 소리가 없습니다.")
    if len(data) > STT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="녹음이 너무 깁니다. 짧게 나눠서 말해 주세요.")

    content_type = (audio.content_type or "").split(";")[0] or "audio/webm"
    extension = "m4a" if "mp4" in content_type or "m4a" in content_type or "aac" in content_type else "ogg" if "ogg" in content_type else "wav" if "wav" in content_type else "webm"
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            # 편집 용어를 미리 알려 주면 "클립 2"를 "클립 이에"로 듣는 식의 오인식이 줄어든다
            data={"model": STT_MODEL, "language": language, "temperature": "0", "prompt": "영상 편집 명령. 클립 1, 클립 2, 클립 3, 자막, 배속, 음소거, 삭제, 장면, 맨 뒤로"},
            files={"file": (f"voice.{extension}", data, content_type)},
        )
    if not response.is_success:
        print(f"[chat-transcribe] {response.status_code} {content_type} {len(data)}B: {response.text[:300]}")
        raise HTTPException(status_code=502, detail=f"음성 인식 요청에 실패했습니다 ({response.status_code}).")
    return {"text": str(response.json().get("text", "")).strip()}
