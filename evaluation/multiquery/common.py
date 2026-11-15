"""ReVisionLLM Feature Caching / Multi-Query 평가용 공통 코드.

측정 대상은 ClipCraft-AI(ReVisionLLM)의 실제 코드다. 이 폴더의 스크립트는 그 코드를 고치지 않고, 인스턴스에 측정용 래퍼만 씌운다.
  - FeatureCache.get        : SHA-256 -> DB -> vision.npy / audio.npy (없으면 CLIP + CLAP 추출 후 저장)
  - MultiQueryGrounder.run  : batched=False 는 질문마다 grounding 1회, batched=True 는 질문을 묶어 ground_many 1회
  - Grounder.ground_many    : (질문 x 창) 행을 query_batch개씩 모델 forward 1회로 처리

측정 규칙
  - 시간은 time.perf_counter(). 구간을 재기 전후와 모델 forward(inference) 전후에 torch.cuda.synchronize()를 호출한다.
  - 모델 로딩 시간은 재지 않는다(모델은 한 번만 올리고 추출기를 모든 조건이 공유한다). 측정 전에 한 번 워밍업한다.
  - 측정용 DB 행은 PostgreSQL의 별도 schema(clipcraft_eval)와 별도 cache_dir에만 쓴다. 운영 DB는 건드리지 않는다.
"""
import contextlib
import json
import math
import os
import shutil
import time
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = os.path.expanduser("~/clipcraft/ClipCraft-AI")
EVAL_SCHEMA = "clipcraft_eval"
MIN_FREE_GPU_GIB = 18.0   # R2(Vicuna-7B bf16) + CLIP x2 + CLAP


# ----------------------------------------------------------------------------------------------------------------------
# 시간 측정
# ----------------------------------------------------------------------------------------------------------------------
def sync() -> None:
    """GPU 비동기 실행이 끝나기를 기다린다(GPU가 없으면 아무것도 안 한다)."""
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.synchronize()
    except ImportError:
        pass


class Stopwatch:
    """with Stopwatch() as sw: ...  ->  sw.elapsed (초). 시작 전과 끝난 뒤에 GPU를 동기화한다."""

    def __enter__(self):
        sync()
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, *exc):
        sync()
        self.elapsed = time.perf_counter() - self.t0
        return False


class Meter:
    """구성 요소별 누적 시간과 호출 횟수. 래퍼는 호출 전후에 GPU를 동기화한다."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.seconds: Dict[str, float] = {}
        self.calls: Dict[str, int] = {}

    def add(self, name: str, seconds: float = 0.0, calls: int = 1):
        self.seconds[name] = self.seconds.get(name, 0.0) + seconds
        self.calls[name] = self.calls.get(name, 0) + calls

    def wrap(self, name: str, fn: Callable) -> Callable:
        def wrapped(*args, **kwargs):
            sync()
            t0 = time.perf_counter()
            try:
                return fn(*args, **kwargs)
            finally:
                sync()
                self.add(name, time.perf_counter() - t0)
        return wrapped

    def snapshot(self) -> dict:
        return {"seconds": {k: round(v, 4) for k, v in self.seconds.items()}, "calls": dict(self.calls)}


# ----------------------------------------------------------------------------------------------------------------------
# 측정 대상 묶음
# ----------------------------------------------------------------------------------------------------------------------
@dataclass
class System:
    video: str
    svc: object                       # MultiQueryGrounder (또는 같은 모양의 객체): .run(video, queries, semantic, batched), .features
    shared: object                    # 서버 단위 공유 Feature Cache (FeatureCache). .get(video)
    unshared: object                  # 캐시를 쓰지 않고 매번 추출하는 Feature 공급자. .get(video)
    meter: Meter
    reset_shared_cache: Callable[[], None]   # 공유 캐시를 비워 "첫 요청"이 추출하게 만든다
    query_batch: int
    info: dict


def load_queries(path: str, n: Optional[int] = None) -> List[str]:
    with open(path, encoding="utf-8") as f:
        queries = [line.strip() for line in f if line.strip()]
    if n is not None and len(queries) < n:
        raise SystemExit(f"{path}에 질문이 {len(queries)}개뿐이라 {n}개를 쓸 수 없어요.")
    return queries[:n] if n is not None else queries


def run_sequential(system: System, queries: Sequence[str]) -> list:
    """질문을 하나씩 따로 처리(질문마다 grounding 1회). Baseline / Feature Cache가 쓴다."""
    out = []
    for q in queries:
        out += system.svc.run(system.video, [q], semantic=False, batched=False)
    return out


def run_batched(system: System, queries: Sequence[str]) -> list:
    """질문을 한 요청으로 묶어 ground_many로 배치 처리. Multi-Query (+ Batch)가 쓴다."""
    return system.svc.run(system.video, list(queries), semantic=False, batched=True)


def segments_of(results) -> list:
    return [(r.start_time, r.end_time) for r in results]


def max_segment_diff(a, b) -> Optional[float]:
    """같은 질문 목록의 두 결과가 얼마나 다른지(초, 시작/끝 중 최대). 둘 다 못 찾은 질문은 건너뛴다."""
    diffs = []
    for x, y in zip(a, b):
        if x[0] is None or y[0] is None:
            if (x[0] is None) != (y[0] is None):
                return math.inf
            continue
        diffs.append(max(abs(x[0] - y[0]), abs(x[1] - y[1])))
    return max(diffs) if diffs else 0.0


# ----------------------------------------------------------------------------------------------------------------------
# 통계 / 결과 저장 / 그림
# ----------------------------------------------------------------------------------------------------------------------
def mean_std(values: Sequence[float]):
    n = len(values)
    mean = sum(values) / n
    std = math.sqrt(sum((v - mean) ** 2 for v in values) / (n - 1)) if n > 1 else 0.0
    return mean, std


def load_trials(path: str) -> list:
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)["trials"]
    return []


def save_trials(path: str, meta: dict, trials: list) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "trials": trials}, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def line_plot(path: str, x_values: Sequence[int], series: Dict[str, Dict[str, list]], xlabel: str, ylabel: str, title: str,
              log_y: bool = False) -> None:
    """series[label] = {"mean": [...], "std": [...]}. 선 그래프(평균)와 표준편차 막대."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    markers = ["o", "s", "^", "D"]
    fig, ax = plt.subplots(figsize=(7.2, 4.6), dpi=160)
    for (label, data), marker in zip(series.items(), markers):
        ax.errorbar(x_values, data["mean"], yerr=data["std"], marker=marker, linewidth=2, markersize=6, capsize=3, label=label)
    ax.set_xticks(list(x_values))
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    ax.set_title(title)
    if log_y:
        ax.set_yscale("log")
    ax.grid(True, alpha=0.3)
    ax.legend()
    fig.tight_layout()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fig.savefig(path)
    plt.close(fig)


