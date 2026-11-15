import { AnimatePresence, motion } from 'framer-motion';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { Location, NavigateFunction } from 'react-router-dom';
import AnalyzingScreen from '@/pages/AnalyzingScreen';
import AuthScreen from '@/pages/AuthScreen';
import HighlightResultScreen from '@/pages/HighlightResultScreen';
import EditorScreen from '@/pages/EditorScreen';
import LandingScreen from '@/pages/LandingScreen';
import ProjectsScreen from '@/pages/ProjectsScreen';
import UploadScreen from '@/pages/UploadScreen';
import { pageTransition } from '@/lib/animations';
import { UploadSessionProvider } from '@/state/UploadSession';
import type { HighlightAnalysisResult, HighlightExtractionResult, PendingHighlightAnalysis } from '@/types/app';

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
  const routeState = location.state as { format?: string; projectName?: string } | null;

  return (
    <UploadScreen
      initialProjectFormat={routeState?.format}
      initialProjectName={routeState?.projectName}
      onLogoClick={() => navigate('/')}
      onNext={(result) => navigate('/analyzing', { state: result })}
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
      onDone={(result) => navigate(editorPath(result.jobId), { state: result })}
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
      onNext={(analysis) => navigate(editorPath(analysis.jobId), { state: analysis })}
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
      onBack={() => navigate('/upload')}
    />
  );
}

function AuthRoute() {
  const navigate = useNavigate();
  return <AuthScreen onContinue={() => navigate('/workspace')} onLogoClick={() => navigate('/')} />;
}

function ProjectsRoute() {
  const navigate = useNavigate();
  return <ProjectsScreen onLogoClick={() => navigate('/')} onStartNewProject={(project) => navigate('/upload', { state: project })} />;
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
              <UploadRoute />
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
              <AnalyzingRoute />
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
              <HighlightResultRoute />
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
              <EditorRoute />
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
              <EditorRoute />
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
              <ProjectsRoute />
            </motion.div>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AnimatePresence>
    </UploadSessionProvider>
  );
}
