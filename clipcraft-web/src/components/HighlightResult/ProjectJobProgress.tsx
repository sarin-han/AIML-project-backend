import Logo from '@/components/Logo';
import PillButton from '@/components/PillButton';

interface ProjectJobProgressProps {
  title: string;
  message: string;
  /** 0~100. 없으면 막대 없이 돌아가는 표시만 보여 준다. */
  progress?: number;
  error?: string | null;
  backLabel: string;
  onBack: () => void;
  onRetry?: () => void;
}

/** 저장된 프로젝트 영상으로 추출·추천 작업을 돌리는 동안(또는 실패했을 때) 보여 주는 화면 */
export default function ProjectJobProgress({ title, message, progress, error, backLabel, onBack, onRetry }: ProjectJobProgressProps) {
  return (
    <div className="flex min-h-screen flex-col items-center bg-canvas px-10 pt-[22px] pb-20 max-[760px]:px-5" data-testid="project-job-progress">
      <div className="mb-8 flex w-full max-w-[960px] items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex cursor-pointer items-center gap-[7px] rounded-full border border-line-soft bg-glass py-1.5 pr-3 pl-2.5 text-[12.5px] font-[500] tracking-[-0.1px] text-ink-72 transition-colors hover:bg-glass-hover"
        >
          {backLabel}
        </button>
        <Logo height={32} />
      </div>

      <div className="mt-16 flex w-full max-w-[420px] flex-col items-center gap-4 text-center">
        <h1 className="text-[28px] font-[620] leading-[1.15] tracking-[-0.8px]">{error ? '작업에 실패했어요' : title}</h1>
        {error ? (
          <>
            <p className="text-sm leading-[1.6] tracking-[-0.1px] text-ink-56">{error}</p>
            <div className="flex gap-2.5">
              {onRetry && (
                <PillButton variant="white" small onClick={onRetry}>
                  다시 시도
                </PillButton>
              )}
              <PillButton variant="black" small onClick={onBack}>
                {backLabel}
              </PillButton>
            </div>
          </>
        ) : (
          <>
            <svg className="animate-spin" width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="rgba(0,0,0,0.12)" strokeWidth="3" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="#5B4CF5" strokeLinecap="round" strokeWidth="3" />
            </svg>
            <p className="text-sm leading-[1.6] tracking-[-0.1px] text-ink-56" role="status">{message}</p>
            {progress !== undefined && (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.08]">
                <div className="h-full rounded-full bg-[#5B4CF5] transition-[width] duration-500" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
              </div>
            )}
            <p className="text-[12px] text-ink-56">영상 길이에 따라 몇 분 걸릴 수 있어요.</p>
          </>
        )}
      </div>
    </div>
  );
}
