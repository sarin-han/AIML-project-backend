import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { Location, NavigateFunction } from 'react-router-dom';
import AnalyzingScreen from '@/pages/AnalyzingScreen';
import AuthScreen from '@/pages/AuthScreen';
import HighlightResultScreen from '@/pages/HighlightResultScreen';
import EditorScreen from '@/pages/EditorScreen';
import LandingScreen from '@/pages/LandingScreen';
import ProjectsScreen from '@/pages/ProjectsScreen';
import UploadScreen from '@/pages/UploadScreen';
import { createProject, getProjectState } from '@/api/projects';
import type { EditorSavedState } from '@/api/projects';
import { pageTransition } from '@/lib/animations';
import { useAuth } from '@/lib/authContext';
import { UploadSessionProvider } from '@/state/UploadSession';
import type { HighlightAnalysisResult, HighlightExtractionResult, PendingHighlightAnalysis } from '@/types/app';

/** 로그인하지 않았으면 로그인 화면으로 보낸다. 로그인 상태를 확인하는 동안에는 아무것도 그리지 않는다. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, user } = useAuth();
  const location = useLocation();

  if (loading) return null;
  if (!user) return <Navigate to="/auth" replace state={{ from: location }} />;

  return children;
}

/** 하이라이트 결과 화면이 받는 라우트 상태 */
interface HighlightResultState {
  extraction: HighlightExtractionResult;
  request: PendingHighlightAnalysis;
  jobId?: string;
  projectName?: string;
  videoPath?: string;
}

/** 편집 화면 주소. 분석을 돌린 작업 ID를 쓰고, 없으면 new. */
const editorPath = (jobId?: string) => `/editor/${jobId ?? 'new'}`;

/**
 * 업로드 화면으로 돌아간다. 업로드 화면으로 올 때의 라우트 상태(프로젝트 이름·형식)를 되살리려고
 * 가능하면 뒤로 가기를 쓰고, 이 화면이 첫 진입이면 /upload로 이동한다.
 * 올린 영상·고른 방법·입력한 장면은 UploadSession에 있어서 어느 쪽이든 그대로 남는다.
 */
function backToUpload(navigate: NavigateFunction, location: Location) {
  if (location.key !== 'default') navigate(-1);
  else navigate('/upload', { replace: true });
}

function UploadRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const { accessToken } = useAuth();
  const routeState = location.state as { projectName?: string; projectId?: string } | null;

  return (
    <UploadScreen
      initialProjectName={routeState?.projectName}
      onBack={() => navigate('/workspace')}
      onNext={async (result) => {
        // 프로젝트 화면을 거치지 않고 올렸으면 여기서 프로젝트를 만들어, 영상과 편집 내용을 저장할 곳을 마련한다.
        let projectId = routeState?.projectId;
        if (!projectId && accessToken) {
          try {
            projectId = (await createProject(accessToken, { title: result.projectName })).id;
          } catch {
            // 프로젝트를 만들지 못해도 분석·편집은 할 수 있다. 다만 이번 편집은 서버에 저장되지 않는다.
          }
        }
        navigate('/analyzing', { state: { ...result, projectId } });
      }}
    />
  );
}

function AnalyzingRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const pendingAnalysis = location.state as PendingHighlightAnalysis | null;

  const isHighlight = pendingAnalysis?.mode === 'highlight';

  if (!pendingAnalysis?.file || (!isHighlight && !pendingAnalysis.scenarios?.length)) return <Navigate to="/upload" replace />;

  return (
    <AnalyzingScreen
      request={pendingAnalysis}
      onDone={(result) => navigate(editorPath(result.jobId), { state: { ...result, projectId: pendingAnalysis.projectId } })}
      onHighlightDone={(result) => {
        const { jobId, projectName, videoPath, ...extraction } = result;
        const state: HighlightResultState = { extraction, request: pendingAnalysis, jobId, projectName, videoPath };
        // replace: 결과 화면에서 뒤로 가면 분석 중 화면이 아니라 업로드 화면으로 간다.
        navigate('/highlights', { replace: true, state });
      }}
      onBack={() => backToUpload(navigate, location)}
    />
  );
}

function HighlightResultRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as HighlightResultState | null;

  if (!state?.extraction || !state.request?.file) return <Navigate to="/upload" replace />;

  const { extraction, request, jobId, projectName, videoPath } = state;

  return (
    <HighlightResultScreen
      extraction={extraction}
      jobId={jobId}
      projectName={projectName ?? request.projectName}
      videoPath={videoPath || request.videoPath}
      videoUrl={request.videoUrl}
      videoName={request.videoName}
      onBack={() => backToUpload(navigate, location)}
      onRetry={() => navigate('/analyzing', { replace: true, state: { ...request, attempt: (request.attempt ?? 0) + 1 } })}
      onNext={(analysis) => navigate(editorPath(analysis.jobId), { state: { ...analysis, projectId: request.projectId } })}
    />
  );
}

function EditorRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const analysisResult = location.state as HighlightAnalysisResult | null;

  if (!analysisResult?.segments?.length) return <Navigate to="/upload" replace />;

  return (
    <EditorScreen
      analysis={analysisResult}
      projectName={analysisResult?.projectName}
      videoPath={analysisResult?.videoPath}
      videoName={analysisResult?.videoName}
      videoUrl={analysisResult?.videoUrl}
      projectId={analysisResult?.projectId}
      jobId={analysisResult?.jobId}
      onBack={() => navigate(analysisResult?.projectId ? '/workspace' : '/upload')}
    />
  );
}

