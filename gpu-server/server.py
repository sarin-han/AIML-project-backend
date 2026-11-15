import os
import re
import shutil

import sys
sys.path.insert(0, "/shareHost/jiyes/packages")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
 
import threading
import time
import uuid
import json
import tempfile
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
import shutil
from pydantic import BaseModel
from typing import List, Optional
from fastapi.middleware.cors import CORSMiddleware

# GPU 서비스 루트 경로를 시스템 경로에 추가합니다.
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = current_dir
if project_root not in sys.path:
    sys.path.insert(0, project_root)

app = FastAPI()

class ReVisionUnavailableError(RuntimeError):
    """ReVision 서비스(8002)에 연결할 수 없을 때 발생한다. 분석을 시작하지 않는다."""

REVISION_UNAVAILABLE_MESSAGE = "분석 서버(ReVision)가 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요."

def get_ffmpeg_paths():
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")

    if ffmpeg and ffprobe:
        return ffmpeg, ffprobe

    try:
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        ffprobe = ffmpeg.replace("ffmpeg", "ffprobe")
        return ffmpeg, ffprobe
    except ModuleNotFoundError as error:
        raise RuntimeError("ffmpeg is not available. Install ffmpeg or imageio-ffmpeg.") from error

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class AnalysisRequest(BaseModel):
    project_name: str
    video_path: str
    scenarios: List[str]
    # ReVision은 영어 질문 기준이다. scenarios와 같은 순서·길이의 영어 문장(백엔드가 번역해서 보냄).
    queries_en: Optional[List[str]] = None
    # scenarios와 같은 순서. 이미 구간을 아는 장면(추천으로 받은 것)은 {"start","end"}, 찾아야 하는 장면은 null.
    known_segments: Optional[List[Optional[dict]]] = None

class ExportSegment(BaseModel):
    start: float
    end: float
    speed: float = 1.0
    muted: bool = False

class ExportRequest(BaseModel):
    video_path: str
    segments: List[ExportSegment]
    # 출력 화면 비율("16:9", "9:16", "1:1"). 없으면 원본 비율 그대로. 영상은 비율을 유지한 채 검은 여백으로 채운다.
    output_aspect: Optional[str] = None
    # 편집된 타임라인(구간 순서, 배속 반영) 기준 자막. 있으면 내보낸 영상에 자막을 입힌다.
    subtitle_cues: Optional[List["ExportSubtitleCue"]] = None
    subtitle_style: Optional["SubtitleStyle"] = None

class ExportSubtitleCue(BaseModel):
    start: float
    end: float
    text: str
    top: Optional[str] = None   # 두 언어 표시일 때 위에 놓는 원문
    bottom: Optional[str] = None  # 아래 줄에 덧붙이는 다른 언어 자막(예: 영어)
    x: Optional[float] = None   # 자막 가운데의 가로 위치(영상 가로 대비 %). 없으면 가운데
    y: Optional[float] = None   # 영상 아래쪽에서 자막 아래끝까지의 거리(세로 대비 %). 없으면 스타일 기본 위치
    # 아래 값이 있으면 이 자막만 기본 스타일 대신 사용한다.
    font: Optional[str] = None
    size: Optional[float] = None
    color: Optional[str] = None
    box: Optional[bool] = None

class SubtitleStyle(BaseModel):
    font: str = "nanum-gothic"
    size: float = 3.5        # 영상 세로 길이 대비 글자 크기(%)
    position: float = 8.0    # 영상 아래쪽에서 자막까지의 거리(세로 길이 대비 %)
    color: str = "#FFFFFF"
    box: bool = False        # True면 글자 뒤에 반투명 검정 박스
    extra_lang: str = "en"   # 아래 줄(추가 언어) 자막의 언어 코드. 글자체 선택에 쓴다.

ExportRequest.model_rebuild()

SUBTITLE_FONTS_DIR = os.environ.get("SUBTITLE_FONTS_DIR", "/shareHost/jiyes/fonts")
# id -> (libass FontName, Bold 플래그). 폰트 파일은 SUBTITLE_FONTS_DIR에 있다.
SUBTITLE_FONTS = {
    "nanum-gothic": ("NanumGothic", 1),
    "nanum-gothic-xbold": ("NanumGothicExtraBold", 0),
    "gothic-a1": ("Gothic A1", 1),
    "gothic-a1-black": ("Gothic A1 Black", 0),
    "plex-kr": ("IBM Plex Sans KR", 1),
    "nanum-myeongjo": ("NanumMyeongjo", 1),
    "black-han-sans": ("Black Han Sans", 0),
    "do-hyeon": ("Do Hyeon", 0),
    "jua": ("Jua", 0),
    "gowun-dodum": ("Gowun Dodum", 0),
    "nanum-pen": ("Nanum Pen", 0),
}

def get_video_size(ffprobe: str, video_path: str) -> tuple[int, int]:
    import subprocess
    result = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", video_path],
        capture_output=True, text=True,
    )
    try:
        width, height = result.stdout.strip().split("x")
        return int(width), int(height)
    except ValueError:
        return 1080, 1920

