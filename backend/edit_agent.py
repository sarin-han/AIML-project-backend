"""채팅 편집 Agent (LangGraph).

문장 -> Understand(의도) -> SelectClip(대상 클립 id) -> BuildCommand(명령 JSON + 검사) -> 프론트가 적용.
애매하면 Clarify로 되묻고, 삭제처럼 큰 변경은 Confirm에서 interrupt()로 멈춰 승인을 기다린다.
Agent는 편집을 직접 하지 않는다. 편집 상태의 기준은 프론트의 Timeline State이고, clip_list는 요청마다 받는다.
"""
import json
import operator
import re
from typing import Annotated, Any, TypedDict

import httpx
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

MIN_CLIP_SECONDS = 0.5
MESSAGE_LOG_LIMIT = 12  # LLM에 보여 주는 최근 대화 수
YES_WORDS = {"응", "네", "넹", "예", "ㅇㅇ", "ㅇㅋ", "좋아", "그래", "해줘", "해", "삭제해", "ok", "okay", "yes", "y"}
NO_WORDS = {"아니", "아니오", "아니요", "싫어", "취소", "안해", "하지마", "no", "n"}

SUBTITLE_FONTS = ["nanum-gothic", "nanum-gothic-xbold", "gothic-a1", "gothic-a1-black", "plex-kr", "nanum-myeongjo", "black-han-sans", "do-hyeon", "jua", "gowun-dodum", "nanum-pen"]
DELETE_WORDS = re.compile(r"삭제|지워|지우|빼\s*줘|빼줘|빼고|제거|없애|버려|delete|remove|drop", re.IGNORECASE)
CAPTION_REQUEST_WORDS = re.compile(r"자막|달아\s*줘|넣어\s*줘|써\s*줘|해\s*줘")
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")

UNDERSTAND_PROMPT = """You turn a Korean (or English) video-editing request into structured edit intents.
The user edits a list of highlight clips. Clips are numbered 1..N in timeline order.

Actions (fill only the fields each action needs, null for the rest):
- ADJUST_END   seconds: the end of the clip moves by this many seconds (negative = trim/shorten, positive = extend)
- ADJUST_START seconds: the start moves (positive = trim from the front, negative = extend earlier)
- SET_SPEED    speed: playback speed (1 = normal, "2배속" = 2)
- SET_MUTED    muted: true/false
- MOVE         move_to: "first", "last", or a 1-based position as a string like "2"
- SWAP         with: the other clip (same shape as target); swaps the positions of target and with
- DELETE
- ADD_SUBTITLE        text: caption text, attached to the target clip for its whole length ("클립 2에 '진짜 맛있겠다' 자막 달아줘")
- SET_SUBTITLE_TEXT   text: replace the caption text of the target clip
- DELETE_SUBTITLE     remove the caption of the target clip
- MOVE_SUBTITLE       vertical and/or horizontal: where the caption sits ("자막 위로 올려줘" -> vertical=top, "가운데" -> middle)
- STYLE_SUBTITLE      size_factor (e.g. 1.3 for "더 크게", 0.8 for "작게"), color (hex like "#FFD400"), box (true = dark box behind text), font
For caption actions with no clip named ("자막 위로 올려줘"), use target kind all.

Target kinds: number ("클립 2", "두 번째" -> number=2), first, last ("마지막 장면"), last_edited ("그 장면", "방금 수정한 부분", "그거"),
description ("끓이는 장면": copy the user's words into text), all.

Rules:
- One sentence may contain several edits: output one intent per edit, in the order said.
- Numbers refer to the numbering at the moment the user speaks; do not renumber after a MOVE or SWAP.
- Only the last "Request" is to be executed. Earlier conversation is context for resolving words, and its edits are already done: never repeat them.
- Never guess a missing destination, amount or text (e.g. "자막 옮겨줘" without where): output no intents and ask in "unclear".
- A swap is ONE SWAP intent. Never output the mirrored swap (A with B and B with A) or the same edit twice.
- Only output edits the user actually asked for. Do not add extra intents.
- If the request is not an edit, or an action/amount/target cannot be determined, output no intents and put a short Korean clarifying question in "unclear".
- "Last edited" in the input lists the clips the previous request changed. Use target kind last_edited when the request points back at them: "거기", "여기", "그 장면", "방금 그거", "그 클립", "거기에", or "also/too" phrasing such as "자막도 달아줘" / "그리고 자막도" with no clip named.
- When the user answers a clarifying question, combine the answer with the earlier request in the conversation (e.g. earlier "그 장면에 자막 달아줘" + answer "맛있겠다" -> ADD_SUBTITLE text "맛있겠다" on last_edited).
- Output a DELETE only when the user clearly says to delete/remove ("삭제", "지워", "빼줘"). Moving, swapping or trimming is never a delete.
- Use the recent conversation to resolve short replies such as "2번" or "마지막 거".

Examples (intents only):
- "클립 1이랑 3 위치 바꿔줘" -> exactly one intent: SWAP target number 1, with number 3.
- "클립 2를 맨 뒤로" -> one MOVE intent, move_to "last".
- "클립 2 끝 10초 잘라줘" -> one ADJUST_END with seconds -10.
- "클립 2 1초 늘려줘" -> one ADJUST_END with seconds 1.
- "클립 1 삭제하고 클립 2 2배속" -> DELETE (target 1) and SET_SPEED (target 2, speed 2).
- "거기에 '맛있겠다' 자막 달아줘" -> one ADD_SUBTITLE, target last_edited, text "맛있겠다".
- "자막도 달아줘 '시작'" -> one ADD_SUBTITLE, target last_edited, text "시작".
- "그 장면에 자막 달아줘" (no wording given) -> no intents, unclear "자막에 어떤 문구를 넣을까요?".
- "자막 위로 올려줘" -> one MOVE_SUBTITLE, target all, vertical top ("위/아래/가운데/왼쪽/오른쪽" is a given destination).
"""

