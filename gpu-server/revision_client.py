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


def ground(video_path: str, queries: List[str], timeout: float = 1800.0) -> List[Optional[dict]]:
    """질문(영어)마다 {"start", "end"} 또는 None을 같은 순서로 돌려준다."""
    request = urllib.request.Request(
        f"{REVISION_URL}/ground",
        data=json.dumps({"video_path": video_path, "queries": queries}).encode(),
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
