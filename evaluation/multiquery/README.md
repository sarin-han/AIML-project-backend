# ReVisionLLM Feature Caching / Multi-Query 평가

ClipCraft-AI(ReVisionLLM)의 `revisionllm/multiquery` 코드를 **수정하지 않고** 그대로 실행해 시간을 재는 평가 스크립트입니다.
측정 대상은 `FeatureCache`(영상 SHA-256 → DB → `vision.npy`/`audio.npy`), `MultiQueryGrounder.run`
(`batched=False`: 질문마다 grounding 1회 / `batched=True`: 질문을 묶어 `ground_many` 1회), `Grounder.ground_many`입니다.
결과 숫자는 모두 실제 파이프라인을 돌려서 얻으며, 스크립트가 값을 만들어 내는 경로는 없습니다.

| 파일 | 내용 |
| --- | --- |
| `exp1_multi_query.py` | 실험 1. 질문 1/5/10/20개 × (Baseline, Feature Cache, Multi-Query + Batch) |
| `exp2_multi_user_cache.py` | 실험 2. 사용자 1/2/5/10명 × (Without / With Shared Cache) |
| `common.py` | 파이프라인 구성, 시간 측정(`perf_counter` + `cuda.synchronize`), 통계, 그림 |
| `queries.txt` | 질문 20개(두 실험이 같은 목록을 씁니다. 영상에 맞게 바꿔도 됩니다) |
| `test_harness.py` | 가짜 파이프라인으로 측정 로직만 검사(모델·GPU 불필요, 결과는 임시 폴더) |

## 실행 전 준비

R2 체크포인트(Vicuna-7B bf16) + CLIP 2개 + CLAP이 GPU 메모리 약 17 GiB를 씁니다. 운영 중인 ReVision 서비스가 이미 GPU를
쓰고 있으면 메모리가 모자라서(스크립트가 여유 18 GiB 미만이면 멈춥니다) **평가하는 동안 서비스를 멈춰야 합니다.**

```bash
sudo systemctl stop clipcraft-revision     # 평가 중에는 영상 분석 기능(ReVision)을 쓸 수 없습니다
cd evaluation/multiquery
set -a; . /etc/clipcraft/db.env; set +a    # CLIPCRAFT_DB_DSN (운영 DB의 별도 schema clipcraft_eval에만 씁니다)

~/clipcraft/.venv/bin/python exp1_multi_query.py       --video /path/to/video.mp4
~/clipcraft/.venv/bin/python exp2_multi_user_cache.py  --video /path/to/video.mp4
sudo systemctl start clipcraft-revision
```

옵션: `--repeats 3`(기본, 3 이상), `--counts 1,5,10,20`, `--users 1,2,5,10`, `--queries_per_user 5`,
`--query_batch 8`(forward 1회의 (질문 × 창) 행 수, 서비스 기본값), `--window`(모델 창 길이), `--resume`(중단했던 실험 이어서).

## 측정 방법

- 시간은 `time.perf_counter()`. 구간을 재기 전후와 모델 forward(`inference`) 전후에 `torch.cuda.synchronize()`를 호출합니다.
- 모델 로딩은 재지 않습니다(모델과 CLIP/CLAP 추출기는 한 번만 올려 모든 조건이 공유). 측정 전에 모든 경로를 한 번 워밍업합니다.
- 같은 영상, 같은 질문 목록(앞에서 N개)을 모든 조건에 씁니다. 조건당 3회 이상 반복해서 평균과 표준편차를 냅니다.
  반복마다 조건 실행 순서를 돌려서 순서 효과가 한 조건에 몰리지 않게 합니다.
- **시맨틱 질문 캐시(`query_cache`)는 모든 조건에서 끕니다**(`semantic=False`). Feature 캐시와 배치 처리 효과만 보려는 것이고,
  비슷한 질문이 서로의 결과를 재사용하면 효과가 가려지기 때문입니다.
- Feature Cache / Multi-Query / With Shared Cache 조건은 시행마다 캐시(DB 행 + 파일)를 비우고 시작하므로, 첫 요청의
  Feature 추출 시간이 전체 시간에 포함됩니다. 이후 요청의 캐시 조회 비용(영상 해시, DB 조회, `.npy` 읽기)도 포함됩니다.
- Baseline / Without Shared Cache는 `FeatureCache`와 같은 추출 함수(`_extract`)를 요청마다 다시 실행합니다(저장·조회 없음).
- 실험 2의 요청은 운영 ReVision 서비스처럼 한 번에 하나씩 처리합니다(서비스가 `generate`의 스레드 안전성 때문에 잠금을 겁니다).
  사용자마다 같은 개수의 질문을 한 요청으로 보내며, 사용자 u는 질문 목록의 u × k 번째부터 k개를 씁니다.
- Feature Extraction 횟수는 `_extract`가 실제로 실행된 횟수입니다.
- 운영 서버의 `FeatureStore`가 `FeatureCache` 앞에 두는 메모리 LRU(최근 2개 영상)는 쓰지 않습니다. 순수한 DB + 파일 캐시만 잽니다.
- OS 페이지 캐시는 비우지 않습니다. 영상 파일과 `.npy`는 첫 시행 이후 메모리에서 읽힐 수 있고, 모든 조건에 같게 작용합니다.

## 결과 (`results/`)

| 파일 | 내용 |
| --- | --- |
| `exp1_multi_query.png` | X: 질문 수(1, 5, 10, 20), Y: Total Processing Time(s), 선 3개(표준편차 막대) |
| `exp1_summary.csv`, `exp1_raw.json` | 평균/표준편차/최소/최대, 추출 횟수, forward 횟수, 구성 요소별 시간, 반환 구간 |
| `exp2_multi_user.png` | X: 사용자 수(1, 2, 5, 10), Y: Total Processing Time(s), 선 2개 |
| `exp2_feature_extraction_count.png` | 사용자 수에 따른 Feature Extraction 횟수 |
| `exp2_summary.csv`, `exp2_raw.json` | 평균/표준편차, 추출 횟수, 사용자별 지연, 구성 요소별 시간 |

실험 1은 끝에 Baseline 대비 반환 구간의 최대 차이도 출력합니다. 단, 이 모델은 **같은 입력으로 같은 파이프라인을 두 번 돌려도
반환 구간이 달라질 수 있습니다**(Feature는 두 번 추출해도 비트 단위로 같지만, bf16 GPU 생성 결과가 실행마다 약간, 가끔은 크게 달라집니다.
점검 때 같은 4개 질문을 두 번 돌리자 한 질문의 끝이 1.2초 달랐고 다른 실행에서는 한 질문이 299.4초와 242.9초로 갈렸습니다).
따라서 조건 사이의 구간 차이는 배치 처리의 영향으로만 볼 수 없고, 이 실험의 결론은 처리 시간에 대한 것입니다.