EXPORT_ASPECTS = {"16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1.0}

def compute_export_canvas(src_width: int, src_height: int, aspect: str) -> tuple[int, int, tuple[int, int, int, int]]:
    """원본 영상(src)을 비율(aspect)의 캔버스에 비율을 유지한 채 넣는다.
    캔버스의 짧은 변은 1080(원본의 짧은 변이 더 작으면 그 크기)으로 맞춘다. 예: 9:16 -> 1080x1920, 16:9 -> 1920x1080.
    반환: (캔버스 가로, 세로, 캔버스 안 실제 영상 영역 (x0, y0, 가로, 세로))."""
    ratio = EXPORT_ASPECTS[aspect]
    short_side = min(1080, src_width, src_height)
    if ratio >= 1:
        canvas_h, canvas_w = short_side, round(short_side * ratio)
    else:
        canvas_w, canvas_h = short_side, round(short_side / ratio)
    canvas_w, canvas_h = canvas_w - canvas_w % 2, canvas_h - canvas_h % 2
    scale = min(canvas_w / src_width, canvas_h / src_height)
    video_w, video_h = round(src_width * scale), round(src_height * scale)
    return canvas_w, canvas_h, ((canvas_w - video_w) // 2, (canvas_h - video_h) // 2, video_w, video_h)

# 추가 언어 자막(아래 줄)에 쓰는 폰트. 한글 폰트에는 일본어·중국어·태국어 글자가 없어서 언어별로 따로 둔다.
EXTRA_LANGUAGE_FONTS = {
    "ko": "NanumGothic",
    "ja": "Noto Sans JP",
    "zh": "Noto Sans SC",
    "th": "Noto Sans Thai",
}
EXTRA_LANGUAGE_DEFAULT_FONT = "Noto Sans"  # 영어·스페인어·프랑스어·독일어·베트남어 등 라틴 문자

def validate_subtitle_style(style: "SubtitleStyle") -> None:
    if style.font not in SUBTITLE_FONTS:
        raise HTTPException(status_code=400, detail=f"지원하지 않는 자막 폰트입니다: {style.font}")
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", style.color):
        raise HTTPException(status_code=400, detail="자막 색상은 #RRGGBB 형식이어야 합니다.")

def ass_color(hex_color: str, alpha: str = "00") -> str:
    return f"&H{alpha}{hex_color[5:7]}{hex_color[3:5]}{hex_color[1:3]}"

def ass_time(seconds: float) -> str:
    centis = round(max(0.0, seconds) * 100)
    return f"{centis // 360000}:{centis // 6000 % 60:02d}:{centis // 100 % 60:02d}.{centis % 100:02d}"

def ass_text(value: str) -> str:
    return value.replace("{", "").replace("}", "").replace("\\", "").replace("\r", "").strip().replace("\n", "\\N")

def build_ass(cues: List["ExportSubtitleCue"], style: "SubtitleStyle", width: int, height: int, rect: Optional[tuple[int, int, int, int]] = None) -> str:
    """자막을 ASS 파일 내용으로 만든다. 좌표계를 실제 영상 픽셀로 맞추고, 자막별 위치는 \\pos로 지정한다.
    자막마다 폰트·크기·색·박스가 다를 수 있어서, 조합별로 Style을 하나씩 만든다.
    rect=(x0, y0, 가로, 세로)는 캔버스(width x height) 안에서 실제 영상이 차지하는 영역이다. 여백이 있어도 자막의 크기와 위치는
    미리보기처럼 영상 영역 기준(%)으로 계산한다. 없으면 캔버스 전체가 영상이다."""
    validate_subtitle_style(style)
    x0, y0, video_w, video_h = rect if rect else (0, 0, width, height)
    margin_h = x0 + round(video_w * 0.05)
    margin_v = (height - (y0 + video_h)) + round(min(max(style.position, 0.0), 95.0) / 100 * video_h)
    style_lines: List[str] = []
    style_names: dict = {}

    def style_for(cue: "ExportSubtitleCue") -> tuple[str, str, int]:
        resolved = SubtitleStyle(
            font=cue.font or style.font,
            size=cue.size if cue.size is not None else style.size,
            position=style.position,
            color=cue.color or style.color,
            box=style.box if cue.box is None else cue.box,
        )
        key = (resolved.font, round(resolved.size, 2), resolved.color.upper(), resolved.box)
        if key not in style_names:
            validate_subtitle_style(resolved)
            font_name, bold = SUBTITLE_FONTS[resolved.font]
            font_size = round(min(max(resolved.size, 1.0), 12.0) / 100 * video_h)
            border_style, outline_color, outline = (3, ass_color("#000000", "80"), max(2, round(video_h * 0.006))) if resolved.box else (1, ass_color("#000000"), max(1, round(video_h * 0.0035)))
            primary = ass_color(resolved.color)
            name = f"S{len(style_names)}"
            style_names[key] = name
            style_lines.append(
                f"Style: {name},{font_name},{font_size},{primary},{primary},{outline_color},&H00000000,{-1 if bold else 0},0,0,0,100,100,0,0,{border_style},{outline},0,2,{margin_h},{margin_h},{margin_v},1"
            )
        return style_names[key], ass_color(resolved.color), round(min(max(resolved.size, 1.0), 12.0) / 100 * video_h)

    events: List[str] = []
    for cue in cues:
        text = ass_text(cue.text)
        bottom = ass_text(cue.bottom) if cue.bottom else ""
        if not text and not cue.top and not bottom:
            continue

        style_name, primary, font_px = style_for(cue)
        body = text
        if cue.top and ass_text(cue.top):
            body = f"{{\\c{ass_color('#CCCCCC')}&}}{ass_text(cue.top)}\\N{{\\c{primary}&}}{text}"
        if bottom:
            # 아래 줄(영어 등)은 본 자막보다 조금 작게 그린다.
            extra_font = EXTRA_LANGUAGE_FONTS.get(style.extra_lang, EXTRA_LANGUAGE_DEFAULT_FONT)
            body = f"{body}\\N{{\\fn{extra_font}\\b1\\fs{round(font_px * 0.85)}}}{bottom}"
        if cue.x is not None or cue.y is not None:
            x = x0 + min(max(cue.x if cue.x is not None else 50.0, 0.0), 100.0) / 100 * video_w
            y = y0 + video_h - min(max(cue.y if cue.y is not None else style.position, 0.0), 100.0) / 100 * video_h
            body = f"{{\\an2\\pos({x:.0f},{y:.0f})}}{body}"
        events.append(f"Dialogue: 0,{ass_time(cue.start)},{ass_time(cue.end)},{style_name},,0,0,0,,{body}")

    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 0",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        *style_lines,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        *events,
    ]
    return "\n".join(lines) + "\n"

class AnalysisJobStartResponse(BaseModel):
    status: str
    job_id: str

class AnalysisJobStatus(BaseModel):
    status: str
    progress: int
    step_id: int
    step_label: str
    message: str
    logs: List[str]
    project: str
    results: List[dict]
    error: Optional[str] = None
    video_path: Optional[str] = None

ANALYSIS_STEPS = [
    "영상 파일 수신 중",
    "프레임 디코딩",
    "씬 경계 감지",
    "오디오 파형 분석",
    "시나리오 매핑",
    "하이라이트 구간 확정",
]

analysis_jobs: dict[str, dict] = {}
analysis_jobs_lock = threading.Lock()

def make_safe_name(name: str):
    clean_name = re.sub(r'[\\/:*?"<>|]', "", name).strip().replace(" ", "_")
    return clean_name

def update_job(job_id: str, **updates):
    with analysis_jobs_lock:
        job = analysis_jobs.get(job_id)
        if not job:
            return
        # 진행률은 뒤로 가지 않는다(단계마다 다른 기준으로 갱신해도 막대가 줄어들지 않게).
        if "progress" in updates and updates.get("status") != "error":
            updates["progress"] = max(int(updates["progress"]), int(job.get("progress", 0)))
        job.update(updates)
        job["updated_at"] = time.time()

def add_job_log(job_id: str, message: str):
    with analysis_jobs_lock:
        job = analysis_jobs.get(job_id)
        if not job:
            return
        job["logs"] = [*job.get("logs", []), message]
        job["updated_at"] = time.time()

def watch_revision_progress(request_id: str, apply) -> threading.Event:
    """ReVision 서비스가 요청을 처리하는 동안 실제 진행 상태를 주기적으로 읽어 apply(state)로 넘긴다. 반환된 Event를 set하면 멈춘다."""
    import revision_client

    stop = threading.Event()

    def loop():
        last = None
        while not stop.wait(0.7):
            state = revision_client.progress(request_id)
            if state and state != last:
                last = state
                try:
                    apply(state)
                except Exception as error:  # 진행 표시 실패가 분석을 막으면 안 된다
                    print(f"[progress] {error}")

    threading.Thread(target=loop, daemon=True).start()
    return stop


# ReVision 단계 -> (분석 단계 번호, 안내 문구). 시나리오 분석은 진행률 12~68%를 이 단계들이 채운다.
GROUND_STAGE_INFO = {
    "decode": (1, "영상을 프레임으로 푸는 중..."),
    "clip": (1, "프레임 특징을 계산하는 중..."),
    "audio": (3, "오디오 특징을 추출하는 중..."),
    "ground": (4, "시나리오 구간을 탐색하는 중..."),
}


def apply_ground_progress(job_id: str, state: dict):
    step, message = GROUND_STAGE_INFO.get(state.get("stage"), (1, "분석 중..."))
    detail = f" ({state['detail']})" if state.get("detail") and state.get("stage") in ("clip", "ground") else ""
    update_job(job_id, progress=int(12 + state["fraction"] * 56), step_id=step, step_label=ANALYSIS_STEPS[step], message=message + detail)


def ground_with_revision(request: AnalysisRequest, job_id: str | None) -> list:
    """ReVision 서비스로 모든 시나리오의 구간을 한 번에 찾는다. 시나리오와 같은 순서로 {"start","end"} 또는 None."""
    import revision_client

    queries = request.queries_en
    if not queries or len(queries) != len(request.scenarios):
        queries = request.scenarios
        message = "⚠️ 영어 질문이 없어 시나리오 원문으로 탐색합니다. 한국어는 정확도가 크게 떨어질 수 있습니다."
        print(message)
        if job_id:
            add_job_log(job_id, message)
    if job_id:
        update_job(
            job_id,
            progress=15,
            step_id=1,
            step_label=ANALYSIS_STEPS[1],
            message="ReVision으로 시나리오 구간을 탐색 중입니다.",
        )
    stop = watch_revision_progress(job_id, lambda state: apply_ground_progress(job_id, state)) if job_id else None
    try:
        return revision_client.ground(request.video_path, queries, request_id=job_id)
    finally:
        if stop:
            stop.set()

def valid_known_segment(segment) -> dict | None:
    """이미 알고 있는 구간({"start","end"} 초)이 쓸 만한지 확인한다. 아니면 None(=다시 찾는다)."""
    try:
        start, end = float(segment["start"]), float(segment["end"])
    except (TypeError, KeyError, ValueError):
        return None
    if not (0 <= start < end):
        return None
    return {"start": start, "end": end}


def run_analysis(request: AnalysisRequest, job_id: str | None = None):
    print(f"video_path: {request.video_path}")
    final_results = []

    if job_id:
        update_job(job_id, status="running", progress=5, step_id=0, step_label=ANALYSIS_STEPS[0], message="분석 요청을 수신했습니다.")
        add_job_log(job_id, f"✓  {ANALYSIS_STEPS[0]}")

    safe_project = make_safe_name(request.project_name)

    total_scenarios = max(1, len(request.scenarios))

    # 구간을 이미 아는 장면(추천으로 받은 것)은 검색하지 않고 그 시간을 그대로 쓴다. 나머지만 ReVision으로 찾는다.
    known = [valid_known_segment(request.known_segments[i]) if request.known_segments and i < len(request.known_segments) else None
             for i in range(len(request.scenarios))]
    to_find = [i for i, segment in enumerate(known) if segment is None]
    revision_segments: list = list(known)

    if to_find:
        # 분석은 ReVision 서비스로만 수행한다. 연결할 수 없으면 분석을 시작하지 않고 안내 문구를 반환한다.
        import revision_client
        if not revision_client.is_available():
            print("⚠️ ReVision 서비스에 연결할 수 없어 분석을 시작하지 않습니다.")
            raise ReVisionUnavailableError(REVISION_UNAVAILABLE_MESSAGE)
        queries_en = request.queries_en if request.queries_en and len(request.queries_en) == len(request.scenarios) else None
        sub_request = AnalysisRequest(
            project_name=request.project_name,
            video_path=request.video_path,
            scenarios=[request.scenarios[i] for i in to_find],
            queries_en=[queries_en[i] for i in to_find] if queries_en else None,
        )
        for index, found in zip(to_find, ground_with_revision(sub_request, job_id)):
            revision_segments[index] = found
    elif job_id:
        add_job_log(job_id, "✓  추천받은 구간을 그대로 사용합니다")

    for i, query in enumerate(request.scenarios, start=1):
        safe_query_text = make_safe_name(query)[:30]
        scenario_folder_name = f"sc{i}_{safe_query_text}"

        scenario_base_progress = 10 + round(((i - 1) / total_scenarios) * 58)
        if job_id:
            update_job(
                job_id,
                progress=scenario_base_progress,
                step_id=1,
                step_label=ANALYSIS_STEPS[1],
                message=f"{i}/{total_scenarios} 시나리오 프레임을 분석 중입니다.",
            )

        found = revision_segments[i - 1]
        segments = [found] if found else []
        print(f"[revision] scenario {i} '{query}' -> {found}")

        if job_id:
            update_job(
                job_id,
                progress=min(72, scenario_base_progress + 18),
                step_id=2,
                step_label=ANALYSIS_STEPS[2],
                message=f"{i}/{total_scenarios} 시나리오의 후보 구간을 찾았습니다.",
            )

        if segments: # 수정
            best = segments[0] #
            if job_id:
                update_job(
                    job_id,
                    progress=min(84, scenario_base_progress + 26),
                    step_id=3,
                    step_label=ANALYSIS_STEPS[3],
                    message="오디오 파형을 추출 중입니다.",
                )

            from audio.audio_waveform import extract_audio_waveform
            audio_data = extract_audio_waveform(request.video_path, bar_count=88)

            final_results.append({
                "project_name": request.project_name,
                "id": i,
                "scenario": query,
                "start": round(best.get("start", 0), 1),
                "end": round(best.get("end", 0), 1),
                "audio": {
                    "duration": audio_data["duration"],
                    "barCount": audio_data["barCount"],
                    "amplitudes": audio_data["amplitudes"]
                }
            })

        if job_id:
            update_job(
                job_id,
                progress=min(92, 10 + round((i / total_scenarios) * 76)),
                step_id=4,
                step_label=ANALYSIS_STEPS[4],
                message=f"{i}/{total_scenarios} 시나리오 결과를 매핑했습니다.",
                results=final_results,
            )
            add_job_log(job_id, f"✓  {query}")

    if job_id:
        update_job(
            job_id,
            status="success",
            progress=100,
            step_id=5,
            step_label=ANALYSIS_STEPS[5],
            message="하이라이트 구간 확정 완료",
            results=final_results,
        )
        add_job_log(job_id, f"✓  {ANALYSIS_STEPS[5]}")

    return final_results

def run_analysis_job(job_id: str, request: AnalysisRequest):
    try:
        run_analysis(request, job_id=job_id)
    except Exception as error:
        print(f"❌ 에러 발생: {error}")
        import traceback
        traceback.print_exc()
        update_job(
            job_id,
            status="error",
            error=str(error),
            message=REVISION_UNAVAILABLE_MESSAGE if isinstance(error, ReVisionUnavailableError) else "분석 요청에 실패했습니다.",
        )

@app.post("/analyze/jobs", response_model=AnalysisJobStartResponse)
async def start_analyze_job(
    video: UploadFile = File(...),
    project_name: str = Form(...),
    scenarios: str = Form(...),
    queries_en: Optional[str] = Form(None),
    known_segments: Optional[str] = Form(None),
):
    scenarios_list: List[str] = json.loads(scenarios)
    queries_en_list: Optional[List[str]] = json.loads(queries_en) if queries_en else None
    known_segments_list: Optional[List[Optional[dict]]] = json.loads(known_segments) if known_segments else None

    suffix = os.path.splitext(video.filename or ".mp4")[1] or ".mp4"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        content = await video.read()
        tmp.write(content)
        tmp.flush()
    finally:
        tmp.close()

    request = AnalysisRequest(
        project_name=project_name,
        video_path=tmp.name,
        scenarios=scenarios_list,
        queries_en=queries_en_list,
        known_segments=known_segments_list,
    )

    job_id = uuid.uuid4().hex
    with analysis_jobs_lock:
        analysis_jobs[job_id] = {
            "status": "queued",
            "progress": 0,
            "step_id": 0,
            "step_label": ANALYSIS_STEPS[0],
            "message": "분석 대기 중입니다.",
            "logs": [],
            "project": request.project_name,
            "results": [],
            "error": None,
            "video_path": tmp.name,
            "created_at": time.time(),
            "updated_at": time.time(),
        }

    thread = threading.Thread(target=run_analysis_job, args=(job_id, request), daemon=True)
    thread.start()

    return {"status": "queued", "job_id": job_id}

# ---------------------------------------------------------------------------------------------------------
# 하이라이트 추출 / 장면 추천 (ReVision 서비스의 /highlights, /recommend를 부른다)
# ---------------------------------------------------------------------------------------------------------
HIGHLIGHT_STEPS = [
    "영상 파일 수신 중",
    "프레임 디코딩",
    "프레임 특징 추출",
    "오디오 분석",
    "하이라이트 점수 계산",
    "후보 구간 확정",
]
HIGHLIGHT_STEP_MESSAGES = [
    "분석 요청을 수신했습니다.",
    "영상을 프레임으로 푸는 중...",
    "프레임마다 장면의 특징을 계산하는 중...",
    "음량 · 음성 · 효과음 특징을 추출하는 중...",
    "구간별 반응도 점수를 매기는 중...",
    "구간에 이름을 붙이고 정리하는 중...",
]
# ReVision 단계 -> 하이라이트 단계 번호
HIGHLIGHT_STAGE_STEP = {"decode": 1, "clip": 2, "audio": 3, "score": 4, "plan": 4, "caption": 5, "name": 5}
HIGHLIGHT_WAVEFORM_BARS = 170


def save_upload_to_temp(content: bytes, filename: str | None) -> str:
    suffix = os.path.splitext(filename or ".mp4")[1] or ".mp4"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(content)
        tmp.flush()
    finally:
        tmp.close()
    return tmp.name


def apply_highlight_progress(job_id: str, state: dict):
    step = HIGHLIGHT_STAGE_STEP.get(state.get("stage"), 1)
    detail = f" ({state['detail']})" if state.get("detail") and state.get("stage") in ("clip", "caption") else ""
    update_job(
        job_id,
        progress=int(8 + state["fraction"] * 86),
        step_id=step,
        step_label=HIGHLIGHT_STEPS[step],
        message=HIGHLIGHT_STEP_MESSAGES[step] + detail,
    )


def run_highlight_job(job_id: str, video_path: str, title: str | None):
    """진행률은 ReVision 서비스가 보고하는 실제 단계(디코딩 · CLIP · 오디오 · 점수 · 설명 n/m)를 그대로 따른다."""
    stop = None
    try:
        update_job(job_id, status="running", progress=5, step_id=0, step_label=HIGHLIGHT_STEPS[0], message=HIGHLIGHT_STEP_MESSAGES[0])
        add_job_log(job_id, f"✓  {HIGHLIGHT_STEPS[0]}")

        import revision_client
        if not revision_client.is_available():
            raise ReVisionUnavailableError(REVISION_UNAVAILABLE_MESSAGE)

        stop = watch_revision_progress(job_id, lambda state: apply_highlight_progress(job_id, state))
        try:
            found = revision_client.highlights(video_path, title, request_id=job_id)
        finally:
            stop.set()

        update_job(job_id, progress=96, step_id=5, step_label=HIGHLIGHT_STEPS[5], message="오디오 파형을 만드는 중...")
        from audio.audio_waveform import extract_audio_waveform
        audio = extract_audio_waveform(video_path, bar_count=HIGHLIGHT_WAVEFORM_BARS)

        highlights = [
            {"id": item["id"], "start": round(item["start"], 1), "end": round(item["end"], 1), "label": item["label"]}
            for item in found["highlights"]
        ]
        for label in HIGHLIGHT_STEPS[1:]:
            add_job_log(job_id, f"✓  {label}")
        update_job(
            job_id,
            status="success",
            progress=100,
            step_id=5,
            step_label=HIGHLIGHT_STEPS[5],
            message="후보 구간 확정 완료",
            found=highlights,
            result={
                "duration": audio["duration"] or found["duration"],
                "highlights": highlights,
                "audio": {"barCount": audio["barCount"], "amplitudes": audio["amplitudes"]},
            },
        )
    except Exception as error:
        if stop:
            stop.set()
        print(f"❌ 하이라이트 추출 에러: {error}")
        import traceback
        traceback.print_exc()
        update_job(
            job_id,
            status="error",
            error=str(error),
            message=REVISION_UNAVAILABLE_MESSAGE if isinstance(error, ReVisionUnavailableError) else "하이라이트 추출에 실패했습니다.",
        )


@app.post("/highlights/jobs")
async def start_highlight_job(
    video: UploadFile = File(...),
    project_name: str = Form(...),
    title_en: Optional[str] = Form(None),
):
    video_path = save_upload_to_temp(await video.read(), video.filename)

    job_id = uuid.uuid4().hex
    with analysis_jobs_lock:
        analysis_jobs[job_id] = {
            "status": "queued",
            "progress": 0,
            "step_id": 0,
            "step_label": HIGHLIGHT_STEPS[0],
            "message": "분석 대기 중입니다.",
            "logs": [],
            "project": project_name,
            "results": [],
            "found": [],
            "result": None,
            "error": None,
            "video_path": video_path,
            "created_at": time.time(),
            "updated_at": time.time(),
        }

    threading.Thread(target=run_highlight_job, args=(job_id, video_path, (title_en or "").strip() or None), daemon=True).start()
    return {"status": "queued", "job_id": job_id}


@app.get("/highlights/jobs/{job_id}")
async def get_highlight_job(job_id: str):
    with analysis_jobs_lock:
        job = analysis_jobs.get(job_id)
        if not job or "result" not in job:
            raise HTTPException(status_code=404, detail="Highlight job not found")
        return {key: job.get(key) for key in ("status", "progress", "step_id", "step_label", "message", "logs", "project", "video_path", "error", "found", "result")}


@app.post("/recommend")
async def recommend_scenes(
    video: UploadFile = File(...),
    title_en: Optional[str] = Form(None),
):
    import asyncio
    import revision_client

    if not revision_client.is_available():
        raise HTTPException(status_code=503, detail=REVISION_UNAVAILABLE_MESSAGE)

    video_path = save_upload_to_temp(await video.read(), video.filename)
    try:
        scenes = await asyncio.to_thread(revision_client.recommend, video_path, (title_en or "").strip() or None)
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error))
    finally:
        try:
            os.remove(video_path)
        except OSError:
            pass
    return {"scenes": scenes}