_TARGET_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["kind", "number", "text"],
    "properties": {
        "kind": {"type": "string", "enum": ["number", "first", "last", "last_edited", "description", "all"]},
        "number": {"type": ["integer", "null"]},
        "text": {"type": ["string", "null"]},
    },
}
UNDERSTAND_SCHEMA = {
    "name": "edit_intents",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["intents", "unclear"],
        "properties": {
            "intents": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["action", "target", "seconds", "speed", "muted", "move_to", "with", "text", "vertical", "horizontal", "size_factor", "color", "box", "font"],
                    "properties": {
                        "action": {"type": "string", "enum": ["ADJUST_END", "ADJUST_START", "SET_SPEED", "SET_MUTED", "MOVE", "SWAP", "DELETE", "ADD_SUBTITLE", "SET_SUBTITLE_TEXT", "DELETE_SUBTITLE", "MOVE_SUBTITLE", "STYLE_SUBTITLE"]},
                        "target": _TARGET_SCHEMA,
                        "seconds": {"type": ["number", "null"]},
                        "speed": {"type": ["number", "null"]},
                        "muted": {"type": ["boolean", "null"]},
                        "move_to": {"type": ["string", "null"]},
                        "with": {"anyOf": [_TARGET_SCHEMA, {"type": "null"}]},
                        "text": {"type": ["string", "null"]},
                        "vertical": {"type": ["string", "null"], "enum": ["top", "middle", "bottom", None]},
                        "horizontal": {"type": ["string", "null"], "enum": ["left", "center", "right", None]},
                        "size_factor": {"type": ["number", "null"]},
                        "color": {"type": ["string", "null"]},
                        "box": {"type": ["boolean", "null"]},
                        "font": {"type": ["string", "null"], "enum": SUBTITLE_FONTS + [None]},
                    },
                },
            },
            "unclear": {"type": ["string", "null"]},
        },
    },
}


def _normalize_target(raw: dict | None) -> dict | None:
    if not isinstance(raw, dict):
        return None
    return {"kind": raw.get("kind"), "value": raw.get("number", raw.get("value")), "text": raw.get("text") or ""}


class EditState(TypedDict, total=False):
    message_log: Annotated[list[dict], operator.add]  # 계속 쌓임
    clip_list: list[dict]  # 요청마다 프론트의 최신 목록으로 덮어씀
    video_duration: float
    request: list[dict]  # 이번 요청의 편집 의도
    unclear: str | None
    target_clip: list[Any]  # 의도마다 해석된 클립 id 목록 (애매하면 None)
    last_edited: list[int]  # 다음 요청까지 유지
    commands: list[dict]
    reply: str
    needs_confirm: bool
    question: str | None


