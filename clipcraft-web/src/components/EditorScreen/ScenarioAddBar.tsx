import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import Icon from '@/components/Icon';
import MonoLabel from '@/components/MonoLabel';
import { icons } from '@/components/icons';

interface ScenarioAddBarProps {
  accent: string;
  /** 영상에서 장면을 찾아 목록에 넣는다. 실패하면 사용자에게 보여 줄 문구를, 성공하면 null을 돌려준다. */
  onAdd: (scenario: string) => Promise<string | null>;
}

/** 편집 화면에서 시나리오(찾고 싶은 장면)를 하나 더 입력해 구간 목록 끝에 추가한다. */
export default function ScenarioAddBar({ accent, onAdd }: ScenarioAddBarProps) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const text = value.trim();
    if (!text || busy) return;

    setBusy(true);
    setError(null);
    const failure = await onAdd(text);
    setBusy(false);

    if (failure) setError(failure);
    else setValue('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const canSubmit = value.trim().length > 0 && !busy;

  return (
    <div className="ed-foot border-t border-line-soft bg-white px-4 py-3" data-testid="editor-scenario-add">
      <div className="mb-2 flex items-center justify-between">
        <MonoLabel>시나리오 추가</MonoLabel>
        <span className="text-[11px] whitespace-nowrap text-ink-56">영상에서 찾아 목록 끝에 넣어요</span>
      </div>
      <div className="flex gap-2">
        <div
          className="flex flex-1 items-center gap-2 rounded-[10px] bg-white px-3 py-2 transition-colors"
          style={{ border: `1.5px solid ${error ? '#dc2626' : focused ? accent : 'rgba(0,0,0,0.12)'}` }}
        >
          <Icon d={icons.search} size={14} stroke={focused ? accent : 'rgba(0,0,0,0.4)'} />
          <input
            aria-label="추가할 장면"
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] tracking-[-0.1px] text-black outline-none placeholder:text-ink-56 disabled:opacity-60"
            data-testid="editor-scenario-input"
            disabled={busy}
            onBlur={() => setFocused(false)}
            onChange={(event) => {
              setValue(event.target.value);
              if (error) setError(null);
            }}
            onFocus={() => setFocused(true)}
            onKeyDown={handleKeyDown}
            placeholder="찾고 싶은 장면 (예: 김치를 넣고 볶는 장면)"
            value={value}
          />
        </div>
        <button
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border-0 px-4 py-2 text-[13px] whitespace-nowrap font-[480] tracking-[-0.1px] text-white transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashed focus-visible:outline-black"
          data-testid="editor-scenario-add-button"
          disabled={!canSubmit}
          onClick={() => void submit()}
          style={{ background: canSubmit || busy ? accent : 'rgba(0,0,0,0.08)', color: canSubmit || busy ? '#fff' : 'rgba(0,0,0,0.4)', cursor: canSubmit ? 'pointer' : busy ? 'progress' : 'not-allowed', opacity: busy ? 0.85 : 1 }}
          type="button"
        >
          {busy ? (
            <span className="inline-block h-3.5 w-3.5 rounded-full" style={{ border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#fff', animation: 'ccspin 0.8s linear infinite' }} />
          ) : (
            <Icon d={icons.plus} size={13} strokeWidth={2} />
          )}
          {busy ? '찾는 중...' : '찾아서 추가'}
        </button>
      </div>
      {error && (
        <p className="mt-2 text-xs leading-[1.5] tracking-[-0.1px] text-danger-ink" data-testid="editor-scenario-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