def write_csv(path: str, header: Sequence[str], rows: Sequence[Sequence]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(",".join(header) + "\n")
        for row in rows:
            f.write(",".join(f"{v:.4f}" if isinstance(v, float) else str(v) for v in row) + "\n")


# ----------------------------------------------------------------------------------------------------------------------
# 실제 ReVisionLLM 파이프라인 구성
# ----------------------------------------------------------------------------------------------------------------------
class _TimedFeatures:
    """features.get 한 번(해시 + DB 조회 + 파일 읽기, 또는 추출)의 시간을 'features_get'로 잰다."""

    def __init__(self, inner, meter: Meter):
        self.inner = inner
        self.get = meter.wrap("features_get", inner.get)


def build_real_system(video: str, query_batch: int, window: Optional[int], root: str = DEFAULT_ROOT,
                      cache_dir: Optional[str] = None, force: bool = False) -> System:
    """모델을 한 번 올리고, 현재 프로젝트의 FeatureCache / MultiQueryGrounder를 그대로 구성한다."""
    root = os.path.abspath(os.environ.get("REVISION_ROOT", root))
    os.chdir(root)  # ReVision 코드가 상대 경로(checkpoints/...)를 쓴다
    import sys
    sys.path.insert(0, root)

    dsn = os.environ.get("CLIPCRAFT_DB_DSN")
    if not dsn:
        raise SystemExit("CLIPCRAFT_DB_DSN이 필요해요. 예: set -a; . /etc/clipcraft/db.env; set +a")

    import torch
    if not torch.cuda.is_available():
        raise SystemExit("CUDA GPU가 필요해요.")
    free_gib = torch.cuda.mem_get_info()[0] / 2**30
    if free_gib < MIN_FREE_GPU_GIB and not force:
        raise SystemExit(f"GPU 여유 메모리가 {free_gib:.1f} GiB뿐이에요(필요 {MIN_FREE_GPU_GIB:.0f} GiB). "
                         "운영 중인 ReVision 서비스(clipcraft-revision)가 GPU를 쓰고 있으면 평가하는 동안 멈춰야 해요.")

    import psycopg
    from revisionllm.data.audio_pipeline.extract_clap import ClapAudioExtractor
    from revisionllm.data.audio_pipeline.extract_clip import ClipFrameExtractor
    from revisionllm.multiquery import grounder as grounder_module
    from revisionllm.multiquery.config import CacheConfig
    from revisionllm.multiquery.db import CacheDB
    from revisionllm.multiquery.feature_cache import FeatureCache, VideoFeatures, probe_duration, sha256_file
    from revisionllm.multiquery.grounder import Grounder, model_args
    from revisionllm.multiquery.service import MultiQueryGrounder, TextEncoder, model_version_of

    clip_pt = "checkpoints/clip/ViT-L-14.pt"
    vicuna = "checkpoints/vicuna-7b-v1.5"
    stage2 = "checkpoints/audio_charades_long/stageB_R2_seed0"
    stage1_proj = "checkpoints/vtimellm-vicuna-v1-5-7b-stage1/mm_projector.bin"
    clip_adapter = "checkpoints/public/chapters_stage1_sparse/non_lora_trainables.bin"

    # 운영 DB의 video / query_cache 표와 섞이지 않게 별도 schema에서 같은 표를 만든다(vector 확장은 public).
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(f"CREATE SCHEMA IF NOT EXISTS {EVAL_SCHEMA}")
    cfg = CacheConfig()
    cfg.dsn = dsn + ("&" if "?" in dsn else "?") + f"options=-csearch_path%3D{EVAL_SCHEMA}%2Cpublic"
    cfg.cache_dir = os.path.abspath(cache_dir or os.path.join(HERE, ".cache", "features"))
    os.makedirs(cfg.cache_dir, exist_ok=True)

    if window is not None:
        grounder_module.DEBUG_WINDOW = window   # 운영 서버가 요청마다 하는 것과 같은 설정(ReVision 코드의 모듈 변수)

    meter = Meter()
    device = "cuda"
    db = CacheDB(cfg.dsn, cfg.embedding_dim)
    grounder = Grounder(model_args(clip_pt, vicuna, stage2, stage1_proj, clip_adapter, cfg), cfg)
    text = TextEncoder(clip_pt)
    # 추출기는 한 번만 올려 모든 조건이 공유한다(운영 서버의 FeatureStore와 같은 방식). 모델 로딩은 측정에 들어가지 않는다.
    clip_frames = ClipFrameExtractor(clip_pt, fps=cfg.feature_fps, device=device)
    clap = ClapAudioExtractor(cfg.clap_name, hop_sec=cfg.audio_hop_sec, device=device)

    cache = FeatureCache(cfg, db, clip_pt)
    cache._clip, cache._clap = clip_frames, clap
    cache._extract = meter.wrap("extract", cache._extract)         # 실제로 수행된 Feature Extraction만 센다(시간 포함)

    class NoCacheFeatures:
        """캐시를 쓰지 않는 공급자: 요청마다 FeatureCache와 같은 추출 함수를 다시 실행한다(저장도 조회도 하지 않는다)."""

        def get(self, path):
            vision, audio = cache._extract(path)
            return VideoFeatures(-1, "nocache", vision, audio, probe_duration(path), False)

    video_hash = sha256_file(video)

    def reset_shared_cache():
        db.conn.execute("DELETE FROM video WHERE video_hash=%s", (video_hash,))   # query_cache는 ON DELETE CASCADE
        shutil.rmtree(os.path.join(cfg.cache_dir, video_hash), ignore_errors=True)

    # GPU inference(forward) 전후로 동기화하고 forward 횟수를 센다. ReVision 코드는 그대로 두고 모듈의 inference 이름만 감싼다.
    original_inference = grounder_module.inference

    def timed_inference(*args, **kwargs):
        sync()
        t0 = time.perf_counter()
        try:
            return original_inference(*args, **kwargs)
        finally:
            sync()
            meter.add("inference", time.perf_counter() - t0)

    grounder_module.inference = timed_inference
    grounder.ground_many = meter.wrap("ground", grounder.ground_many)
    grounder.prepare = meter.wrap("prepare", grounder.prepare)

    svc = MultiQueryGrounder(cfg, clip_pt, grounder, model_version_of(stage2), db=db, text=meter.wrap("text_encode", text),
                             query_batch=query_batch)
    system = System(video=video, svc=svc, shared=_TimedFeatures(cache, meter), unshared=_TimedFeatures(NoCacheFeatures(), meter),
                    meter=meter, reset_shared_cache=reset_shared_cache, query_batch=query_batch,
                    info={"video": os.path.basename(video), "video_sha256": video_hash, "query_batch": query_batch,
                          "debug_window": grounder_module.DEBUG_WINDOW, "num_frames": grounder_module.NUM_FRAMES,
                          "model_version": model_version_of(stage2), "feature_version": cfg.feature_version,
                          "gpu": torch.cuda.get_device_name(0), "torch": torch.__version__})
    return system


def warm_up(system: System, queries: Sequence[str]) -> None:
    """CUDA 초기화, 커널 선택, 첫 호출 비용이 첫 측정에 섞이지 않도록 모든 경로를 한 번 돌려 둔다(측정하지 않는다)."""
    system.svc.features = system.unshared
    run_sequential(system, queries[:1])
    system.reset_shared_cache()
    system.svc.features = system.shared
    run_batched(system, queries[:2])
    system.reset_shared_cache()
    system.meter.reset()