def _batchim(number: int) -> bool:
    """번호를 읽을 때 받침으로 끝나는지(일·삼·육·칠·팔·십)."""
    return number % 10 in {0, 1, 3, 6, 7, 8}


def _eul(number: int) -> str:
    return "을" if _batchim(number) else "를"


def _clip_names(ids: list[int], order: list[int]) -> tuple[str, int]:
    """'클립 2', '클립 1, 3', '모든 클립'과 마지막 번호(조사용)."""
    numbers = sorted(order.index(i) + 1 for i in ids if i in order)
    if not numbers:
        return "클립", 0
    if len(numbers) == len(order) and len(order) > 1:
        return "모든 클립", 1  # "클립"은 ㅂ 받침이라 을/과를 받침 쪽으로 쓴다
    return "클립 " + ", ".join(str(n) for n in numbers), numbers[-1]


def _mmss(value: float) -> str:
    total = int(round(value))
    return f"{total // 60}:{total % 60:02d}"


def describe_commands(commands: list[dict], clip_list: list[dict]) -> str:
    """적용한 편집을 사용자가 말한 방식(클립 번호는 말한 시점 기준)으로 설명한다."""
    order = [clip["id"] for clip in clip_list]
    ranges = {clip["id"]: (clip["start"], clip["end"]) for clip in clip_list}
    sentences: list[str] = []
    groups: dict[str, list[int]] = {}  # 같은 내용의 편집은 클립을 묶어서 한 문장으로

    def add(key: str, clip_id: int) -> None:
        groups.setdefault(key, []).append(clip_id)

    def seconds(value: float) -> str:
        value = abs(value)
        return f"{value:g}초"

    vertical_ko = {"top": "위", "middle": "가운데", "bottom": "아래"}
    horizontal_ko = {"left": "왼쪽", "center": "가운데", "right": "오른쪽"}
    horizontal_to = {"left": "왼쪽으로", "center": "가운데로", "right": "오른쪽으로"}
    vertical_to = {"top": "위로", "middle": "가운데로", "bottom": "아래로"}

    for command in commands:
        kind, clip_id = command["type"], command["clip_id"]
        if kind == "SET_RANGE":
            old_start, old_end = ranges[clip_id]
            ranges[clip_id] = (command["start"], command["end"])
            d_start, d_end = command["start"] - old_start, command["end"] - old_end
            if abs(d_start) > 1e-6 and abs(d_end) > 1e-6:
                add(f"구간을 {_mmss(command['start'])}~{_mmss(command['end'])}로 조정했어요", clip_id)
            elif abs(d_end) > 1e-6:
                add(f"끝을 {seconds(d_end)} {'늘렸어요' if d_end > 0 else '줄였어요'}", clip_id)
            elif abs(d_start) > 1e-6:
                add(f"시작을 {seconds(d_start)} {'줄였어요' if d_start > 0 else '앞으로 늘렸어요'}", clip_id)
        elif kind == "SET_SPEED":
            add("기본 속도로 바꿨어요" if command["speed"] == 1 else f"{command['speed']:g}배속으로 바꿨어요", clip_id)
        elif kind == "SET_MUTED":
            add("음소거했어요" if command["muted"] else "음소거를 풀었어요", clip_id)
        elif kind == "MOVE":
            position = command["to_index"] + 1
            add("맨 앞으로 옮겼어요" if position == 1 else "맨 뒤로 옮겼어요" if position == len(order) else f"{position}번째로 옮겼어요", clip_id)
            order.remove(clip_id)
            order.insert(command["to_index"], clip_id)
        elif kind == "SWAP":
            a, b = order.index(clip_id) + 1, order.index(command["with_clip_id"]) + 1
            sentences.append(f"클립 {a}{'과' if _batchim(a) else '와'} 클립 {b}의 위치를 바꿨어요.")
            i, j = order.index(clip_id), order.index(command["with_clip_id"])
            order[i], order[j] = order[j], order[i]
        elif kind == "DELETE":
            add("삭제했어요", clip_id)
        elif kind == "ADD_SUBTITLE":
            add(f"“{command['text']}” 자막을 달았어요", clip_id)
        elif kind == "SET_SUBTITLE_TEXT":
            add(f"자막 문구를 “{command['text']}”(으)로 바꿨어요", clip_id)
        elif kind == "DELETE_SUBTITLE":
            add("자막을 지웠어요", clip_id)
        elif kind == "MOVE_SUBTITLE":
            vertical, horizontal = command.get("vertical"), command.get("horizontal")
            where = f"{vertical_ko[vertical]} {horizontal_to[horizontal]}" if vertical and horizontal else vertical_to[vertical] if vertical else horizontal_to[horizontal]
            add(f"자막을 {where} 옮겼어요", clip_id)
        elif kind == "STYLE_SUBTITLE":
            parts = []
            if "size_factor" in command:
                parts.append(("글씨 크기를", "크기"))
            if "color" in command:
                parts.append(("글씨 색을", "색"))
            if "box" in command:
                parts.append(("배경 박스를", "박스"))
            if "font" in command:
                parts.append(("글꼴을", "글꼴"))
            if len(parts) == 1:
                add(f"자막 {parts[0][0]} 바꿨어요", clip_id)
            else:
                add(f"자막 {', '.join(name for _, name in parts)}{'을' if parts[-1][1] in ('색', '글꼴') else '를'} 바꿨어요", clip_id)

    # 편집을 말한 순서대로 문장으로 만든다. 클립 번호는 말한 시점 기준이므로 시작 순서(order0)로 센다.
    order0 = [clip["id"] for clip in clip_list]
    for action, ids in groups.items():
        names, last = _clip_names(list(dict.fromkeys(ids)), order0)
        if action.startswith("“") or action.startswith("자막"):
            # 자막 문장: "클립 2에 “…” 자막을 달았어요" / "클립 2 자막을 위로 옮겼어요"
            if action.startswith("“"):
                quote, rest = action.split("” ", 1)
                sentences.append(f"{names}에 {quote}” {rest}.")
            else:
                sentences.append(f"{names} {action}." if not action.startswith("자막 문구") else f"{names}의 {action}.")
        elif action.startswith(("끝을", "시작을", "구간을")):
            sentences.append(f"{names} {action}.")
        elif action in ("삭제했어요", "음소거했어요", "음소거를 풀었어요") or action.endswith("옮겼어요"):
            sentences.append(f"{names}{_eul(last)} {action}.")
        else:
            sentences.append(f"{names}{_eul(last)} {action}.")
    return " ".join(sentences) or f"편집 {len(commands)}건을 적용했어요."


