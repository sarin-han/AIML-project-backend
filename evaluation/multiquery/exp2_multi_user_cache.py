"""Experiment 2. Multi-User Feature Caching: 같은 영상을 검색하는 사용자가 1 / 2 / 5 / 10명일 때 서버 단위 Feature Cache 공유 효과.

  Without Shared Cache  각 사용자의 요청마다 그 영상의 Visual/Audio Feature를 새로 추출한다.
  With Shared Cache     첫 요청에서만 추출해 서버(DB + 디스크)에 저장하고, 이후 사용자는 저장된 Feature를 읽어 쓴다.

사용자는 모두 같은 개수(--queries_per_user)의 질문을 한 요청으로 보낸다. 요청은 운영 ReVision 서비스와 같이 한 번에 하나씩
처리한다(서비스가 모델 generate의 스레드 안전성 때문에 잠금을 건다). 사용자 u는 질문 목록에서 u * k 번째부터 k개를 쓴다
(목록 끝에서 처음으로 이어진다). 시맨틱 질문 캐시는 끈다(semantic=False). 사용자끼리 비슷한 질문이 서로의 결과를 재사용해서
Feature Cache 효과가 가려지지 않게 하려는 것이다. 측정 지표는 전체 처리 시간과 실제로 수행된 Feature Extraction 횟수다.

사용법(운영 ReVision 서비스가 GPU를 쓰고 있으면 먼저 멈춘다. README.md 참고):
  set -a; . /etc/clipcraft/db.env; set +a
  ~/clipcraft/.venv/bin/python exp2_multi_user_cache.py --video /path/to/video.mp4
"""
import argparse
import os

from common import (HERE, Stopwatch, build_real_system, line_plot, load_queries, load_trials, mean_std, run_batched, save_trials,
                    segments_of, warm_up, write_csv)

CONDITIONS = ["Without Shared Cache", "With Shared Cache"]


def user_queries(all_queries, user, per_user):
    return [all_queries[(user * per_user + j) % len(all_queries)] for j in range(per_user)]


def run_condition(system, name, all_queries, users, per_user):
    system.meter.reset()
    if name == "Without Shared Cache":
        system.svc.features = system.unshared          # 사용자마다 처음부터 추출
    else:
        system.reset_shared_cache()                    # 첫 사용자의 요청이 추출하도록 서버 캐시를 비운다
        system.svc.features = system.shared
    latencies, results = [], []
    with Stopwatch() as total:
        for u in range(users):
            with Stopwatch() as request:
                results.append(segments_of(run_batched(system, user_queries(all_queries, u, per_user))))
            latencies.append(request.elapsed)
    snap = system.meter.snapshot()
    return {
        "total_s": total.elapsed,
        "feature_extractions": snap["calls"].get("extract", 0),
        "forward_passes": snap["calls"].get("inference", 0),
        "user_latency_s": latencies,
        "breakdown_s": snap["seconds"],
        "segments": results,
    }


def summarize(trials, user_counts, out_dir):
    rows, time_series, count_series = [], {}, {}
    for name in CONDITIONS:
        t_mean, t_std, c_mean = [], [], []
        for u in user_counts:
            sel = [t for t in trials if t["condition"] == name and t["n_users"] == u]
            if not sel:
                t_mean.append(float("nan")); t_std.append(0.0); c_mean.append(float("nan"))
                continue
            mean, std = mean_std([t["total_s"] for t in sel])
            extractions = sum(t["feature_extractions"] for t in sel) / len(sel)
            t_mean.append(mean); t_std.append(std); c_mean.append(extractions)
            rows.append([name, u, len(sel), mean, std, min(t["total_s"] for t in sel), max(t["total_s"] for t in sel),
                         extractions, sum(t["forward_passes"] for t in sel) / len(sel)])
        time_series[name] = {"mean": t_mean, "std": t_std}
        count_series[name] = {"mean": c_mean, "std": [0.0] * len(c_mean)}
    write_csv(os.path.join(out_dir, "exp2_summary.csv"),
              ["condition", "n_users", "repeats", "mean_total_s", "std_total_s", "min_total_s", "max_total_s",
               "mean_feature_extractions", "mean_forward_passes"], rows)
    line_plot(os.path.join(out_dir, "exp2_multi_user.png"), user_counts, time_series, "Number of Users", "Total Processing Time (s)",
              "Experiment 2. Multi-User Feature Caching (same video)")
    line_plot(os.path.join(out_dir, "exp2_feature_extraction_count.png"), user_counts, count_series, "Number of Users",
              "Feature Extraction Count", "Experiment 2. Feature Extraction Count")
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", required=True, help="모든 사용자가 검색하는 같은 영상")
    ap.add_argument("--queries_file", default=os.path.join(HERE, "queries.txt"))
    ap.add_argument("--users", default="1,2,5,10", help="사용자 수")
    ap.add_argument("--queries_per_user", type=int, default=5, help="사용자마다 같은 개수의 질문")
    ap.add_argument("--repeats", type=int, default=3, help="조건마다 반복 횟수(3 이상)")
    ap.add_argument("--query_batch", type=int, default=8, help="forward 1회에 넣는 (질문 x 창) 행 수. 서비스 기본값 8")
    ap.add_argument("--window", type=int, default=None, help="모델 창 길이(초). 비우면 ReVisionLLM 기본값")
    ap.add_argument("--out_dir", default=os.path.join(HERE, "results"))
    ap.add_argument("--resume", action="store_true", help="이미 끝난 시행은 건너뛴다")
    ap.add_argument("--force", action="store_true", help="GPU 여유 메모리 검사를 건너뛴다")
    a = ap.parse_args()
    user_counts = [int(x) for x in a.users.split(",")]
    if a.repeats < 3:
        ap.error("--repeats는 3 이상이어야 해요.")
    all_queries = load_queries(a.queries_file)

    system = build_real_system(a.video, a.query_batch, a.window, force=a.force)
    raw_path = os.path.join(a.out_dir, "exp2_raw.json")
    trials = load_trials(raw_path) if a.resume else []
    meta = {"experiment": "exp2_multi_user_cache", "users": user_counts, "queries_per_user": a.queries_per_user,
            "repeats": a.repeats, "queries": all_queries, "system": system.info, "conditions": CONDITIONS}

    print("[exp2] warm-up (not measured)", flush=True)
    warm_up(system, all_queries)

    done = {(t["condition"], t["n_users"], t["repeat"]) for t in trials}
    for rep in range(a.repeats):
        order = CONDITIONS[rep % 2:] + CONDITIONS[:rep % 2]
        for u in user_counts:
            for name in order:
                if (name, u, rep) in done:
                    continue
                trial = run_condition(system, name, all_queries, u, a.queries_per_user)
                trial.update({"condition": name, "n_users": u, "repeat": rep, "queries_per_user": a.queries_per_user})
                trials.append(trial)
                save_trials(raw_path, meta, trials)
                print(f"[exp2] rep={rep} users={u:2d} {name:22s} total={trial['total_s']:8.2f}s "
                      f"extractions={trial['feature_extractions']:2d} forwards={trial['forward_passes']:3d}", flush=True)

    rows = summarize(trials, user_counts, a.out_dir)
    print("\ncondition, users, repeats, mean(s), std(s), min, max, extractions, forwards")
    for r in rows:
        print(", ".join(f"{v:.2f}" if isinstance(v, float) else str(v) for v in r))


if __name__ == "__main__":
    main()