class ScenarioFindRequest(BaseModel):
    video_path: str
    scenarios: List[str]
    queries_en: Optional[List[str]] = None


def resolve_uploaded_video(video_path: str) -> str:
    """분석 때 올라온 영상(임시 폴더의 파일)만 허용한다. 임의의 서버 파일 경로를 열어 보게 두지 않으려는 것이다."""
    real = os.path.realpath(video_path)
    temp_root = os.path.realpath(tempfile.gettempdir())
    if os.path.dirname(real) != temp_root or not os.path.isfile(real):
        raise HTTPException(status_code=404, detail="분석에 쓴 영상을 서버에서 찾을 수 없어요. 영상을 다시 올려 주세요.")
    return real


@app.post("/analyze/scenarios")
async def find_scenarios(request: ScenarioFindRequest):
    """이미 분석한 영상에서 시나리오(장면 설명)를 더 찾는다. 구간만 돌려주고 파형은 만들지 않는다.

    -> {"results": [{"scenario": "...", "start": 1.0, "end": 4.5} | null, ...]}  (null = 영상에서 찾지 못함)
    """
    import asyncio
    import revision_client

    scenarios = [text.strip() for text in request.scenarios]
    if not scenarios or not all(scenarios):
        raise HTTPException(status_code=400, detail="찾을 장면을 입력해 주세요.")

    video_path = resolve_uploaded_video(request.video_path)
    if not revision_client.is_available():
        raise HTTPException(status_code=503, detail=REVISION_UNAVAILABLE_MESSAGE)

    queries = request.queries_en if request.queries_en and len(request.queries_en) == len(scenarios) else scenarios
    try:
        found = await asyncio.to_thread(revision_client.ground, video_path, queries)
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error))

    return {
        "results": [
            None if item is None else {"scenario": scenario, "start": round(item["start"], 1), "end": round(item["end"], 1)}
            for scenario, item in zip(scenarios, found)
        ]
    }


