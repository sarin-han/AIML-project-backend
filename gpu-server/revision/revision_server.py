"""ReVisionLLM 구간 탐색 서비스 (별도 프로세스).

GPU 서버(server.py)와 파이썬 패키지 버전이 달라서(transformers 4.41.2 등) 같은 프로세스에 넣지 않고,
ReVision 환경(예: /shareHost/minyoy/venvs/revaudio)에서 따로 띄운 뒤 HTTP로 부른다.

    REVISION_ROOT=/shareHost/jiyes/ClipCraft-AI \
    /shareHost/minyoy/venvs/revaudio/bin/python revision_server.py

POST /ground  {"video_path": "...", "queries": ["영어 질문", ...], "window": 60(선택, 초)}
           -> {"duration": 12.3, "results": [{"query": "...", "start": 1.0, "end": 4.5} | null, ...]}
POST /highlights {"video_path": "...", "title": "영어 제목(선택)"}
           -> {"duration": 298.0, "highlights": [{"id": 1, "start": 8.0, "end": 20.0, "label": "..."}]}
POST /recommend  {"video_path": "...", "title": "영어 제목(선택)"}
           -> {"scenes": ["재료 손질", ...]}
GET  /progress?id=<request_id> -> {"stage": "clip", "sub": 0.4, "fraction": 0.22, "detail": "3/9", "done": false}
GET  /health  -> {"status": "ok"}

한 번에 한 요청만 처리한다(모델 generate가 스레드 안전하지 않음). 127.0.0.1에서만 연다.
"""
import json
import gc
import os
import sys
import threading
import time
from collections import OrderedDict
import math
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.abspath(os.environ.get("REVISION_ROOT", "/shareHost/jiyes/ClipCraft-AI"))
HOST = os.environ.get("REVISION_HOST", "127.0.0.1")
PORT = int(os.environ.get("REVISION_PORT", "8002"))
FEATURE_CACHE_SIZE = int(os.environ.get("REVISION_FEATURE_CACHE", "2"))
# 모델이 한 번에 보는 창 길이(초). 영상이 이보다 짧으면 영상 전체를 창 1개로 보고, 길면 절반씩 겹치는 창으로 나눈다.
DEFAULT_WINDOW = int(os.environ.get("REVISION_WINDOW", "60"))

os.chdir(ROOT)  # ReVision 코드가 상대 경로를 쓴다
sys.path.insert(0, ROOT)

import numpy as np  # noqa: E402
import torch  # noqa: E402
import ffmpeg  # noqa: E402

import revisionllm.multiquery.grounder as grounder_module  # noqa: E402
from revisionllm.multiquery.config import CacheConfig  # noqa: E402
from revisionllm.multiquery.grounder import Grounder, model_args, norm_sentence  # noqa: E402
from revisionllm.data.audio_pipeline.extract_clip import ClipFrameExtractor  # noqa: E402
from revisionllm.data.audio_pipeline.extract_clap import ClapAudioExtractor  # noqa: E402
from revisionllm.data.feature_extraction.clip_extractor import ClipFeatureExtractor  # noqa: E402
from revisionllm.editing.db import EditDB  # noqa: E402
from revisionllm.multiquery.feature_cache import FeatureCache  # noqa: E402
from revisionllm.multiquery.service import MultiQueryGrounder, model_version_of  # noqa: E402

from progress import tracker  # noqa: E402

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # gpu-server/의 공용 모듈
from gpu_lock import gpu_lock  # noqa: E402

CLIP_PT = os.path.join(ROOT, "checkpoints/clip/ViT-L-14.pt")
VICUNA = os.path.join(ROOT, "checkpoints/vicuna-7b-v1.5")
STAGE2 = os.path.join(ROOT, "checkpoints/audio_charades_long/stageB_R2_seed0")
STAGE1_PROJ = os.path.join(ROOT, "checkpoints/vtimellm-vicuna-v1-5-7b-stage1/mm_projector.bin")
CLIP_ADAPTER = os.path.join(ROOT, "checkpoints/public/chapters_stage1_sparse/non_lora_trainables.bin")

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
cfg = CacheConfig()
lock = threading.Lock()


class ReportingClipFrameExtractor(ClipFrameExtractor):
    """ClipFrameExtractor와 같은 계산에 진행 보고만 더했다: 디코딩 → 배치별 CLIP 인코딩."""

    @torch.no_grad()
    def __call__(self, video_path: str) -> np.ndarray:
        tracker.report("decode", 0.0, "영상을 프레임으로 푸는 중")
        frames = self.loader.read_uint8(video_path)  # (T, 224, 224, 3) uint8
        if frames is None or frames.ndim != 4 or frames.shape[0] == 0:
            raise RuntimeError(f"could not decode {video_path}")
        tracker.report("decode", 1.0)
        batches = int(math.ceil(frames.shape[0] / self.batch_size))
        out = []
        for b in range(batches):
            x = torch.from_numpy(frames[b * self.batch_size:(b + 1) * self.batch_size]).to(self.device)
            x = x.permute(0, 3, 1, 2).float()
            x = (x / 255.0 - self.mean) / (self.std + 1e-8)
            out.append(self.model.encode_image(x.to(self.dtype)).float().cpu())
            tracker.report("clip", (b + 1) / batches, f"{b + 1}/{batches}")
        return torch.cat(out, dim=0).numpy().astype(np.float16)