def _clip_summary(clip: dict, index: int) -> str:
    label = clip.get("title") or clip.get("scenario") or ""
    return (
        f"{index}. id={clip['id']} \"{label}\" {clip['start']:.1f}s~{clip['end']:.1f}s "
        f"speed={clip.get('speed', 1)} muted={clip.get('muted', False)}"
        + (f" caption=\"{clip['subtitle']}\"" if clip.get("subtitle") else "")
    )


async def _call_llm(settings: dict, system: str, user: str, schema: dict | None = None) -> dict:
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {settings['api_key']}"},
            json={
                "model": settings["model"],
                "temperature": 0,
                "response_format": {"type": "json_schema", "json_schema": schema} if schema else {"type": "json_object"},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            },
        )
    response.raise_for_status()
    return json.loads(response.json()["choices"][0]["message"]["content"])


GENERIC_WORDS = ("장면", "부분", "구간", "클립", "영상", "scene", "part", "clip")


def _bigrams(text: str) -> set[str]:
    text = text.lower()
    for word in GENERIC_WORDS:  # 모든 클립에 흔한 말은 구분에 도움이 안 된다
        text = text.replace(word, " ")
    compact = re.sub(r"\s+", "", text)
    return {compact[i : i + 2] for i in range(len(compact) - 1)} or ({compact} if compact else set())


def _describe_matches(text: str, clips: list[dict]) -> list[dict]:
    """설명으로 클립 찾기: 글자 2개 단위 겹침이 가장 큰 클립. 동점이면 모두 돌려준다(되묻기용)."""
    query = _bigrams(text)
    scored = []
    for clip in clips:
        label = _bigrams(f"{clip.get('scenario', '')} {clip.get('title') or ''}")
        scored.append((len(query & label) / len(query) if query else 0, clip))
    best = max((score for score, _ in scored), default=0)
    if best < 0.3:
        return []
    return [clip for score, clip in scored if score >= best - 1e-9]