@app.get("/analyze/jobs/{job_id}", response_model=AnalysisJobStatus)
async def get_analyze_job(job_id: str):
    with analysis_jobs_lock:
        job = analysis_jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Analysis job not found")
        return {
            "status": job["status"],
            "progress": job["progress"],
            "step_id": job["step_id"],
            "step_label": job["step_label"],
            "message": job["message"],
            "logs": job["logs"],
            "project": job["project"],
            "results": job["results"],
            "error": job.get("error"),
            "video_path": job.get("video_path"),
        }

class TranscribeRequest(BaseModel):
    video_path: str
    language: Optional[str] = "ko"

transcribe_jobs = {}
transcribe_jobs_lock = threading.Lock()
transcribe_run_lock = threading.Lock()

def update_transcribe_job(job_id: str, **fields):
    with transcribe_jobs_lock:
        job = transcribe_jobs.get(job_id)
        if job:
            job.update(fields)
            job["updated_at"] = time.time()

def run_transcribe_job(job_id: str, request: TranscribeRequest):
    try:
        from subtitle.whisper_stt import transcribe_video

        ffmpeg, _ = get_ffmpeg_paths()
        update_transcribe_job(job_id, status="running", message="음성을 인식하는 중입니다.")

        with transcribe_run_lock:
            segments = transcribe_video(
                ffmpeg,
                request.video_path,
                language=request.language or None,
                on_progress=lambda ratio: update_transcribe_job(job_id, progress=int(ratio * 100)),
            )

        update_transcribe_job(
            job_id,
            status="success",
            progress=100,
            message="자막 생성이 완료됐습니다.",
            segments=segments,
        )
    except Exception as error:
        import traceback
        traceback.print_exc()
        update_transcribe_job(job_id, status="error", error=str(error), message="자막 생성에 실패했습니다.")

