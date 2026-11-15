"""평가 스크립트의 측정 로직(조건 구성, Feature Extraction 횟수, 결과 파일)을 가짜 파이프라인으로 검사한다.

실제 모델·GPU는 쓰지 않는다. 여기서 나온 시간은 아무 의미가 없으므로 results/ 가 아니라 임시 폴더에만 쓴다.
  ~/clipcraft/.venv/bin/python test_harness.py
"""
import math
import os
import tempfile
import time
from types import SimpleNamespace

import common
import exp1_multi_query as exp1
import exp2_multi_user_cache as exp2

QUERY_BATCH = 8


def fake_system():
    meter = common.Meter()
    stored = {}

    def extract(path):
        time.sleep(0.02)
        return object(), object()

    extract = meter.wrap("extract", extract)

    class Unshared:
        def get(self, path):
            extract(path)
            return SimpleNamespace(cache_hit=False)

    class Shared:
        def get(self, path):
            if path not in stored:
                extract(path)
                stored[path] = True
                return SimpleNamespace(cache_hit=False)
            return SimpleNamespace(cache_hit=True)

    class Svc:
        features = None

        def run(self, video, queries, semantic=True, batched=True):
            assert semantic is False, "시맨틱 질문 캐시는 꺼야 한다"
            self.features.get(video)
            forwards = math.ceil(len(queries) / QUERY_BATCH) if batched else len(queries)
            for _ in range(forwards):
                meter.wrap("inference", lambda: time.sleep(0.005))()
            return [SimpleNamespace(start_time=1.0, end_time=2.0) for _ in queries]

    return common.System(video="fake.mp4", svc=Svc(), shared=Shared(), unshared=Unshared(), meter=meter,
                         reset_shared_cache=stored.clear, query_batch=QUERY_BATCH, info={})


def check_exp1(system, queries):
    for n in (1, 5, 10, 20):
        base = exp1.run_condition(system, "Baseline", queries[:n])
        cache = exp1.run_condition(system, "Feature Cache", queries[:n])
        multi = exp1.run_condition(system, "Multi-Query (+ Batch)", queries[:n])
        assert base["feature_extractions"] == n, base
        assert cache["feature_extractions"] == 1, cache
        assert multi["feature_extractions"] == 1, multi
        assert base["forward_passes"] == cache["forward_passes"] == n
        assert multi["forward_passes"] == math.ceil(n / QUERY_BATCH)
        assert len(base["segments"]) == len(cache["segments"]) == len(multi["segments"]) == n
        assert base["total_s"] > 0
    print("exp1 conditions OK")


def check_exp2(system, queries):
    assert exp2.user_queries(queries, 0, 5) == queries[:5]
    assert exp2.user_queries(queries, 3, 5) == queries[15:20]
    assert exp2.user_queries(queries, 4, 5) == queries[:5]          # 목록 끝에서 처음으로 이어진다
    for users in (1, 2, 5, 10):
        without = exp2.run_condition(system, "Without Shared Cache", queries, users, 5)
        shared = exp2.run_condition(system, "With Shared Cache", queries, users, 5)
        assert without["feature_extractions"] == users, without
        assert shared["feature_extractions"] == 1, shared
        assert len(without["user_latency_s"]) == len(shared["user_latency_s"]) == users
    print("exp2 conditions OK")


def check_outputs(system, queries):
    with tempfile.TemporaryDirectory() as tmp:
        trials = []
        for rep in range(3):
            for n in (1, 5, 10, 20):
                for name in exp1.CONDITIONS:
                    t = exp1.run_condition(system, name, queries[:n])
                    t.update({"condition": name, "n_queries": n, "repeat": rep})
                    trials.append(t)
        rows = exp1.summarize(trials, [1, 5, 10, 20], tmp)
        assert len(rows) == 12
        trials = []
        for rep in range(3):
            for u in (1, 2, 5, 10):
                for name in exp2.CONDITIONS:
                    t = exp2.run_condition(system, name, queries, u, 5)
                    t.update({"condition": name, "n_users": u, "repeat": rep})
                    trials.append(t)
        rows = exp2.summarize(trials, [1, 2, 5, 10], tmp)
        assert len(rows) == 8
        for f in ("exp1_summary.csv", "exp1_multi_query.png", "exp2_summary.csv", "exp2_multi_user.png", "exp2_feature_extraction_count.png"):
            assert os.path.getsize(os.path.join(tmp, f)) > 0, f
        common.save_trials(os.path.join(tmp, "raw.json"), {"x": 1}, trials)
        assert len(common.load_trials(os.path.join(tmp, "raw.json"))) == len(trials)
    print("summaries, plots and raw files OK")


if __name__ == "__main__":
    queries = common.load_queries(os.path.join(common.HERE, "queries.txt"))
    assert len(queries) >= 20
    system = fake_system()
    check_exp1(system, queries)
    check_exp2(system, queries)
    check_outputs(system, queries)
    print("all harness checks passed")
