import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '@/components/Icon';
import { icons, type IconName } from '@/components/icons';
import { cn } from '@/lib/cn';
import type { ProjectActionHandlers, ProjectItem } from '@/types/pages/ProjectsScreen';

interface ProjectActionMenuProps extends Omit<ProjectActionHandlers, 'onOpen'> {
  project: ProjectItem;
}

interface MenuItem {
  disabled?: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
}

export default function ProjectActionMenu({ onDelete, onDuplicate, onRename, onToggleStar, project }: ProjectActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !popupRef.current?.contains(target)) setOpen(false);
    };
    const dismiss = () => setOpen(false);

    document.addEventListener('mousedown', close);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);

  // 화면 아래쪽 카드에서 열면 메뉴가 화면 밖으로 나가므로, 삭제까지 보이도록 페이지를 내린다.
  useEffect(() => {
    if (open) popupRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [open]);

  const items: MenuItem[] = [
    { icon: 'edit', label: '이름 변경', onClick: () => onRename(project) },
    { icon: 'copy', label: '복제', onClick: () => onDuplicate(project) },
    { icon: 'star', label: project.starred ? '즐겨찾기 해제' : '즐겨찾기', onClick: () => onToggleStar(project) },
    { icon: 'download', label: '다운로드', onClick: () => undefined, disabled: !project.exported },
  ];

  return (
    <div className={cn('relative justify-self-end', open ? 'z-[1000]' : 'z-0')} ref={menuRef}>
      <button
        className="flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-lg border-0 transition-colors"
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          // 문서 기준 좌표: 메뉴가 페이지 길이에 포함되어 스크롤로 닿을 수 있고, 스크롤해도 버튼을 따라간다.
          setPos({ top: rect.bottom + window.scrollY + 4, right: document.documentElement.clientWidth - rect.right - window.scrollX });
          setOpen((current) => !current);
        }}
        style={{ background: open ? 'rgba(0,0,0,0.07)' : 'transparent' }}
        type="button"
      >
        <Icon d={icons.more} size={16} stroke="rgba(0,0,0,0.55)" strokeWidth={2} />
      </button>
      {open && pos && createPortal(
        <div
          ref={popupRef}
          className="absolute z-[2000] mb-3 min-w-[184px] scroll-mb-3 rounded-[12px] border border-black/[0.14] p-1.5 text-black shadow-[0_18px_44px_rgba(0,0,0,0.18),0_4px_12px_rgba(0,0,0,0.1)] ring-1 ring-white"
          onClick={(event) => event.stopPropagation()}
          style={{ backgroundColor: '#fff', backdropFilter: 'none', opacity: 1, top: pos.top, right: pos.right }}
        >
          {items.map((item) => (
            <button
              className="flex w-full items-center gap-2.5 rounded-lg border-0 px-2.5 py-2 text-left text-[13px] tracking-[-0.1px] text-black/78 transition-colors hover:bg-black/[0.055] disabled:cursor-not-allowed disabled:text-black/30 disabled:hover:bg-white"
              disabled={item.disabled}
              key={item.label}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              type="button"
            >
              <Icon d={icons[item.icon]} size={13} />
              {item.label}
            </button>
          ))}
          <div className="mx-1 my-[5px] h-px bg-[rgba(0,0,0,0.07)]" />
          <button
            className="flex w-full items-center gap-2.5 rounded-lg border-0 px-2.5 py-2 text-left text-[13px] tracking-[-0.1px] text-[#dc2626] transition-colors hover:bg-[rgba(220,38,38,0.06)]"
            onClick={() => {
              setOpen(false);
              onDelete(project);
            }}
            type="button"
          >
            <Icon d={icons.trash} size={13} stroke="#dc2626" />
            삭제
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