@app.post("/transcribe/jobs")
async def start_transcribe_job(request: TranscribeRequest):
    if not os.path.isfile(request.video_path):
        raise HTTPException(status_code=404, detail="영상 파일을 찾을 수 없습니다. 영상을 다시 분석해 주세요.")

    job_id = uuid.uuid4().hex
    with transcribe_jobs_lock:
        transcribe_jobs[job_id] = {
            "status": "queued",
            "progress": 0,
            "message": "자막 생성 대기 중입니다.",
            "segments": [],
            "error": None,
            "created_at": time.time(),
            "updated_at": time.time(),
        }

    threading.Thread(target=run_transcribe_job, args=(job_id, request), daemon=True).start()
    return {"status": "queued", "job_id": job_id}

@app.get("/transcribe/jobs/{job_id}")
async def get_transcribe_job(job_id: str):
    with transcribe_jobs_lock:
        job = transcribe_jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Transcribe job not found")
        return {key: job[key] for key in ("status", "progress", "message", "segments", "error")}

@app.post("/analyze")
async def analyze(request: AnalysisRequest):
    try:
        final_results = run_analysis(request)
    except ReVisionUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error))

    return {
        "status": "success",
        "project": request.project_name,
        "results": final_results
    }

@app.post("/export")
async def export_video(request: ExportRequest):
    import subprocess
    from fastapi.responses import FileResponse
    
    ffmpeg, ffprobe = get_ffmpeg_paths()
    temp_files = []
    export_id = uuid.uuid4().hex
    tmp_dir = tempfile.gettempdir()

    def get_safe_speed(value: float) -> float:
        if not isinstance(value, (int, float)) or value <= 0:
            return 1.0
        return min(float(value), 8.0)

    def build_atempo_filter(speed: float) -> str:
        parts = []
        remaining = speed

        while remaining > 2.0:
            parts.append("atempo=2.0")
            remaining /= 2.0

        while remaining < 0.5:
            parts.append("atempo=0.5")
            remaining /= 0.5

        parts.append(f"atempo={remaining:.6f}")
        return ",".join(parts)

    def has_audio_stream(video_path: str) -> bool:
        try:
            result = subprocess.run(
                [
                    ffprobe,
                    "-v",
                    "error",
                    "-select_streams",
                    "a:0",
                    "-show_entries",
                    "stream=index",
                    "-of",
                    "csv=p=0",
                    video_path,
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            return result.returncode == 0 and bool(result.stdout.strip())
        except OSError:
            return True
    
    try:
        if not request.segments:
            raise HTTPException(status_code=400, detail="No segments to export")

        subtitle_cues = [cue for cue in (request.subtitle_cues or []) if cue.end > cue.start]
        if subtitle_cues:
            validate_subtitle_style(request.subtitle_style or SubtitleStyle())

        source_has_audio = has_audio_stream(request.video_path)

        # 출력 비율이 지정되면 그 비율의 캔버스에 영상을 비율 유지로 넣는다(남는 곳은 검은 여백).
        canvas = None
        video_rect = None
        if request.output_aspect:
            if request.output_aspect not in EXPORT_ASPECTS:
                raise HTTPException(status_code=400, detail=f"지원하지 않는 출력 비율입니다: {request.output_aspect}")
            src_width, src_height = get_video_size(ffprobe, request.video_path)
            canvas_w, canvas_h, video_rect = compute_export_canvas(src_width, src_height, request.output_aspect)
            canvas = f"scale={canvas_w}:{canvas_h}:force_original_aspect_ratio=decrease,pad={canvas_w}:{canvas_h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,"

        for i, seg in enumerate(request.segments):
            temp_path = os.path.join(tmp_dir, f"clipcraft_{export_id}_clip_{i}.mp4")
            start = max(0.0, seg.start)
            end = max(start + 0.05, seg.end)
            speed = get_safe_speed(seg.speed)
            duration = end - start
            output_duration = duration / speed
            video_filter = f"[0:v]{canvas or ''}setpts=PTS/{speed:.6f}[v]"

            if seg.muted or not source_has_audio:
                filter_complex = f"{video_filter};[1:a]atrim=0:{output_duration:.6f},asetpts=PTS-STARTPTS[a]"
                command = [
                    ffmpeg,
                    "-y",
                    "-ss",
                    str(start),
                    "-to",
                    str(end),
                    "-i",
                    request.video_path,
                    "-f",
                    "lavfi",
                    "-t",
                    f"{output_duration:.6f}",
                    "-i",
                    "anullsrc=channel_layout=stereo:sample_rate=48000",
                    "-filter_complex",
                    filter_complex,
                    "-map",
                    "[v]",
                    "-map",
                    "[a]",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "23",
                    "-c:a",
                    "aac",
                    "-shortest",
                    temp_path,
                ]
            else:
                audio_filter = f"{build_atempo_filter(speed)},aformat=sample_rates=48000:channel_layouts=stereo"
                filter_complex = f"{video_filter};[0:a]{audio_filter}[a]"
                command = [
                    ffmpeg,
                    "-y",
                    "-ss",
                    str(start),
                    "-to",
                    str(end),
                    "-i",
                    request.video_path,
                    "-filter_complex",
                    filter_complex,
                    "-map",
                    "[v]",
                    "-map",
                    "[a]",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "23",
                    "-c:a",
                    "aac",
                    "-shortest",
                    temp_path,
                ]

            subprocess.run(command, check=True, capture_output=True)
            temp_files.append(temp_path)
        
        list_file = os.path.join(tmp_dir, f"clipcraft_{export_id}_clips_list.txt")
        with open(list_file, "w") as f:
            for p in temp_files:
                f.write(f"file '{p}'\n")
        
        output_path = os.path.join(tmp_dir, f"clipcraft_{export_id}_output_final.mp4")
        concat_path = os.path.join(tmp_dir, f"clipcraft_{export_id}_concat.mp4") if subtitle_cues else output_path
        subprocess.run([
            ffmpeg, "-y", "-f", "concat", "-safe", "0",
            "-i", list_file, "-c", "copy", concat_path
        ], check=True)

        if subtitle_cues:
            if not os.path.isdir(SUBTITLE_FONTS_DIR):
                raise HTTPException(status_code=500, detail="자막 폰트 폴더를 찾을 수 없습니다.")

            ass_path = os.path.join(tmp_dir, f"clipcraft_{export_id}_subtitles.ass")
            width, height = get_video_size(ffprobe, concat_path)
            with open(ass_path, "w", encoding="utf-8") as f:
                f.write(build_ass(subtitle_cues, request.subtitle_style or SubtitleStyle(), width, height, video_rect))
            temp_files.extend([concat_path, ass_path])

            subtitle_filter = f"subtitles=filename={ass_path}:fontsdir={SUBTITLE_FONTS_DIR}"
            subprocess.run([
                ffmpeg, "-y", "-i", concat_path, "-vf", subtitle_filter,
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "copy", output_path
            ], check=True, capture_output=True)

        return FileResponse(output_path, media_type="video/mp4", filename="clipcraft_export.mp4")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