# ground_many의 행(질문 x 창) 묶음마다 모델을 한 번 돌린다. 한 묶음이 끝날 때마다 처리한 행 수를 보고한다.
_rows = {"done": 0, "total": 1}
_original_inference = grounder_module.inference


def _reporting_inference(model, feat, qt, prompts, *args, **kwargs):
    result = _original_inference(model, feat, qt, prompts, *args, **kwargs)
    _rows["done"] += len(prompts)
    tracker.report("ground", _rows["done"] / max(1, _rows["total"]), f"{min(_rows['done'], _rows['total'])}/{_rows['total']}")
    return result


grounder_module.inference = _reporting_inference


class ReportingClap:
    """ClapAudioExtractor와 같은 계산에 진행 보고만 더했다."""

    def __init__(self, extractor):
        self.extractor = extractor

    def __call__(self, path):
        tracker.report("audio", 0.0, "오디오 특징을 뽑는 중")
        audio = self.extractor(path)
        tracker.report("audio", 1.0)
        return audio


class FeatureStore:
    """영상 특징(CLIP 프레임 + CLAP 오디오)을 DB와 디스크에 저장해 두고 돌려 준다.

    영상 파일의 SHA-256으로 영상을 알아보므로, 같은 영상을 다시 올리면(임시 파일 경로가 달라도) 다시 추출하지 않는다.
    특징 파일은 CacheConfig.cache_dir(vision.npy / audio.npy), 영상·결과 기록은 PostgreSQL(video, query_cache, edit_result)에 있다.
    이미 올라와 있는 추출기를 그대로 쓰므로 모델을 한 번 더 올리지 않는다.
    """

    def __init__(self, db, clip_frames, clap):
        self.cache = FeatureCache(cfg, db, CLIP_PT)
        self.cache._clip, self.cache._clap = clip_frames, ReportingClap(clap)
        self._recent = OrderedDict()  # (path, size, mtime_ns) -> VideoFeatures: 같은 파일의 해시를 다시 계산하지 않으려는 작은 기억

    def get(self, path):
        st = os.stat(path)
        key = (path, st.st_size, st.st_mtime_ns)
        feats = self._recent.get(key)
        if feats is None:
            feats = self.cache.get(path)  # 해시 → DB 조회 → 없으면 추출해서 저장
            print(f"[revision] features for {os.path.basename(path)}: {'DB cache hit' if feats.cache_hit else 'extracted and stored'}", flush=True)
            self._recent[key] = feats
            while len(self._recent) > FEATURE_CACHE_SIZE:
                self._recent.popitem(last=False)
        else:
            self._recent.move_to_end(key)
        for stage in ("decode", "clip", "audio"):  # 캐시에서 가져왔다면 이 단계들은 건너뛴 것이다
            tracker.report(stage, 1.0)
        return feats


class Engine:
    def __init__(self):
        t0 = time.time()
        self.clip_frames = ReportingClipFrameExtractor(CLIP_PT, fps=cfg.feature_fps, device=DEVICE)
        self.clap = ClapAudioExtractor(cfg.clap_name, hop_sec=cfg.audio_hop_sec, device=DEVICE)
        self.text = ClipFeatureExtractor(framerate=30, size=224, centercrop=True,
                                         model_name_or_path=CLIP_PT, device=DEVICE)
        self.grounder = Grounder(model_args(CLIP_PT, VICUNA, STAGE2, STAGE1_PROJ, CLIP_ADAPTER, cfg), cfg)

        # 질문 x 창 행을 모델에 넣는 묶음(ground_many)이 시작될 때 이번에 처리할 행 수를 알려 둔다(진행률용).
        original_ground_many = self.grounder.ground_many

        def ground_many(prepared, items, *args, **kwargs):
            _rows["done"], _rows["total"] = 0, max(1, len(items) * int(prepared.features.shape[0]))
            return original_ground_many(prepared, items, *args, **kwargs)

        self.grounder.ground_many = ground_many

        # DB 특징 저장 + 시맨틱 캐시 + 여러 질문 배치 처리 (ClipCraft-AI의 multiquery 모듈)
        self.db = EditDB(cfg.dsn, cfg.embedding_dim)
        self.store = FeatureStore(self.db, self.clip_frames, self.clap)
        self.multiquery = MultiQueryGrounder(cfg, CLIP_PT, self.grounder, model_version_of(STAGE2), db=self.db,
                                             text=self._encode_text, query_batch=grounder_module.BATCH)
        self.multiquery.features = self.store
        self._editing = None
        print(f"[revision] models loaded in {time.time() - t0:.1f}s on {DEVICE}; DB cache on", flush=True)

    def _encode_text(self, sentence):
        tokens, eot = self.text.encode_text([sentence])
        return tokens[0].float().cpu().numpy(), eot[0].float().cpu().numpy()

    @property
    def editing(self):
        """하이라이트·추천 엔진. UniVTG를 올려야 해서 처음 요청이 올 때 만든다."""
        if self._editing is None:
            from editing_api import EditingEngine
            self._editing = EditingEngine(self, cfg, CLIP_PT, tracker.report)
        return self._editing

    def ground(self, path, queries):
        """영상 특징은 DB 캐시를, 질문은 시맨틱 캐시(비슷한 질문의 이전 결과)를 먼저 본다. 나머지 질문은 한 묶음으로 모델에 넣는다."""
        results = self.multiquery.run(path, queries)
        tracker.report("ground", 1.0)
        for r in results:
            print(f"[revision] {r.query!r}: {r.source}" + (f" (sim {r.similarity:.3f}, ~ {r.matched_query!r})" if r.source == "semantic_cache" and r.similarity else ""), flush=True)
        duration = self.store.get(path).duration
        return duration, [None if r.start_time is None else {"query": r.query, "start": r.start_time, "end": r.end_time, "source": r.source} for r in results]


