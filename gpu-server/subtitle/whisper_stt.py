import glob
import os
import subprocess
import tempfile
from contextlib import contextmanager
from typing import Callable, Optional

from gpu_lock import gpu_lock

WHISPER_MODEL_PATH = os.environ.get("WHISPER_MODEL_PATH", "")
WHISPER_CACHE_GLOB = "/shareHost/jiye_model/models--Systran--faster-whisper-large-v3/snapshots/*"


def _resolve_model_path() -> str:
    if WHISPER_MODEL_PATH:
        return WHISPER_MODEL_PATH

    snapshots = sorted(glob.glob(WHISPER_CACHE_GLOB))
    if not snapshots:
        raise RuntimeError("Whisper 모델을 찾을 수 없습니다. WHISPER_MODEL_PATH를 설정하세요.")
    return snapshots[-1]


def _preload_cuda_libs() -> None:
    """pip(nvidia-*-cu12)로 설치된 CUDA 라이브러리는 LD_LIBRARY_PATH에 없어서 faster-whisper가
    'libcublas.so.12 is not found' 오류를 낼 수 있다. 모델을 불러오기 전에 직접 로드해 둔다."""
    import ctypes
    import importlib.util

    for package, names in (("nvidia.cublas", ("libcublas.so.12",)), ("nvidia.cudnn", ("libcudnn.so.9", "libcudnn.so.8"))):
        try:
            spec = importlib.util.find_spec(package)
        except (ImportError, ValueError):
            continue
        locations = list(spec.submodule_search_locations or []) if spec else []
        for location in locations:
            for name in names:
                path = os.path.join(location, "lib", name)
                if os.path.exists(path):
                    try:
                        ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
                    except OSError:
                        pass
                    break


@contextmanager
def _loaded_model():
    """Whisper를 GPU에 올려 빌려주고, 작업이 끝나면(실패해도) 내린다.

    같은 GPU를 ReVision 서비스가 함께 써서, 약 4GB인 Whisper를 계속 올려 두면 시나리오 탐색이 CUDA OOM으로 실패한다.
    GPU 잠금을 올릴 때부터 내릴 때까지 잡아서 ReVision 작업이나 다른 자막 작업과 겹치지 않게 한다."""
    with gpu_lock():
        _preload_cuda_libs()
        from faster_whisper import WhisperModel

        model = WhisperModel(_resolve_model_path(), device="cuda", compute_type="float16")
        try:
            yield model
        finally:
            # 예외의 traceback 등이 객체를 붙잡고 있어도 GPU 메모리는 바로 반환되도록 명시적으로 내린다.
            model.model.unload_model()


def _extract_audio(ffmpeg: str, video_path: str, wav_path: str) -> None:
    command = [ffmpeg, "-v", "error", "-y", "-i", video_path, "-vn", "-ac", "1", "-ar", "16000", wav_path]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"오디오 추출에 실패했습니다: {result.stderr.strip()[:200]}")


def transcribe_video(
    ffmpeg: str,
    video_path: str,
    language: Optional[str] = "ko",
    on_progress: Optional[Callable[[float], None]] = None,
) -> list[dict]:
    """영상의 음성을 인식해 [{id, start, end, text}] 구간 목록으로 반환한다."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        wav_path = os.path.join(tmp_dir, "audio.wav")
        _extract_audio(ffmpeg, video_path, wav_path)

        with _loaded_model() as model:
            segments, info = model.transcribe(
                wav_path,
                language=language,
                vad_filter=True,
                beam_size=5,
                condition_on_previous_text=False,
            )

            # segments는 순회할 때 인식이 진행되므로 모델을 내리기 전에 모두 읽는다.
            results = []
            for segment in segments:
                text = segment.text.strip()
                if not text:
                    continue

                results.append(
                    {
                        "id": len(results) + 1,
                        "start": round(float(segment.start), 2),
                        "end": round(float(segment.end), 2),
                        "text": text,
                    }
                )
                if on_progress and info.duration:
                    on_progress(min(1.0, float(segment.end) / float(info.duration)))

    return results
