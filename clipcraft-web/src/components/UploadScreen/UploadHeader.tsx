import { motion } from 'framer-motion';
import Icon from '@/components/Icon';
import { icons } from '@/components/icons';
import MonoLabel from '@/components/MonoLabel';
import { containerStagger, fadeInUp } from '@/lib/animations';
import { cn } from '@/lib/cn';

interface UploadHeaderProps {
  onBack: () => void;
  projectTitle: string;
  onProjectTitleChange: (title: string) => void;
  useEmptyStateDesign: boolean;
}

export default function UploadHeader({ onBack, projectTitle, onProjectTitleChange, useEmptyStateDesign }: UploadHeaderProps) {
  return (
    <>
      <motion.div
        className={cn('flex w-full items-center will-change-[transform,opacity]', useEmptyStateDesign ? 'mb-10' : 'mb-8')}
        variants={fadeInUp}
      >
        <button
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border-0 bg-black/[0.05] py-2 pl-3 pr-4 text-[14px] font-medium tracking-[-0.2px] text-black/70 transition-colors hover:bg-black/[0.09] hover:text-black"
          data-testid="upload-back-button"
          onClick={onBack}
          type="button"
        >
          <Icon d={icons.arrowL} size={16} stroke="currentColor" strokeWidth={2} />
          프로젝트 목록
        </button>
      </motion.div>

      <motion.div className="text-center mb-10" variants={containerStagger}>
        <motion.div className="mb-4 flex items-center justify-center gap-2.5 will-change-[transform,opacity]" variants={fadeInUp}>
          <MonoLabel>AI Video Editor</MonoLabel>
        </motion.div>
        <motion.h1
          className="leading-[1.08] will-change-[transform,opacity] mb-[18px] text-[52px] font-semibold tracking-[-1.2px] max-[760px]:text-[40px]"
          data-testid="upload-heading"
          variants={fadeInUp}
        >
          영상 편집 시작하기
        </motion.h1>
        <motion.p
          className="font-[320] tracking-[-0.2px] will-change-[transform,opacity] text-[17px] leading-[1.55] text-[rgba(0,0,0,0.45)]"
          variants={fadeInUp}
        >
          원본 영상을 업로드하고,
          <br />
          찾는 방법을 골라 주세요.
        </motion.p>
        <motion.div className="mx-auto mt-8 flex w-full max-w-[420px] flex-col gap-2 text-left will-change-[transform,opacity]" variants={fadeInUp}>
          <label className="text-[12px] font-medium tracking-[-0.1px] text-black/50" htmlFor="project-title-input">프로젝트 제목</label>
          <input
            id="project-title-input"
            data-testid="project-title-input"
            className="h-12 w-full rounded-[12px] border border-black/[0.12] bg-white px-4 text-[15px] tracking-[-0.2px] outline-none transition-colors placeholder:text-black/30 focus:border-[#5B4CF5]"
            maxLength={100}
            onChange={(event) => onProjectTitleChange(event.target.value)}
            placeholder="예: 주말 캠핑 브이로그"
            value={projectTitle}
          />
          <p className="text-[12px] font-[320] tracking-[-0.1px] text-black/40">하이라이트 추출과 시나리오 추천이 이 제목을 참고해요.</p>
        </motion.div>
      </motion.div>
    </>
  );
}