engine = None


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send(200, {"status": "ok", "device": DEVICE})
        elif parsed.path == "/progress":
            request_id = (parse_qs(parsed.query).get("id") or [""])[0]
            state = tracker.get(request_id)
            self._send(200 if state else 404, state or {"error": "unknown request id"})
        else:
            self._send(404, {"error": "not found"})

    def _editing_request(self):
        """/highlights, /recommend: 같은 GPU와 영상 특징을 쓰므로 /ground와 같은 잠금 안에서 한 번에 하나씩 처리한다."""
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            path = body.get("video_path")
            title = body.get("title")
            request_id = body.get("request_id") if isinstance(body.get("request_id"), str) else None
            if not isinstance(path, str) or not os.path.isfile(path):
                self._send(400, {"error": f"video_path not found: {path}"})
                return
            if title is not None and not isinstance(title, str):
                self._send(400, {"error": "title must be a string"})
                return
            with lock, gpu_lock():  # gpu_lock: Whisper(GPU 서버)와 겹치지 않게
                started = time.time()
                tracker.begin(request_id, "highlights" if self.path == "/highlights" else "recommend")
                try:
                    if self.path == "/highlights":
                        result = engine.editing.highlights(path, title)
                    elif self.path == "/scenario":
                        result = engine.editing.scenario(path, title)
                    else:
                        result = {"scenes": engine.editing.recommend(path, title)}
                finally:
                    tracker.finish()
                    gc.collect()
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
            print(f"[revision] {self.path} on {os.path.basename(path)} in {time.time() - started:.1f}s", flush=True)
            self._send(200, result)
        except Exception as error:
            import traceback
            traceback.print_exc()
            self._send(500, {"error": str(error)})

    def do_POST(self):
        if self.path in ("/highlights", "/recommend", "/scenario"):
            self._editing_request()
            return
        if self.path != "/ground":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            path = body.get("video_path")
            queries = body.get("queries")
            if not isinstance(path, str) or not os.path.isfile(path):
                self._send(400, {"error": f"video_path not found: {path}"})
                return
            if not isinstance(queries, list) or not queries or not all(isinstance(q, str) and q.strip() for q in queries):
                self._send(400, {"error": "queries must be a non-empty list of strings"})
                return
            request_id = body.get("request_id") if isinstance(body.get("request_id"), str) else None
            window = body.get("window", DEFAULT_WINDOW)
            if isinstance(window, bool) or not isinstance(window, int) or not 10 <= window <= 2000:
                self._send(400, {"error": "window must be an integer between 10 and 2000 (seconds)"})
                return
            with lock, gpu_lock():  # gpu_lock: Whisper(GPU 서버)와 겹치지 않게
                started = time.time()
                grounder_module.DEBUG_WINDOW = window
                tracker.begin(request_id, "ground")
                try:
                    duration, results = engine.ground(path, queries)
                finally:
                    tracker.finish()
                    # 같은 GPU를 쓰는 Whisper(자동 자막)가 올라갈 수 있게 요청이 끝나면 임시 메모리를 반환한다.
                    gc.collect()
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
            print(f"[revision] {len(queries)} queries on {os.path.basename(path)} "
                  f"({duration:.1f}s video, window {window}s) in {time.time() - started:.1f}s", flush=True)
            self._send(200, {"duration": duration, "results": results})
        except Exception as error:
            import traceback
            traceback.print_exc()
            self._send(500, {"error": str(error)})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    with gpu_lock():
        engine = Engine()
    print(f"[revision] listening on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()  # /health, /progress는 처리 중에도 응답한다