/** 프로젝트 화면에서 연 프로젝트: 서버에 저장된 영상·분석 결과·편집 내용을 불러와 편집하던 화면을 되살린다. */
function ProjectEditorRoute() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { accessToken } = useAuth();
  const [loaded, setLoaded] = useState<{
    analysis: HighlightAnalysisResult;
    editor: EditorSavedState | null;
    projectName: string;
    hasPreview: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || !accessToken) return;
    let cancelled = false;

    getProjectState(accessToken, projectId)
      .then((state) => {
        if (cancelled) return;
        if (!state.analysis || !state.analysis.segments?.length) {
          // 분석 결과가 아직 없는 프로젝트는 업로드부터 다시 시작한다.
          navigate('/upload', { replace: true, state: { projectName: state.project.title, projectId } });
          return;
        }
        if (!state.video?.url) {
          setError('저장된 원본 영상을 찾을 수 없어요. 영상을 다시 올려 주세요.');
          return;
        }
        setLoaded({
          analysis: {
            ...state.analysis,
            jobId: state.job_id ?? undefined,
            projectId,
            projectName: state.project.title,
            videoPath: state.video.path ?? undefined,
            videoUrl: state.video.url,
            videoName: state.video.name ?? undefined,
          },
          editor: state.editor,
          projectName: state.project.title,
          hasPreview: Boolean(state.project.preview_url),
        });
      })
      .catch(() => {
        if (!cancelled) setError('프로젝트를 불러오지 못했어요.');
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, accessToken, navigate]);

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 text-[15px] text-black/70">
        <p>{error}</p>
        <button className="rounded-full bg-black px-5 py-2 text-white" onClick={() => navigate('/workspace')} type="button">
          프로젝트 목록으로
        </button>
      </div>
    );
  }

  if (!loaded) return <div className="flex min-h-screen items-center justify-center text-[15px] text-black/50">프로젝트를 불러오는 중…</div>;

  const { analysis, editor, projectName, hasPreview } = loaded;

  return (
    <EditorScreen
      analysis={analysis}
      projectName={projectName}
      videoPath={analysis.videoPath}
      videoName={analysis.videoName}
      videoUrl={analysis.videoUrl}
      projectId={analysis.projectId}
      jobId={analysis.jobId}
      initialEditor={editor ?? undefined}
      hasPreview={hasPreview}
      onBack={() => navigate('/workspace')}
    />
  );
}

function AuthRoute() {
  const navigate = useNavigate();
  return <AuthScreen onContinue={() => navigate('/workspace')} onLogoClick={() => navigate('/')} />;
}

function ProjectsRoute() {
  const navigate = useNavigate();
  return <ProjectsScreen onLogoClick={() => navigate('/')} onStartNewProject={(project) => navigate('/upload', { state: project ?? null })} onOpenProject={(projectId) => navigate(`/workspace/${projectId}`)} />;
}

export default function AppRouter() {
  const location = useLocation();

  return (
    <UploadSessionProvider>
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route
          path="/"
          element={
            <motion.div
              className="min-h-screen"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
            >
              <LandingScreen />
            </motion.div>
          }
        />
        <Route
          path="/upload"
          element={
            <motion.div className="min-h-screen" initial="hidden" animate="visible" exit="exit" variants={pageTransition}>
              <RequireAuth>
                <UploadRoute />
              </RequireAuth>
            </motion.div>
          }
        />
        <Route
          path="/analyzing"
          element={
            <motion.div
              className="min-h-screen"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
            >
              <RequireAuth>
                <AnalyzingRoute />
              </RequireAuth>
            </motion.div>
          }
        />
        <Route
          path="/highlights"
          element={
            <motion.div
              className="min-h-screen"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
            >
              <RequireAuth>
                <HighlightResultRoute />
              </RequireAuth>
            </motion.div>
          }
        />
        <Route
          path="/editor"
          element={
            <motion.div
              className="min-h-screen"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.4, ease: 'easeInOut' }}
            >
              <RequireAuth>
                <EditorRoute />
              </RequireAuth>
            </motion.div>
          }
        />
        <Route
          path="/editor/:jobId"
          element={
            <motion.div
              className="min-h-screen"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.4, ease: 'easeInOut' }}
            >
              <RequireAuth>
                <EditorRoute />
              </RequireAuth>
            </motion.div>
          }
        />
        <Route
          path="/auth"
          element={
            <motion.div
              className="min-h-screen"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
            >
              <AuthRoute />
            </motion.div>
          }
        />
        <Route
          path="/login"
          element={
            <motion.div
              className="min-h-screen"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
            >
              <AuthRoute />
            </motion.div>
          }
        />
        <Route
          path="/workspace"
          element={
            <motion.div
              className="min-h-screen"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
            >
              <RequireAuth>
                <ProjectsRoute />
              </RequireAuth>
            </motion.div>
          }
        />
        <Route
          path="/workspace/:projectId"
          element={
            <motion.div className="min-h-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease: 'easeInOut' }}>
              <RequireAuth>
                <ProjectEditorRoute />
              </RequireAuth>
            </motion.div>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AnimatePresence>
    </UploadSessionProvider>
  );
}
