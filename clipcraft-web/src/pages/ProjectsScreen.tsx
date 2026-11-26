import { useEffect, useMemo, useRef, useState } from 'react';
import { deleteProject as deleteProjectRequest, duplicateProject as duplicateProjectRequest, listProjects, patchProject, restoreProject as restoreProjectRequest } from '@/api/projects';
import DeleteProjectModal from '@/components/ProjectsScreen/DeleteProjectModal';
import EmptySearchState from '@/components/ProjectsScreen/EmptySearchState';
import NewProjectCard from '@/components/ProjectsScreen/NewProjectCard';
import ProjectCard from '@/components/ProjectsScreen/ProjectCard';
import ProjectRow, { ProjectListHeader } from '@/components/ProjectsScreen/ProjectRow';
import ProjectsPageHeader from '@/components/ProjectsScreen/ProjectsPageHeader';
import ProjectsSkeleton from '@/components/ProjectsScreen/ProjectsSkeleton';
import ProjectsToolbar from '@/components/ProjectsScreen/ProjectsToolbar';
import ProjectsTopNav from '@/components/ProjectsScreen/ProjectsTopNav';
import RenameProjectModal from '@/components/ProjectsScreen/RenameProjectModal';
import Toast from '@/components/ProjectsScreen/Toast';
import { useAuth } from '@/lib/authContext';
import { toProjectItem } from '@/lib/projectMapping';
import type { ProjectItem, ProjectSort, ProjectsView, ToastState } from '@/types/pages/ProjectsScreen';

interface ProjectsScreenProps {
  onLogoClick: () => void;
  onStartNewProject: (project?: { projectName?: string; projectId?: string }) => void;
  onOpenProject: (projectId: string) => void;
}

