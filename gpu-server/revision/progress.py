"""ReVision 서비스가 실제로 하고 있는 일을 요청 단위로 기록한다 (GET /progress?id=...).

요청은 한 번에 하나씩 처리되므로(revision_server의 잠금) 지금 처리 중인 요청 하나만 추적한다.
단계마다 전체 진행의 몇 %를 차지하는지(STAGE_RANGES)는 3분짜리 영상(A10G)에서 잰 소요 시간 비율을 바탕으로 한 근사값이다.
영상이 길수록 디코딩·CLIP 비율이 커지므로 단계 사이의 간격은 영상마다 다를 수 있다.
단계 안쪽의 진행(프레임 배치, 장면 설명 n/m, 모델 행 n/m)은 실제 처리한 양이다.
"""
import threading
import time
from collections import OrderedDict
from typing import Dict, Optional, Tuple

# 작업 종류 -> 단계 -> (시작, 끝). 0~1.
STAGE_RANGES: Dict[str, Dict[str, Tuple[float, float]]] = {
    "highlights": {
        "decode": (0.00, 0.20), "clip": (0.20, 0.27), "audio": (0.27, 0.52),
        "score": (0.52, 0.62), "plan": (0.62, 0.64), "caption": (0.64, 0.96), "name": (0.96, 1.00),
    },
    "recommend": {
        "decode": (0.00, 0.20), "clip": (0.20, 0.27), "audio": (0.27, 0.52),
        "score": (0.52, 0.62), "plan": (0.62, 0.66), "caption": (0.66, 0.96), "name": (0.96, 1.00),
    },
    "ground": {
        "decode": (0.00, 0.05), "clip": (0.05, 0.08), "audio": (0.08, 0.14), "ground": (0.14, 1.00),
    },
}

_MAX_KEPT = 50


class Progress:
    def __init__(self):
        self._lock = threading.Lock()
        self._jobs: "OrderedDict[str, dict]" = OrderedDict()
        self._current: Optional[Tuple[str, str]] = None   # (request id, 작업 종류)

    def begin(self, request_id: Optional[str], op: str) -> None:
        with self._lock:
            if not request_id:
                self._current = None
                return
            self._current = (request_id, op)
            self._jobs[request_id] = {"op": op, "stage": "queued", "sub": 0.0, "fraction": 0.0, "detail": "", "done": False, "updated": time.time()}
            while len(self._jobs) > _MAX_KEPT:
                self._jobs.popitem(last=False)

    def report(self, stage: str, sub: float = 0.0, detail: str = "") -> None:
        """stage 안에서 sub(0~1)만큼 진행했다. 처리 중인 요청이 없거나 이 작업에 없는 단계면 무시한다."""
        with self._lock:
            if self._current is None:
                return
            request_id, op = self._current
            low_high = STAGE_RANGES.get(op, {}).get(stage)
            job = self._jobs.get(request_id)
            if low_high is None or job is None:
                return
            sub = min(1.0, max(0.0, float(sub)))
            low, high = low_high
            fraction = max(job["fraction"], low + (high - low) * sub)   # 뒤로 가지 않는다
            job.update(stage=stage, sub=sub, fraction=fraction, detail=detail, updated=time.time())

    def finish(self) -> None:
        with self._lock:
            if self._current is None:
                return
            job = self._jobs.get(self._current[0])
            if job is not None:
                job.update(fraction=1.0, done=True, updated=time.time())
            self._current = None

    def get(self, request_id: str) -> Optional[dict]:
        with self._lock:
            job = self._jobs.get(request_id)
            return dict(job) if job else None


tracker = Progress()
