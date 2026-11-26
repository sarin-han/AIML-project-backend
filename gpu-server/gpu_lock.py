"""GPU 서버(Whisper)와 ReVision 서비스가 GPU를 차례로 쓰게 하는 프로세스 간 잠금.

두 서비스는 별도 프로세스라 threading.Lock으로는 서로를 막지 못하고, 동시에 돌면 GPU 메모리가 모자란다(CUDA OOM).
같은 잠금 파일에 flock을 걸어 한 번에 한 작업만 GPU를 쓰게 한다. 프로세스가 죽으면 커널이 잠금을 풀어 준다.
두 서비스가 같은 파일을 봐야 하므로 경로를 바꿀 때는 CLIPCRAFT_GPU_LOCK을 양쪽에 똑같이 설정한다.
같은 스레드에서 겹쳐 잡으면 멈추므로(재진입 불가) 잠금 안에서 다시 잡지 않는다.
"""
import fcntl
import os
import time
from contextlib import contextmanager

LOCK_PATH = os.environ.get("CLIPCRAFT_GPU_LOCK") or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".gpu.lock")


@contextmanager
def gpu_lock():
    # 호출할 때마다 새로 열어야 같은 프로세스의 다른 스레드끼리도 서로 기다린다.
    fd = os.open(LOCK_PATH, os.O_RDWR | os.O_CREAT, 0o666)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("[gpu-lock] 다른 작업이 GPU를 쓰는 중이라 기다립니다.", flush=True)
            started = time.time()
            fcntl.flock(fd, fcntl.LOCK_EX)
            print(f"[gpu-lock] {time.time() - started:.1f}초 기다린 뒤 시작합니다.", flush=True)
        yield
    finally:
        os.close(fd)  # 닫으면 잠금도 풀린다
