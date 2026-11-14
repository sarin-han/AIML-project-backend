"""ReVisionLLM 구간 탐색 서비스 (별도 프로세스).

GPU 서버(server.py)와 파이썬 패키지 버전이 달라서(transformers 4.41.2 등) 같은 프로세스에 넣지 않고,
ReVision 환경(예: /shareHost/minyoy/venvs/revaudio)에서 따로 띄운 뒤 HTTP로 부른다.

    REVISION_ROOT=/shareHost/jiyes/ClipCraft-AI \
    /shareHost/minyoy/venvs/revaudio/bin/python revision_server.py

POST /ground  {"video_path": "...", "queries": ["영어 질문", ...], "window": 60(선택, 초)}
           -> {"duration": 12.3, "results": [{"query": "...", "start": 1.0, "end": 4.5} | null, ...]}
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
from http.server import BaseHTTPRequestHandler, HTTPServer

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

CLIP_PT = os.path.join(ROOT, "checkpoints/clip/ViT-L-14.pt")
VICUNA = os.path.join(ROOT, "checkpoints/vicuna-7b-v1.5")
STAGE2 = os.path.join(ROOT, "checkpoints/audio_charades_long/stageB_R2_seed0")
STAGE1_PROJ = os.path.join(ROOT, "checkpoints/vtimellm-vicuna-v1-5-7b-stage1/mm_projector.bin")
CLIP_ADAPTER = os.path.join(ROOT, "checkpoints/public/chapters_stage1_sparse/non_lora_trainables.bin")

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
cfg = CacheConfig()
lock = threading.Lock()


class Engine:
    def __init__(self):
        t0 = time.time()
        self.clip_frames = ClipFrameExtractor(CLIP_PT, fps=cfg.feature_fps, device=DEVICE)
        self.clap = ClapAudioExtractor(cfg.clap_name, hop_sec=cfg.audio_hop_sec, device=DEVICE)
        self.text = ClipFeatureExtractor(framerate=30, size=224, centercrop=True,
                                         model_name_or_path=CLIP_PT, device=DEVICE)
        self.grounder = Grounder(model_args(CLIP_PT, VICUNA, STAGE2, STAGE1_PROJ, CLIP_ADAPTER, cfg), cfg)
        self.features = OrderedDict()  # (path, size, mtime_ns) -> (vision, audio, duration)
        print(f"[revision] models loaded in {time.time() - t0:.1f}s on {DEVICE}", flush=True)

    def video_features(self, path):
        st = os.stat(path)
        key = (path, st.st_size, st.st_mtime_ns)
        if key in self.features:
            self.features.move_to_end(key)
            return self.features[key]
        duration = float(ffmpeg.probe(path)["format"]["duration"])
        np.random.seed(0)  # CLAP 전처리가 무작위 mel 구간을 뽑으므로 재현성을 위해 고정
        vision = self.clip_frames(path)
        try:
            audio = self.clap(path)
        except Exception as error:  # 오디오 스트림이 없는 영상: 모델에는 0 오디오가 들어간다
            print(f"[revision] no audio features for {path}: {error}", flush=True)
            audio = None
        self.features[key] = (vision, audio, duration)
        while len(self.features) > FEATURE_CACHE_SIZE:
            self.features.popitem(last=False)
        return self.features[key]

    def ground(self, path, queries):
        vision, audio, duration = self.video_features(path)

        class Feats:
            pass

        feats = Feats()
        feats.vision, feats.audio, feats.duration = vision, audio, duration
        items = []
        for query in queries:
            sentence = norm_sentence(query)
            tokens, eot = self.text.encode_text([sentence])
            items.append((sentence, tokens[0].float().cpu().numpy(), eot[0].float().cpu().numpy()))
        segments = self.grounder.ground_many(self.grounder.prepare(feats), items)
        results = [None if seg is None else {"query": q, "start": seg[0], "end": seg[1]}
                   for q, seg in zip(queries, segments)]
        return duration, results


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
        if self.path == "/health":
            self._send(200, {"status": "ok", "device": DEVICE})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
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
            window = body.get("window", DEFAULT_WINDOW)
            if isinstance(window, bool) or not isinstance(window, int) or not 10 <= window <= 2000:
                self._send(400, {"error": "window must be an integer between 10 and 2000 (seconds)"})
                return
            with lock:
                started = time.time()
                grounder_module.DEBUG_WINDOW = window
                try:
                    duration, results = engine.ground(path, queries)
                finally:
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
    engine = Engine()
    print(f"[revision] listening on http://{HOST}:{PORT}", flush=True)
    HTTPServer((HOST, PORT), Handler).serve_forever()
