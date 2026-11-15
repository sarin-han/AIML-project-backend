import Icon from '@/components/Icon';
import { icons } from '@/components/icons';
import { formatClock } from '@/lib/highlights';
import type { RecommendedScenarioScene } from '@/api/projectJobs';

interface ScenarioSceneRowProps {
  accent: string;
  scene: RecommendedScenarioScene;
  thumbnail?: string;
  active: boolean;
  selected: boolean;
  onToggle: () => void;
  onFocus: () => void;
}

/** 추천 시나리오의 장면 한 줄: 번호 · 썸네일 · 장면 이름과 이유 · 구간 · 선택 */
export default function ScenarioSceneRow({ accent, scene, thumbnail, active, selected, onToggle, onFocus }: ScenarioSceneRowProps) {
  return (
    <div
      className="flex items-center gap-4 rounded-[12px] bg-white px-4 py-3 transition-colors"
      data-selected={selected}
      data-testid="scenario-scene-row"
      style={{ border: `1px solid ${active ? accent : 'rgba(0,0,0,0.1)'}`, boxShadow: active ? `0 0 0 1px ${accent}` : 'none', opacity: selected ? 1 : 0.6 }}
    >
      <button
        type="button"
        onClick={onFocus}
        aria-current={active}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-4 border-0 bg-transparent p-0 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashed focus-visible:outline-black"
      >
        <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white" style={{ background: accent }}>
          {scene.order}
        </span>
        <span className="relative h-[62px] w-[100px] shrink-0 overflow-hidden rounded-[8px] bg-black max-[520px]:hidden">
          {thumbnail && <img alt="" className="absolute inset-0 h-full w-full object-cover" src={thumbnail} style={{ filter: selected ? 'none' : 'grayscale(0.7)' }} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-[520] leading-[1.35] tracking-[-0.2px]">{scene.description}</span>
          {scene.reason && <span className="mt-1 block text-[13px] leading-[1.45] tracking-[-0.1px] text-ink-56">{scene.reason}</span>}
        </span>
        <span className="shrink-0 font-mono text-[12px] text-ink-56 max-[760px]:hidden">
          {formatClock(scene.start)} - {formatClock(scene.end)}
        </span>
      </button>
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`${scene.description} ${selected ? '제외' : '포함'}`}
        data-testid="scenario-check"
        onClick={onToggle}
        className="flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center rounded-full p-0 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashed focus-visible:outline-black"
        style={{ border: `1.5px solid ${selected ? accent : 'rgba(0,0,0,0.28)'}`, background: selected ? accent : '#fff' }}
      >
        {selected && <Icon d={icons.check} size={12} stroke="#fff" strokeWidth={2.6} />}
      </button>
    </div>
  );
}
