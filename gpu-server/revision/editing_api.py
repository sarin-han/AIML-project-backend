"""하이라이트 추출 · 장면 추천 (ReVision 서비스 안에서 돌린다).

ClipCraft-AI의 `revisionllm.editing`(UniVTG + CLAP 오디오 점수)을 그대로 쓴다. ReVision 서비스와 같은 DB·특징 저장소
(`Engine.db`, `Engine.store`)를 쓰므로, 같은 영상으로 ReVision 탐색과 하이라이트·추천을 이어서 해도 특징 추출은 한 번만 하고,
구간 계획과 최종 결과(장면 이름 포함)도 영상·제목·설정이 같으면 저장해 둔 것을 돌려준다.
"""
import json
import re
import types
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional


NAME_SYSTEM = (
    "You name segments of ONE video for a Korean video editor. You receive segments, each with an id, start and end time in "
    "seconds and a caption of what happens. For EVERY given id write a short scene name in Korean. "
    "STYLE: a noun phrase or noun-ended phrase of roughly 10-25 characters, never a sentence, never ending with a period or "
    "any punctuation. Say what is visibly happening (who, what). Good examples: '양념 재료 손으로 버무리기', "
    "'이민호, 복도에서 마주친 놀란 표정', '탕수육 소스 완성과 시식 평가'. Different segments get different names. "
    'Do not guess facts the captions do not state. Reply with JSON only: {"names": [{"id": int, "name": str}]}.'
)


def _clean(text) -> str:
    return re.sub(r"\s+", " ", str(text)).strip().rstrip(".。!?… ")


