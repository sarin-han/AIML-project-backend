# LangGraph Editing Agent 설계

## 1. 왜 LangGraph를 쓰는가

자연어 편집은 LLM을 한 번 호출하는 것으로 끝나지 않습니다. 이전 대화를 기억해야 하고, 애매하면 되물어야 하며, 삭제 같은 큰 변경은 실행 전에 확인을 받아야 합니다. LangGraph는 이 다단계 흐름을 노드(작업 단계)와 엣지(다음 단계로 가는 규칙)로 이루어진 그래프로 명시합니다.

| LangGraph 기능 | ClipCraft에서의 쓰임 |
|---|---|
| **State + Checkpointer** | 프로젝트별 `thread_id`로 State를 저장합니다. 요청이 끝나도 최근 편집이 남아 "그 장면", "방금 수정한 부분"을 해석할 수 있습니다. |
| **조건부 엣지** | "의도 불명확 → 되묻기", "삭제 → 확인" 같은 분기가 if문 속에 숨지 않고 그래프에 드러납니다. |
| **interrupt()** | 확인이 필요하면 그래프를 멈추고 사용자의 승인을 기다렸다가, 멈춘 지점부터 다시 실행합니다. |
| **노드 단위 분리** | 의도 파악, 클립 선택, 명령 생성을 따로 테스트하고 개선할 수 있습니다. |

## 2. LangGraph를 쓸 때와 안 쓸 때

자연어 편집은 요청이 한 번에 끝나지 않는 경우가 많습니다.

```
사용자: 마지막 장면 삭제해줘
AI:     scene_05를 삭제할까요?
사용자: 응
```

서버가 받는 두 번째 요청은 "응"이라는 글자뿐입니다. 이 대답을 처리하려면 "지금 scene_05 삭제 승인을 기다리는 중"이라는 사실을 기억하고 있다가, 멈춘 단계부터 이어서 실행해야 합니다. "그 장면 2배속"도 마찬가지로 직전 편집을 기억해야 처리할 수 있습니다.

| 필요한 기능 | LangGraph 없이 | LangGraph 사용 |
|---|---|---|
| 맥락 기억 | 프로젝트별 상태를 저장하고 불러오는 코드를 직접 구현합니다. | checkpointer가 `thread_id`별로 State를 자동으로 저장·복원합니다. |
| 확인 후 재개 | "무엇을 기다리는 중인지" 변수를 따로 두고, 대답이 오면 해당 단계로 직접 분기해야 합니다. | `interrupt()`로 멈추고, `Command(resume=…)`로 멈춘 자리부터 이어서 실행합니다. |
| 분기 관리 | 되묻기와 확인 조건이 if문 안에 흩어져 전체 흐름이 잘 보이지 않습니다. | 조건부 엣지로 그래프에 명시되어 흐름을 한눈에 볼 수 있습니다. |
| 테스트·확장 | 하나의 긴 함수가 되어 일부만 시험하거나 단계를 추가하기 어렵습니다. | 노드 단위로 시험하고, 새 노드(예: 번역)를 엣지로 연결해 추가합니다. |
| 실행 추적 | 단계별 로그를 직접 남겨야 합니다. | 노드마다 State가 어떻게 바뀌었는지 그대로 확인할 수 있습니다. |

LangGraph 없이도 같은 기능을 만들 수는 있습니다. 하지만 맥락 저장, 중단 후 재개, 분기 관리를 모두 직접 구현해야 합니다. LangGraph를 사용하면 이 부분을 프레임워크에 맡기고, 각 노드가 해야 할 일(의도 파악, 클립 선택, 명령 생성)에 집중할 수 있습니다.

## 3. 노드 구성

노드는 기능 하나를 맡는 단계입니다. 각 노드는 State에서 필요한 칸을 읽고, 처리 결과로 State의 일부 칸을 바꿉니다. 노드끼리 값을 직접 주고받지 않고, 앞 노드가 State에 남긴 값을 뒤 노드가 읽는 방식으로 이어집니다. 다음에 어느 노드로 갈지는 조건부 엣지가 State를 보고 결정합니다.

> 표기: 노드 이름은 대문자로 시작하고(`SelectClip`), State 칸 이름은 소문자와 `_`를 씁니다(`target_clip`).

```
START → Understand → SelectClip → BuildCommand → END
            │             │             ├─ 검증 실패 → Clarify → END
            │             │             └─ 삭제 등 큰 변경 → Confirm → END
            │             └─ 대상 모호 → Clarify
            └─ 의도 불명확 → Clarify
```