def make_graph(settings: dict):
    """settings: {"api_key": str, "model": str}"""

    async def understand(state: EditState) -> dict:
        clips = state["clip_list"]
        log = state.get("message_log", [])[-MESSAGE_LOG_LIMIT:]
        # 직전 요청에 이어서 처리하지 않고 이번 문장만 따른다. 지난 대화는 직전에 되물은 질문에 대한 답일 때만 보여 준다.
        # ("그 장면" 같은 지시어는 대화가 아니라 last_edited로 해석한다.)
        previous = log[-2] if len(log) >= 2 else None
        answering_question = bool(previous and previous.get("kind") == "clarify")
        history = "\n".join(f"{item['role']}: {item['content']}" for item in log[-3:-1]) if answering_question else ""
        edited_numbers = [i + 1 for i, clip in enumerate(clips) if clip["id"] in state.get("last_edited", [])]
        last_edited_text = ("clip " + ", ".join(map(str, edited_numbers))) if edited_numbers else "none"
        user = (
            "Clips:\n" + "\n".join(_clip_summary(clip, i + 1) for i, clip in enumerate(clips))
            + f"\n\nLast edited: {last_edited_text}"
            + f"\n\nRecent conversation:\n{history or '(none)'}\n\nRequest: {log[-1]['content']}"
        )
        try:
            data = await _call_llm(settings, UNDERSTAND_PROMPT, user, UNDERSTAND_SCHEMA)
        except (httpx.HTTPError, KeyError, IndexError, ValueError, TypeError) as error:
            print(f"[chat-edit] 의도 해석 실패: {error}")
            return {"request": [], "unclear": "요청을 이해하지 못했어요. 다시 말씀해 주시겠어요?"}

        print(f"[chat-edit] {log[-1]['content']!r} -> {json.dumps(data, ensure_ascii=False)}")
        intents = data.get("intents") if isinstance(data.get("intents"), list) else []
        intents = [
            {**item, "target": _normalize_target(item.get("target")), "with": _normalize_target(item.get("with")), "to": item.get("move_to")}
            for item in intents
            if isinstance(item, dict) and isinstance(item.get("target"), dict)
        ]
        # 같은 교환을 뒤집어 한 번 더 내는 경우(A↔B, B↔A)를 막는다. 그대로 적용하면 교환이 취소된다.
        seen_swaps: set[frozenset] = set()
        unique = []
        for item in intents:
            if item.get("action") == "SWAP":
                pair = frozenset(json.dumps(ref, sort_keys=True, ensure_ascii=False) for ref in (item["target"], item["with"]))
                if pair in seen_swaps:
                    continue
                seen_swaps.add(pair)
            unique.append(item)
        # 삭제는 되돌리기 어려운 변경이라, 사용자가 삭제를 뜻하는 말을 했을 때만 인정한다(LLM이 엉뚱하게 끼워 넣는 경우가 있다).
        if not DELETE_WORDS.search(log[-1]["content"]):
            unique = [item for item in unique if item.get("action") != "DELETE"]
        intents = unique
        unclear = data.get("unclear") if isinstance(data.get("unclear"), str) else None
        if not intents:
            unclear = unclear or "어떤 편집을 할지 알려 주시겠어요? 예: “클립 2 끝 10초 잘라줘”"
        return {"request": intents, "unclear": unclear}

    def route_after_understand(state: EditState) -> str:
        return "Clarify" if not state["request"] else "SelectClip"

    def _resolve(ref: dict, state: EditState) -> tuple[list[int] | None, str | None]:
        """대상 표현 하나를 클립 id 목록으로. 못 찾으면 (None, 되묻는 말)."""
        clips = state["clip_list"]
        kind = ref.get("kind")
        if kind == "all":
            return [clip["id"] for clip in clips], None
        if kind == "first":
            return [clips[0]["id"]], None
        if kind == "last":
            return [clips[-1]["id"]], None
        if kind == "number":
            try:
                number = int(ref.get("value"))
            except (TypeError, ValueError):
                return None, "몇 번 클립인지 알려 주시겠어요?"
            if not 1 <= number <= len(clips):
                return None, f"클립 {number}번은 없어요. 현재 클립은 1~{len(clips)}번이에요."
            return [clips[number - 1]["id"]], None
        if kind == "last_edited":
            alive = [clip_id for clip_id in state.get("last_edited", []) if any(c["id"] == clip_id for c in clips)]
            if not alive:
                return None, "어느 장면을 말씀하시는지 알려 주시겠어요? (방금 편집한 장면이 없어요)"
            return alive, None
        if kind == "description":
            matches = _describe_matches(str(ref.get("text", "")), clips)
            if not matches:
                return None, f"“{ref.get('text', '')}”에 해당하는 장면을 찾지 못했어요. 클립 번호로 알려 주시겠어요?"
            if len(matches) > 1:
                numbers = ", ".join(str(clips.index(clip) + 1) for clip in matches)
                return None, f"“{ref.get('text', '')}”에 해당할 수 있는 장면이 여러 개예요 (클립 {numbers}). 어느 것인가요?"
            return [matches[0]["id"]], None
        return None, "어느 장면인지 알려 주시겠어요?"

    async def select_clip(state: EditState) -> dict:
        targets: list[Any] = []
        for intent in state["request"]:
            ids, question = _resolve(intent["target"], state)
            if ids is None:
                return {"target_clip": [], "unclear": question}
            extra = None
            if intent.get("action") == "SWAP":
                extra, question = _resolve(intent.get("with") or {}, state)
                if extra is None:
                    return {"target_clip": [], "unclear": question}
            targets.append({"ids": ids, "with": extra})
        return {"target_clip": targets, "unclear": None}

    def route_after_select(state: EditState) -> str:
        return "Clarify" if state.get("unclear") else "BuildCommand"

    async def build_command(state: EditState) -> dict:
        # 대상은 말한 시점의 클립 id로 이미 고정돼 있다. 이후 의도는 앞 의도가 반영된 가상 목록에서 검사한다.
        clips = {clip["id"]: dict(clip) for clip in state["clip_list"]}
        order = [clip["id"] for clip in state["clip_list"]]
        duration = float(state.get("video_duration") or 0)
        commands: list[dict] = []
        touched: list[int] = []

        def label(clip_id: int) -> str:
            clip = clips[clip_id]
            return f"클립 {order.index(clip_id) + 1}" if clip_id in order else str(clip.get("scenario", clip_id))

        def overlaps_other(clip_id: int, start: float, end: float) -> bool:
            old = clips[clip_id]
            for other_id, other in clips.items():
                if other_id == clip_id or other_id not in order:
                    continue
                now = start < other["end"] and end > other["start"]
                before = old["start"] < other["end"] and old["end"] > other["start"]
                if now and not before:
                    return True
            return False

        for intent, target in zip(state["request"], state["target_clip"]):
            action = intent.get("action")
            for clip_id in target["ids"]:
                if clip_id not in order:
                    return {"commands": [], "unclear": "이미 삭제된 장면이에요. 다른 장면을 알려 주시겠어요?"}
                clip = clips[clip_id]

                if action in ("ADJUST_END", "ADJUST_START"):
                    try:
                        seconds = float(intent.get("seconds"))
                    except (TypeError, ValueError):
                        return {"commands": [], "unclear": "몇 초인지 알려 주시겠어요?"}
                    start, end = clip["start"], clip["end"]
                    if action == "ADJUST_END":
                        end += seconds
                    else:
                        start += seconds
                    if start < 0 or (duration and end > duration + 1e-6):
                        return {"commands": [], "unclear": f"{label(clip_id)}은 영상 범위(0~{duration:.1f}초)를 벗어나서 조정할 수 없어요."}
                    if end - start < MIN_CLIP_SECONDS:
                        return {"commands": [], "unclear": f"{label(clip_id)}이 너무 짧아져서(최소 {MIN_CLIP_SECONDS}초) 조정할 수 없어요."}
                    if overlaps_other(clip_id, start, end):
                        return {"commands": [], "unclear": f"{label(clip_id)}이 다른 클립과 겹치게 돼서 조정할 수 없어요."}
                    clip["start"], clip["end"] = round(start, 3), round(end, 3)
                    commands.append({"type": "SET_RANGE", "clip_id": clip_id, "start": clip["start"], "end": clip["end"]})

                elif action == "SET_SPEED":
                    try:
                        speed = float(intent.get("speed"))
                    except (TypeError, ValueError):
                        return {"commands": [], "unclear": "몇 배속으로 할까요?"}
                    if not 0.25 <= speed <= 4:
                        return {"commands": [], "unclear": "배속은 0.25배~4배 사이로 지정할 수 있어요."}
                    clip["speed"] = speed
                    commands.append({"type": "SET_SPEED", "clip_id": clip_id, "speed": speed})

                elif action == "SET_MUTED":
                    muted = bool(intent.get("muted", True))
                    clip["muted"] = muted
                    commands.append({"type": "SET_MUTED", "clip_id": clip_id, "muted": muted})

                elif action == "MOVE":
                    to = intent.get("to")
                    if to == "first":
                        index = 0
                    elif to == "last":
                        index = len(order) - 1
                    else:
                        try:
                            index = int(to) - 1
                        except (TypeError, ValueError):
                            return {"commands": [], "unclear": "어느 위치로 옮길까요?"}
                    if not 0 <= index < len(order):
                        return {"commands": [], "unclear": f"위치는 1~{len(order)}번 사이로 지정해 주세요."}
                    order.remove(clip_id)
                    order.insert(index, clip_id)
                    commands.append({"type": "MOVE", "clip_id": clip_id, "to_index": index})

                elif action == "SWAP":
                    others = [other for other in (target["with"] or []) if other in order and other != clip_id]
                    if not others:
                        return {"commands": [], "unclear": "어느 클립과 바꿀까요?"}
                    other_id = others[0]
                    i, j = order.index(clip_id), order.index(other_id)
                    order[i], order[j] = order[j], order[i]
                    # 프론트가 MOVE 두 번으로 적용하지 않도록 한 명령으로 보낸다
                    commands.append({"type": "SWAP", "clip_id": clip_id, "with_clip_id": other_id})
                    touched.append(other_id)

                elif action == "DELETE":
                    order.remove(clip_id)
                    commands.append({"type": "DELETE", "clip_id": clip_id})

                elif action == "ADD_SUBTITLE" or action == "SET_SUBTITLE_TEXT":
                    text = str(intent.get("text") or "").strip()
                    # 문구를 안 줬는데 LLM이 요청 문장 자체를 문구로 쓰는 경우가 있어 막는다
                    if not text or CAPTION_REQUEST_WORDS.search(text):
                        return {"commands": [], "unclear": "자막에 어떤 문구를 넣을까요?"}
                    commands.append({"type": action, "clip_id": clip_id, "text": text})

                elif action == "DELETE_SUBTITLE":
                    commands.append({"type": "DELETE_SUBTITLE", "clip_id": clip_id})

                elif action == "MOVE_SUBTITLE":
                    vertical, horizontal = intent.get("vertical"), intent.get("horizontal")
                    if not vertical and not horizontal:
                        return {"commands": [], "unclear": "자막을 어디로 옮길까요? (위·가운데·아래, 왼쪽·오른쪽)"}
                    command = {"type": "MOVE_SUBTITLE", "clip_id": clip_id}
                    if vertical:
                        command["vertical"] = vertical
                    if horizontal:
                        command["horizontal"] = horizontal
                    commands.append(command)

                elif action == "STYLE_SUBTITLE":
                    command = {"type": "STYLE_SUBTITLE", "clip_id": clip_id}
                    factor = intent.get("size_factor")
                    if isinstance(factor, (int, float)) and not isinstance(factor, bool):
                        if not 0.3 <= factor <= 3:
                            return {"commands": [], "unclear": "글자 크기는 현재의 0.3배~3배 사이로 바꿀 수 있어요."}
                        command["size_factor"] = float(factor)
                    if isinstance(intent.get("color"), str) and HEX_COLOR.match(intent["color"]):
                        command["color"] = intent["color"].upper()
                    if isinstance(intent.get("box"), bool):
                        command["box"] = intent["box"]
                    if intent.get("font") in SUBTITLE_FONTS:
                        command["font"] = intent["font"]
                    if len(command) == 2:
                        return {"commands": [], "unclear": "자막을 어떻게 바꿀까요? (크기, 색, 배경 박스, 글꼴)"}
                    commands.append(command)

                else:
                    return {"commands": [], "unclear": "지원하지 않는 편집이에요. 길이·순서·배속·음소거·삭제와 자막(추가·이동·스타일)을 할 수 있어요."}
                touched.append(clip_id)

        if not commands:
            return {"commands": [], "unclear": "적용할 편집이 없어요."}
        survivors = [clip_id for clip_id in dict.fromkeys(touched) if clip_id in order]
        return {
            "commands": commands,
            "last_edited": survivors or state.get("last_edited", []),
            "unclear": None,
            "needs_confirm": any(command["type"] == "DELETE" for command in commands),
        }

    def route_after_build(state: EditState) -> str:
        if state.get("unclear"):
            return "Clarify"
        return "Confirm" if state.get("needs_confirm") else "Done"

    async def clarify(state: EditState) -> dict:
        question = state.get("unclear") or "무슨 편집인지 다시 말씀해 주시겠어요?"
        return {"commands": [], "needs_confirm": False, "reply": question, "question": question,
                "message_log": [{"role": "assistant", "content": question, "kind": "clarify"}]}

    async def confirm(state: EditState) -> dict:
        order = [clip["id"] for clip in state["clip_list"]]
        names, last = _clip_names([command["clip_id"] for command in state["commands"] if command["type"] == "DELETE"], order)
        question = f"{names}{_eul(last)} 삭제할까요?"
        approved = interrupt({"question": question})
        if approved:
            reply = describe_commands(state["commands"], state["clip_list"])
            return {"needs_confirm": False, "reply": reply, "message_log": [{"role": "assistant", "content": reply}]}
        reply = "취소했어요. 아무것도 바꾸지 않았어요."
        return {"commands": [], "needs_confirm": False, "reply": reply, "message_log": [{"role": "assistant", "content": reply}]}

    async def done(state: EditState) -> dict:
        reply = describe_commands(state["commands"], state["clip_list"])
        return {"reply": reply, "message_log": [{"role": "assistant", "content": reply}]}

    graph = StateGraph(EditState)
    graph.add_node("Understand", understand)
    graph.add_node("SelectClip", select_clip)
    graph.add_node("BuildCommand", build_command)
    graph.add_node("Clarify", clarify)
    graph.add_node("Confirm", confirm)
    graph.add_node("Done", done)
    graph.add_edge(START, "Understand")
    graph.add_conditional_edges("Understand", route_after_understand, ["Clarify", "SelectClip"])
    graph.add_conditional_edges("SelectClip", route_after_select, ["Clarify", "BuildCommand"])
    graph.add_conditional_edges("BuildCommand", route_after_build, ["Clarify", "Confirm", "Done"])
    graph.add_edge("Clarify", END)
    graph.add_edge("Confirm", END)
    graph.add_edge("Done", END)
    return graph.compile(checkpointer=MemorySaver())


