import type { ProjectsView } from '@/types/pages/ProjectsScreen';

const PLACEHOLDERS = [0, 1, 2];
const BLOCK = 'animate-pulse bg-black/[0.07]';

// 목록을 받기 전에 카드(행) 자리를 잡아 둔다. 비어 있으면 프로젝트가 사라진 것처럼 보인다.
export default function ProjectsSkeleton({ view }: { view: ProjectsView }) {
  return (
    <>
      {PLACEHOLDERS.map((index) =>
        view === 'grid' ? (
          <div key={index} aria-hidden="true" className="self-start rounded-[14px] border border-[rgba(0,0,0,0.08)] bg-white">
            <div className="p-2.5 pb-0">
              <div className={`aspect-video w-full rounded-[10px] ${BLOCK}`} />
            </div>
            <div className="flex flex-col gap-2.5 p-3.5">
              <div className={`h-4 w-3/4 rounded ${BLOCK}`} />
              <div className={`h-3.5 w-2/5 rounded ${BLOCK}`} />
            </div>
          </div>
        ) : (
          <div key={index} aria-hidden="true" className="flex items-center gap-4 px-4 py-3">
            <div className={`aspect-video w-[120px] shrink-0 rounded-[10px] max-[980px]:w-24 ${BLOCK}`} />
            <div className="flex flex-1 flex-col gap-2">
              <div className={`h-4 w-2/5 rounded ${BLOCK}`} />
              <div className={`h-3 w-1/4 rounded ${BLOCK}`} />
            </div>
          </div>
        ),
      )}
    </>
  );
}
