import glob
import os
import subprocess
import tempfile
import threading
from typing import Callable, Optional

WHISPER_MODEL_PATH = os.environ.get("WHISPER_MODEL_PATH", "")
WHISPER_CACHE_GLOB = "/shareHost/jiye_model/models--Systran--faster-whisper-large-v3/snapshots/*"

_model = None
_model_lock = threading.Lock()


def _resolve_model_path() -> str:
    if WHISPER_MODEL_PATH:
        return WHISPER_MODEL_PATH

    snapshots = sorted(glob.glob(WHISPER_CACHE_GLOB))
    if not snapshots:
        raise RuntimeError("Whisper 모델을 찾을 수 없습니다. WHISPER_MODEL_PATH를 설정하세요.")
    return snapshots[-1]


def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from faster_whisper import WhisperModel

                _model = WhisperModel(_resolve_model_path(), device="cuda", compute_type="float16")
    return _model


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
    model = get_model()

    with tempfile.TemporaryDirectory() as tmp_dir:
        wav_path = os.path.join(tmp_dir, "audio.wav")
        _extract_audio(ffmpeg, video_path, wav_path)

        segments, info = model.transcribe(
            wav_path,
            language=language,
            vad_filter=True,
            beam_size=5,
            condition_on_previous_text=False,
        )

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