def _interpret_answer(text: str) -> bool | None:
    word = re.sub(r"[\s.!?~]+", "", text.lower())
    if word in YES_WORDS:
        return True
    if word in NO_WORDS:
        return False
    return None


async def run_edit(graph, thread_id: str, message: str, clips: list[dict], video_duration: float, confirm: bool | None = None) -> dict:
    """한 번의 채팅 요청을 처리한다. 반환: {reply, commands, needs_confirm, question}"""
    config = {"configurable": {"thread_id": thread_id}}
    snapshot = await graph.aget_state(config)
    waiting = bool(snapshot.next)  # Confirm에서 승인을 기다리는 중

    if waiting:
        answer = confirm if confirm is not None else _interpret_answer(message)
        if answer is None:
            question = snapshot.tasks[0].interrupts[0].value["question"] if snapshot.tasks and snapshot.tasks[0].interrupts else "삭제할까요?"
            return {"reply": f"{question} “응” 또는 “아니”로 답해 주세요.", "commands": [], "needs_confirm": True, "question": question}
        result = await graph.ainvoke(Command(resume=answer), config)
    else:
        result = await graph.ainvoke(
            {"message_log": [{"role": "user", "content": message}], "clip_list": clips, "video_duration": video_duration,
             "unclear": None, "needs_confirm": False, "commands": [], "reply": "", "question": None},
            config,
        )

    interrupts = result.get("__interrupt__")
    if interrupts:
        question = interrupts[0].value["question"]
        return {"reply": question, "commands": [], "needs_confirm": True, "question": question}
    return {
        "reply": result.get("reply", ""),
        "commands": result.get("commands", []),
        "needs_confirm": False,
        "question": result.get("question"),
    }