export default function ProjectsScreen({ onLogoClick, onStartNewProject, onOpenProject }: ProjectsScreenProps) {
  const { accessToken } = useAuth();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<ProjectsView>('grid');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ProjectSort>('updated');
  const [deleteTarget, setDeleteTarget] = useState<ProjectItem | null>(null);
  const [renameTarget, setRenameTarget] = useState<ProjectItem | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const undoRef = useRef<{ index: number; project: ProjectItem } | null>(null);

  useEffect(() => {
    if (!accessToken) return;

    let cancelled = false;
    listProjects(accessToken)
      .then((apiProjects) => {
        if (cancelled) return;
        setProjects(apiProjects.map(toProjectItem));
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setLoaded(true);
        setToast({ icon: 'trash', message: '프로젝트 목록을 불러오지 못했어요' });
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const filteredProjects = useMemo(() => {
    let list = projects.filter((project) => project.title.toLowerCase().includes(query.toLowerCase()));

    if (sort === 'name') list = [...list].sort((a, b) => a.title.localeCompare(b.title, 'ko'));

    return list;
  }, [projects, query, sort]);

  const openProject = (project: ProjectItem) => {
    // 분석이 끝난 프로젝트(편집 중·완료)는 저장된 영상·분석 결과·편집 내용으로 편집 화면을 되살린다.
    if (project.status === 'editing' || project.status === 'completed') {
      onOpenProject(project.id);
      return;
    }

    // 초안·분석 중·실패는 아직 저장된 분석 결과가 없으므로 업로드부터 다시 시작한다(같은 프로젝트에 이어서 저장된다).
    onStartNewProject({ projectName: project.title, projectId: project.id });
  };

  const deleteProject = async (project: ProjectItem) => {
    if (!accessToken) return;

    undoRef.current = { project, index: projects.findIndex((item) => item.id === project.id) };
    setProjects((current) => current.filter((item) => item.id !== project.id));
    setDeleteTarget(null);

    try {
      await deleteProjectRequest(accessToken, project.id, project.version);
    } catch {
      setToast({ icon: 'trash', message: '삭제에 실패했어요. 새로고침 후 다시 시도해주세요.' });
      return;
    }

    setToast({
      icon: 'trash',
      message: `"${project.title}" 삭제됨`,
      action: {
        label: '실행 취소',
        onClick: () => {
          const undo = undoRef.current;
          if (!undo || !accessToken) return;

          restoreProjectRequest(accessToken, undo.project.id, undo.project.version)
            .then((restored) => {
              setProjects((current) => {
                const next = [...current];
                next.splice(undo.index, 0, toProjectItem(restored));
                return next;
              });
            })
            .catch(() => setToast({ icon: 'trash', message: '실행 취소에 실패했어요.' }));

          setToast(null);
          undoRef.current = null;
        },
      },
      duration: 5000,
    });
  };

  const duplicateProject = async (project: ProjectItem) => {
    if (!accessToken) return;

    try {
      const duplicate = await duplicateProjectRequest(accessToken, project.id);
      setProjects((current) => [toProjectItem(duplicate), ...current]);
      setToast({ icon: 'copy', message: `"${project.title}" 복제됨` });
    } catch {
      setToast({ icon: 'trash', message: '복제에 실패했어요.' });
    }
  };

  const toggleStar = async (project: ProjectItem) => {
    if (!accessToken) return;

    try {
      const updated = await patchProject(accessToken, project.id, { version: project.version, starred: !project.starred });
      setProjects((current) => current.map((item) => (item.id === project.id ? toProjectItem(updated) : item)));
    } catch {
      setToast({ icon: 'trash', message: '즐겨찾기 변경에 실패했어요.' });
    }
  };

  const renameProject = async (project: ProjectItem, title: string) => {
    if (!accessToken) return;

    try {
      const updated = await patchProject(accessToken, project.id, { version: project.version, title });
      setProjects((current) => current.map((item) => (item.id === project.id ? toProjectItem(updated) : item)));
      setRenameTarget(null);
      setToast({ icon: 'check', message: '이름이 변경되었어요' });
    } catch {
      setToast({ icon: 'trash', message: '이름 변경에 실패했어요.' });
    }
  };

  // 새 프로젝트는 업로드 화면에서 제목을 입력하고 분석을 시작할 때 만들어진다.
  const startNewProject = () => onStartNewProject();

  const actionHandlers = {
    onDelete: setDeleteTarget,
    onDuplicate: duplicateProject,
    onOpen: openProject,
    onRename: setRenameTarget,
    onToggleStar: toggleStar,
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#fafafa]">
      <ProjectsTopNav onLogoClick={onLogoClick} />
      {/* 아래 여백: 맨 아래 카드의 점 세 개 메뉴가 페이지 안에서 끝까지 펼쳐질 자리 */}
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-10 pt-9 pb-60 max-[760px]:px-5">
        <ProjectsPageHeader count={loaded ? projects.length : null} onNewProject={() => startNewProject()} />
        <ProjectsToolbar onQueryChange={setQuery} onSortChange={setSort} onViewChange={setView} query={query} sort={sort} view={view} />

        {!loaded && (
          <div className="mb-4 flex items-center justify-center gap-2.5 text-[13.5px] text-[rgba(0,0,0,0.55)]" data-testid="projects-loading" role="status">
            <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-black/15 border-t-black/60" />
            프로젝트를 불러오는 중이에요
          </div>
        )}

        {loaded && filteredProjects.length === 0 && query ? (
          <EmptySearchState onClear={() => setQuery('')} query={query} />
        ) : view === 'grid' ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
            <NewProjectCard onClick={() => startNewProject()} />
            {filteredProjects.map((project) => (
              <ProjectCard key={project.id} project={project} {...actionHandlers} />
            ))}
            {!loaded && <ProjectsSkeleton view="grid" />}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5 rounded-[14px] border border-[rgba(0,0,0,0.08)] bg-white p-2">
            <ProjectListHeader />
            {filteredProjects.map((project) => (
              <ProjectRow key={project.id} project={project} {...actionHandlers} />
            ))}
            {!loaded && <ProjectsSkeleton view="list" />}
          </div>
        )}
      </main>

      {deleteTarget && <DeleteProjectModal onCancel={() => setDeleteTarget(null)} onConfirm={(project) => void deleteProject(project)} project={deleteTarget} />}
      {renameTarget && <RenameProjectModal onCancel={() => setRenameTarget(null)} onRename={(project, title) => void renameProject(project, title)} project={renameTarget} />}
      <Toast onDismiss={() => setToast(null)} toast={toast} />
    </div>
  );
}
