"""Experiment 1. Multi-Query Processing: 같은 영상에 질문 1 / 5 / 10 / 20개를 넣었을 때 전체 처리 시간.

  1. Baseline            질문마다 독립 처리. 질문마다 Visual/Audio Feature를 다시 추출하고 질문을 순차 처리한다.
  2. Feature Cache       Feature는 처음 한 번만 추출해 저장하고, 모든 질문이 저장된 Feature를 읽어 쓴다. 질문은 순차 처리한다.
  3. Multi-Query (+Batch) 저장된 Feature를 쓰고, 질문들을 한 묶음으로 만들어 ground_many로 배치 처리한다.

모든 조건에서 시맨틱 질문 캐시(query_cache)는 끈다(semantic=False). 이 실험은 Feature 캐시와 배치 처리의 효과만 본다.
Feature Cache / Multi-Query 조건은 시행마다 캐시를 비우고 시작하므로, 첫 질문의 Feature 추출 시간이 전체 시간에 포함된다.

사용법(운영 ReVision 서비스가 GPU를 쓰고 있으면 먼저 멈춘다. README.md 참고):
  set -a; . /etc/clipcraft/db.env; set +a
  ~/clipcraft/.venv/bin/python exp1_multi_query.py --video /path/to/video.mp4
"""
import argparse
import os

from common import (HERE, Stopwatch, build_real_system, line_plot, load_queries, load_trials, max_segment_diff, mean_std,
                    run_batched, run_sequential, save_trials, segments_of, warm_up, write_csv)

CONDITIONS = ["Baseline", "Feature Cache", "Multi-Query (+ Batch)"]


def run_condition(system, name, queries):
    """한 조건을 처음부터 끝까지 한 번 실행하고 측정 결과를 돌려준다."""
    system.meter.reset()
    if name == "Baseline":
        system.svc.features = system.unshared          # 캐시 없음: 질문마다 추출
        with Stopwatch() as sw:
            results = run_sequential(system, queries)
    elif name == "Feature Cache":
        system.reset_shared_cache()                    # 첫 질문이 추출하도록 캐시를 비운다
        system.svc.features = system.shared
        with Stopwatch() as sw:
            results = run_sequential(system, queries)
    elif name == "Multi-Query (+ Batch)":
        system.reset_shared_cache()
        system.svc.features = system.shared
        with Stopwatch() as sw:
            results = run_batched(system, queries)
    else:
        raise ValueError(name)
    snap = system.meter.snapshot()
    return {
        "total_s": sw.elapsed,
        "feature_extractions": snap["calls"].get("extract", 0),
        "forward_passes": snap["calls"].get("inference", 0),
        "breakdown_s": snap["seconds"],
        "segments": segments_of(results),
    }


def summarize(trials, counts, out_dir):
    rows, series = [], {}
    for name in CONDITIONS:
        means, stds = [], []
        for n in counts:
            sel = [t for t in trials if t["condition"] == name and t["n_queries"] == n]
            if not sel:
                means.append(float("nan")); stds.append(0.0)
                continue
            mean, std = mean_std([t["total_s"] for t in sel])
            means.append(mean); stds.append(std)
            rows.append([name, n, len(sel), mean, std, min(t["total_s"] for t in sel), max(t["total_s"] for t in sel),
                         sum(t["feature_extractions"] for t in sel) / len(sel), sum(t["forward_passes"] for t in sel) / len(sel)])
        series[name] = {"mean": means, "std": stds}
    write_csv(os.path.join(out_dir, "exp1_summary.csv"),
              ["condition", "n_queries", "repeats", "mean_total_s", "std_total_s", "min_total_s", "max_total_s",
               "mean_feature_extractions", "mean_forward_passes"], rows)
    line_plot(os.path.join(out_dir, "exp1_multi_query.png"), counts, series, "Number of Queries", "Total Processing Time (s)",
              "Experiment 1. Multi-Query Processing (same video, same query set)")
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", required=True, help="모든 조건에 쓰는 같은 영상")
    ap.add_argument("--queries_file", default=os.path.join(HERE, "queries.txt"))
    ap.add_argument("--counts", default="1,5,10,20", help="질문 개수(앞에서부터 N개를 쓴다)")
    ap.add_argument("--repeats", type=int, default=3, help="조건마다 반복 횟수(3 이상)")
    ap.add_argument("--query_batch", type=int, default=8, help="forward 1회에 넣는 (질문 x 창) 행 수. 서비스 기본값 8")
    ap.add_argument("--window", type=int, default=None, help="모델 창 길이(초). 비우면 ReVisionLLM 기본값")
    ap.add_argument("--out_dir", default=os.path.join(HERE, "results"))
    ap.add_argument("--resume", action="store_true", help="이미 끝난 시행은 건너뛴다")
    ap.add_argument("--force", action="store_true", help="GPU 여유 메모리 검사를 건너뛴다")
    a = ap.parse_args()
    counts = [int(x) for x in a.counts.split(",")]
    if a.repeats < 3:
        ap.error("--repeats는 3 이상이어야 해요.")
    queries = load_queries(a.queries_file, max(counts))

    system = build_real_system(a.video, a.query_batch, a.window, force=a.force)
    raw_path = os.path.join(a.out_dir, "exp1_raw.json")
    trials = load_trials(raw_path) if a.resume else []
    meta = {"experiment": "exp1_multi_query", "counts": counts, "repeats": a.repeats, "queries": queries[:max(counts)],
            "system": system.info, "conditions": CONDITIONS}

    print("[exp1] warm-up (not measured)", flush=True)
    warm_up(system, queries)

    done = {(t["condition"], t["n_queries"], t["repeat"]) for t in trials}
    for rep in range(a.repeats):
        # 조건의 실행 순서를 반복마다 돌려서 순서 효과(GPU 온도, 페이지 캐시)가 한 조건에 몰리지 않게 한다.
        order = CONDITIONS[rep % len(CONDITIONS):] + CONDITIONS[:rep % len(CONDITIONS)]
        for n in counts:
            for name in order:
                if (name, n, rep) in done:
                    continue
                trial = run_condition(system, name, queries[:n])
                trial.update({"condition": name, "n_queries": n, "repeat": rep})
                trials.append(trial)
                save_trials(raw_path, meta, trials)
                print(f"[exp1] rep={rep} N={n:2d} {name:22s} total={trial['total_s']:8.2f}s "
                      f"extractions={trial['feature_extractions']:2d} forwards={trial['forward_passes']:3d}", flush=True)

    rows = summarize(trials, counts, a.out_dir)
    print("\ncondition, N, repeats, mean(s), std(s), min, max, extractions, forwards")
    for r in rows:
        print(", ".join(f"{v:.2f}" if isinstance(v, float) else str(v) for v in r))

    # 조건끼리 같은 구간을 돌려주는지(배치·패딩의 수치 차이) 확인한다.
    print("\nsegment agreement with Baseline (max |start/end difference| in seconds, per N and repeat)")
    for n in counts:
        for rep in range(a.repeats):
            base = next((t for t in trials if t["condition"] == "Baseline" and t["n_queries"] == n and t["repeat"] == rep), None)
            if base is None:
                continue
            for name in CONDITIONS[1:]:
                other = next((t for t in trials if t["condition"] == name and t["n_queries"] == n and t["repeat"] == rep), None)
                if other is not None:
                    print(f"  N={n:2d} rep={rep} {name:22s} max_diff={max_segment_diff(base['segments'], other['segments']):.2f}s")


if __name__ == "__main__":
    main()
