"""ReVision 구간 탐색 서비스(revision/revision_server.py) 호출용 클라이언트."""
import json
import os
import urllib.error
import urllib.request
from typing import List, Optional

REVISION_URL = os.environ.get("REVISION_URL", "http://127.0.0.1:8002").rstrip("/")


def is_available(timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(f"{REVISION_URL}/health", timeout=timeout) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError):
        return False


def ground(video_path: str, queries: List[str], timeout: float = 1800.0, request_id: Optional[str] = None) -> List[Optional[dict]]:
    """질문(영어)마다 {"start", "end"} 또는 None을 같은 순서로 돌려준다."""
    request = urllib.request.Request(
        f"{REVISION_URL}/ground",
        data=json.dumps({"video_path": video_path, "queries": queries, "request_id": request_id}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        try:
            detail = json.load(error).get("error")
        except ValueError:
            detail = None
        raise RuntimeError(f"ReVision 서비스 오류: {detail or error.code}") from error
    return payload["results"]


def _post(path: str, payload: dict, timeout: float) -> dict:
    request = urllib.request.Request(
        f"{REVISION_URL}{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            detail = json.load(error).get("error")
        except ValueError:
            detail = None
        raise RuntimeError(f"ReVision 서비스 오류: {detail or error.code}") from error


def highlights(video_path: str, title: Optional[str] = None, timeout: float = 1800.0, request_id: Optional[str] = None) -> dict:
    """영상 전체에서 하이라이트 구간을 찾는다. {"duration", "highlights": [{"id","start","end","label"}]}"""
    return _post("/highlights", {"video_path": video_path, "title": title, "request_id": request_id}, timeout)


def recommend(video_path: str, title: Optional[str] = None, timeout: float = 900.0, request_id: Optional[str] = None) -> List[dict]:
    """영상을 보고 찾아볼 만한 장면을 추천한다. [{"text": 장면 이름(한국어), "start": 초, "end": 초}]"""
    return _post("/recommend", {"video_path": video_path, "title": title, "request_id": request_id}, timeout)["scenes"]


def progress(request_id: str, timeout: float = 2.0) -> Optional[dict]:
    """ReVision 서비스가 이 요청에서 지금 하는 일. {"stage", "sub", "fraction", "detail", "done"} 또는 (알 수 없으면) None."""
    try:
        with urllib.request.urlopen(f"{REVISION_URL}/progress?id={request_id}", timeout=timeout) as response:
            return json.load(response)
    except (urllib.error.URLError, OSError, ValueError):
        return None