class EditingEngine:
    def __init__(self, engine, cache_cfg, clip_pt: str, report=None):
        from revisionllm.editing.config import EditConfig
        from revisionllm.editing.scorers import make_scorer
        from revisionllm.editing.service import EditingService

        self.cfg = EditConfig()
        self.report = report or (lambda *args, **kwargs: None)
        # DB(영상 특징 · 구간 계획 · 결과)와 특징 저장소는 ReVision 서비스와 같은 것을 쓴다.
        self.service = EditingService(
            cache_cfg, self.cfg, clip_pt,
            db=engine.db, scorer=make_scorer(),
            grounder=types.SimpleNamespace(features=engine.store),
        )

    # ---- 구간에 이름 붙이기: 키프레임 캡션(GPT) → 짧은 장면 이름(GPT) -------------------------------------------
    def _name_segments(self, video_path: str, segments, required: bool) -> Dict[int, str]:
        """{segment id: 장면 이름}. required=False면 LLM이 안 될 때 빈 dict를 돌려 주고, True면 예외를 낸다."""
        try:
            llm = self.service.llm
            done = [0]
            self.report("caption", 0.0, f"0/{len(segments)}")

            def caption(seg):
                text = llm.caption(video_path, seg)
                done[0] += 1
                self.report("caption", done[0] / len(segments), f"{done[0]}/{len(segments)}")
                return text

            with ThreadPoolExecutor(max_workers=4) as pool:
                captions = list(pool.map(caption, segments))
            for seg, caption in zip(segments, captions):
                seg.caption = caption
            self.report("name", 0.0)
            payload = [{"id": s.id, "start": round(s.start, 1), "end": round(s.end, 1), "caption": s.caption} for s in segments]
            reply = llm._chat(
                [{"role": "system", "content": NAME_SYSTEM}, {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
                json_mode=True,
            )
            names = {int(item["id"]): _clean(item["name"]) for item in json.loads(reply).get("names", []) if _clean(item.get("name", ""))}
            return names
        except Exception as error:
            if required:
                raise
            print(f"[editing] 장면 이름을 만들지 못했어요: {error}", flush=True)
            return {}

    @staticmethod
    def _key_times(start: float, end: float, every: float, max_frames: int) -> List[float]:
        count = max(2, min(max_frames, round((end - start) / every)))
        return [round(start + (end - start) * (i + 0.5) / count, 2) for i in range(count)]

    # ---- 결과 저장: 같은 영상 · 같은 제목 · 같은 설정이면 GPT 호출까지 건너뛴다 -------------------------------------------
    def _result_key(self, av, kind: str, title: Optional[str]) -> str:
        from revisionllm.editing.service import params_key
        # "v2": 추천 결과에 구간 시간이 들어가면서 저장 형식이 바뀌었다(이전 형식의 결과는 쓰지 않는다).
        return params_key(self.service._key(av, kind, (title or "").strip()), self.cfg.openai_model, self.cfg.language, NAME_SYSTEM, "v2")

    def _cached_result(self, av, kind: str, title: Optional[str]):
        try:
            return self.service.db.get_result(av.video_id, kind, self._result_key(av, kind, title))
        except Exception as error:  # 저장소 문제로 요청이 실패하면 안 된다
            print(f"[editing] 저장된 결과를 읽지 못했어요: {error}", flush=True)
            return None

    def _store_result(self, av, kind: str, title: Optional[str], payload) -> None:
        try:
            self.service.db.put_result(av.video_id, kind, self._result_key(av, kind, title), payload)
        except Exception as error:
            print(f"[editing] 결과를 저장하지 못했어요: {error}", flush=True)

    # ---- 하이라이트 ------------------------------------------------------------------------------------------------
    def highlights(self, video_path: str, title: Optional[str]) -> dict:
        from revisionllm.editing.summarize import Segment

        av = self.service.representation(video_path)     # 특징 추출(디코딩 · CLIP · CLAP)은 여기서 한다. 저장돼 있으면 건너뛴다.
        duration = av.duration
        cached = self._cached_result(av, "api_highlights", title)
        if cached is not None:
            for stage in ("score", "plan", "caption", "name"):
                self.report(stage, 1.0)
            return cached
        self.report("score", 0.0)
        plan = self.service.highlight(video_path, None, None, (title or "").strip() or "a video")
        self.report("plan", 1.0)
        segments = [
            Segment(
                id=index, start=clip["start"], end=clip["end"], importance=clip["score"],
                tags={clip["dominant_audio"]: clip["audio_prob"]},
                key_times=self._key_times(clip["start"], clip["end"], self.cfg.key_every_sec, self.cfg.frames_per_segment),
            )
            for index, clip in enumerate(plan["clips"], start=1)
        ]
        names = self._name_segments(video_path, segments, required=False)
        result = {
            "duration": duration,
            "highlights": [
                {"id": s.id, "start": s.start, "end": s.end, "label": names.get(s.id) or f"하이라이트 {s.id}"}
                for s in segments
            ],
        }
        if names:  # 이름을 못 만든 결과는 저장하지 않는다(다음에 다시 시도할 수 있게)
            self._store_result(av, "api_highlights", title, result)
        return result

    # ---- 시나리오 추천: 영상 요약 구간 → 구간 설명(GPT) → 편집 시나리오(제목·요약·장면별 설명과 이유) -----------------
    def scenario(self, video_path: str, title: Optional[str]) -> dict:
        """{"title", "summary", "scenes": [{"order", "start", "end", "description", "reason"}]}. 같은 영상·제목이면 저장해 둔 결과를 쓴다."""
        self.report("score", 0.0)
        plan = self.service.recommend(video_path, title=(title or "").strip() or "a video")
        self.report("name", 1.0)
        scenes = [
            {
                "order": index,
                "start": round(float(scene["start"]), 1),
                "end": round(float(scene["end"]), 1),
                "description": scene.get("description", ""),
                "reason": scene.get("reason", ""),
            }
            for index, scene in enumerate(plan.get("scenes", []), 1)
        ]
        if not scenes:
            raise RuntimeError("추천할 시나리오를 만들지 못했어요.")
        return {"title": plan.get("title", ""), "summary": plan.get("summary", ""), "scenes": scenes}

    # ---- 장면 추천 -------------------------------------------------------------------------------------------------
    def recommend(self, video_path: str, title: Optional[str]) -> List[dict]:
        """장면 이름과 그 장면이 영상의 어디인지(start/end 초)를 함께 돌려준다: [{"text", "start", "end"}].
        추천은 영상의 구간(요약 윈도우)에서 나온 것이라 이미 시간을 알고 있으므로, 이 장면을 다시 검색할 필요가 없다."""
        av = self.service.representation(video_path)
        cached = self._cached_result(av, "api_recommend", title)
        if cached is not None:
            for stage in ("score", "plan", "caption", "name"):
                self.report(stage, 1.0)
            return cached["scenes"]
        self.report("score", 0.0)
        segments = sorted(self.service.summary(video_path, (title or "").strip() or "a video"), key=lambda s: s.start)
        self.report("plan", 1.0)
        names = self._name_segments(video_path, segments, required=True)
        scenes: List[dict] = []
        for seg in segments:
            name = names.get(seg.id)
            if name and all(name != scene["text"] for scene in scenes):
                scenes.append({"text": name, "start": round(float(seg.start), 1), "end": round(float(seg.end), 1)})
        if not scenes:
            raise RuntimeError("추천할 장면을 만들지 못했어요.")
        self._store_result(av, "api_recommend", title, {"scenes": scenes})
        return scenes