| 노드 | 하는 일 | 다음 단계 (조건부 엣지) |
|---|---|---|
| **Understand** | gpt-4o-mini로 문장을 편집 의도로 정리합니다. 한 문장에 편집이 여러 개면 나눕니다. | 의도 불명확 → Clarify / 그 외 → SelectClip |
| **SelectClip** | "클립 2", "마지막 장면", "준비 장면", "그 장면" 같은 표현을 실제 클립 id로 바꿉니다. 번호·위치는 `clip_list` 순서로, 설명은 클립 label과 비교해서, 지시어는 `last_edited`로 찾습니다. | 대상 없음·후보 여러 개 → Clarify / 그 외 → BuildCommand |
| **BuildCommand** | 편집 명령 JSON을 만들고 없는 클립, 영상 길이 초과, 클립 겹침을 검사합니다. 직접 편집하지 않으며, 실제 반영은 프론트의 명령 실행기가 합니다. | 검사 실패 → Clarify / 삭제 등 큰 변경 → Confirm / 정상 → END |
| **Clarify** | 무엇이 애매한지 사용자에게 되묻습니다. 답변은 다음 요청으로 들어와 이전 맥락과 함께 처리됩니다. | END |
| **Confirm** | `interrupt()`로 그래프를 멈추고 승인을 기다립니다. 사용자가 확인하면 같은 `thread_id`로 재개 요청이 오고, 멈춘 자리부터 이어서 실행됩니다. | END |

## 4. State 구성 (EditState)

State는 그래프의 모든 노드가 함께 읽고 바꾸는 데이터 묶음입니다. checkpointer가 프로젝트별 `thread_id`로 State를 저장하므로, 요청이 끝나도 다음 요청에서 이전 값을 이어받습니다.

| State | 담기는 것 | 요청 사이에 |
|---|---|---|
| `message_log` | 대화 기록 | 계속 쌓임 |
| `clip_list` | 현재 클립·자막 목록 (프론트가 요청마다 보냄) | 매번 최신으로 덮어씀 |
| `request` | 편집 의도 (예: TRIM_END, 10s, "클립 2") | 매번 새로 |
| `target_clip` | 대상 클립 id | 매번 새로 |
| `last_edited` | 직전에 편집한 클립 id | **다음 요청까지 유지** |
| `commands` | 변경 명령 JSON | 매번 새로 |

`clip_list`는 Agent가 따로 보관하지 않고 매 요청마다 프론트에서 받습니다. 실제 편집 상태의 기준(source of truth)은 프론트의 Timeline State이고, 사용자가 마우스로 직접 편집할 수도 있기 때문입니다.

## 5. 노드별 읽는 State와 State 변화

모든 요청은 시작할 때 `message_log`에 사용자 문장이 추가되고, `clip_list`가 프론트의 최신 목록으로 바뀝니다. 아래 예시는 **"클립 2 끝 10초 잘라줘"** 요청 하나가 처리되는 과정입니다. 표를 위에서 아래로 읽으면 각 노드를 지나면서 State가 어떻게 바뀌는지 볼 수 있습니다.

| 노드 | 읽는 State | State 변화 |
|---|---|---|
| Understand | `message_log` | `request`: 비어 있음 → `[TRIM_END, 10s, "클립 2"]` |
| SelectClip | `request`, `clip_list`, `last_edited` | `target_clip`: 비어 있음 → `["scene_02"]` |
| BuildCommand | `request`, `target_clip`, `clip_list` | `commands`: 비어 있음 → `[SET_END, scene_02]`<br>`last_edited`: 이전 클립 → `"scene_02"` |
| Clarify | (애매한 이유) | `message_log`: 기존 대화 → + "어느 장면인가요?" |
| Confirm | `commands` | `commands`: 승인하면 그대로 / 거절하면 → `[]` |

※ Clarify와 Confirm은 분기했을 때만 실행됩니다. 위 요청은 정상 편집이므로 Understand → SelectClip → BuildCommand → END 순서로 끝납니다.

이어서 같은 프로젝트에서 **"그 장면 2배속 해줘"**를 보내면, 이전 요청에서 BuildCommand가 바꿔 둔 `last_edited = "scene_02"`가 State에 남아 있습니다. SelectClip은 "그 장면"이 지시어이므로 이 값을 읽어 `target_clip`을 `["scene_02"]`로 바꿉니다. 이것이 LangGraph의 State와 checkpointer로 이전 맥락을 이어받는 방식입니다.
