import json
import os

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel


app = FastAPI(title="ClipCraft Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    video: UploadFile = File(...),
    project_name: str = Form(...),
    scenarios: str = Form(...),
):
    files = {
        "video": (
            video.filename or "video.mp4",
            await video.read(),
            video.content_type or "application/octet-stream",
        )
    }
    data = {"project_name": project_name, "scenarios": scenarios}

    async with httpx.AsyncClient(timeout=None) as client:
        response = await client.post(f"{GPU_SERVER_URL}/analyze/jobs", files=files, data=data)

    raise_upstream_error(response)
    return response.json()


@app.get("/analyze/jobs/{job_id}")
async def get_analyze_job(job_id: str):
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(f"{GPU_SERVER_URL}/analyze/jobs/{job_id}")

    raise_upstream_error(response)
    return response.json()


@app.post("/analyze")
async def analyze(request: Request):
    async with httpx.AsyncClient(timeout=None) as client:
        response = await client.post(
            f"{GPU_SERVER_URL}/analyze",
            content=await request.body(),
            headers={"content-type": request.headers.get("content-type", "application/json")},
        )

    raise_upstream_error(response)
    return response.json()


@app.post("/transcribe/jobs")
async def start_transcribe_job(request: Request):
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{GPU_SERVER_URL}/transcribe/jobs",
            content=await request.body(),
            headers={"content-type": request.headers.get("content-type", "application/json")},
        )

    raise_upstream_error(response)
    return response.json()


@app.get("/transcribe/jobs/{job_id}")
async def get_transcribe_job(job_id: str):
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(f"{GPU_SERVER_URL}/transcribe/jobs/{job_id}")

    raise_upstream_error(response)
    return response.json()


class TranslateRequest(BaseModel):
    texts: list[str]


async def translate_batch(client: httpx.AsyncClient, texts: list[str]) -> list[str]:
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
                        "You translate video subtitles into natural, concise Korean. "
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


@app.post("/translate")
async def translate_to_korean(request: TranslateRequest):
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY가 설정되지 않아 번역할 수 없습니다.")

    results: list[str] = []
    async with httpx.AsyncClient(timeout=60.0) as client:
        for start in range(0, len(request.texts), TRANSLATE_BATCH_SIZE):
            results.extend(await translate_batch(client, request.texts[start:start + TRANSLATE_BATCH_SIZE]))
    return {"translations": results}


SUGGEST_BATCH_SIZE = 5
SUGGEST_MAX_ITEMS = 30
SUGGEST_MAX_FRAMES = 3
SUGGEST_MAX_FRAME_CHARS = 700_000
SUGGEST_TONES = {
    "descriptive": "차분하고 설명적인 톤. 장면에서 무슨 일이 일어나는지 간결하게 설명한다.",
    "emotional": "감성적인 톤. 장면의 분위기와 감정을 짧고 시적으로 표현한다.",
    "funny": "유머러스한 톤. 가볍고 재치 있게, 과하지 않게 표현한다.",
}


SUGGEST_BASES = {"scenario", "video"}


class SuggestItem(BaseModel):
    id: int
    scenario: str = ""
    title: str | None = None
    duration: float = 0
    frames: list[str] = []


class SuggestRequest(BaseModel):
    tone: str = "descriptive"
    # scenario: 시나리오 문장만 근거로 / video: 영상 프레임만 근거로
    basis: str = "scenario"
    items: list[SuggestItem]


async def suggest_batch(client: httpx.AsyncClient, tone_hint: str, items: list[SuggestItem], basis: str) -> dict[int, str]:
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
        grounding = "클립의 시나리오 문장만 근거로 쓴다. 시나리오를 그대로 베끼지 말고 자막다운 문구로 바꾼다. 문장에 없는 사실은 지어내지 않는다. "

    response = await client.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
        json={
            "model": TRANSLATE_MODEL,
            "temperature": 0.7,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "너는 숏폼 영상의 한국어 자막 문구를 쓰는 작가다. 클립마다 자막을 정확히 하나 쓴다. "
                        "각 자막은 공백 포함 20자 이내, 필요하면 \\n으로 두 줄(한 줄 14자 이내)로 나눈다. "
                        f"{grounding}"
                        f"톤: {tone_hint} "
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


@app.post("/suggest-subtitles")
async def suggest_subtitles(request: SuggestRequest):
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY가 설정되지 않아 자막을 추천할 수 없습니다.")
    if request.tone not in SUGGEST_TONES:
        raise HTTPException(status_code=400, detail=f"지원하지 않는 톤입니다: {request.tone}")
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
            suggestions.update(await suggest_batch(client, SUGGEST_TONES[request.tone], usable[start:start + SUGGEST_BATCH_SIZE], request.basis))

    return {"suggestions": [{"id": item.id, "text": suggestions[item.id]} for item in usable if suggestions.get(item.id)]}


@app.post("/export")
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
