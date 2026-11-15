import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useTheme } from '@/App';
import PillButton from '@/components/PillButton';
import UploadHeader from '@/components/UploadScreen/UploadHeader';
import StepIndicator from '@/components/UploadScreen/StepIndicator';
import VideoUploadPanel from '@/components/UploadScreen/VideoUploadPanel';
import MethodPanel from '@/components/UploadScreen/MethodPanel';
import { containerStagger, fadeInUp } from '@/lib/animations';
import { cn } from '@/lib/cn';
import { captureVideoThumbnail, formatDuration, formatFileSize, isVideoFile, loadVideoDuration, MAX_VIDEO_DURATION_SECONDS } from '@/lib/videoUpload';
import { useUploadSession } from '@/state/UploadSession';
import type { UploadScreenProps, UploadStatus } from '@/types/pages/UploadScreen';

export default function UploadFlow({ initialProjectName, onBack, onNext }: UploadScreenProps) {
  const { accent, density } = useTheme();
  const fileInputId = useId();
  const shouldReduceMotion = useReducedMotion();
  const panelPadding = density === 'compact' ? 'p-5' : density === 'spacious' ? 'p-9' : 'p-7';
  const accentTint = `${accent}18`;

  // 올린 영상·고른 방법·입력한 장면은 화면 밖에 있어서 다른 화면에 다녀와도 남는다.
  const { uploadedVideo, setUploadedVideo, method, setMethod, items, setItems, projectTitle, setProjectTitle } = useUploadSession();
  // 프로젝트 목록에서 이어 연 프로젝트면 그 이름으로 채워 둔다.
  useEffect(() => {
    if (initialProjectName?.trim()) setProjectTitle(initialProjectName.trim());
  }, [initialProjectName, setProjectTitle]);
  const trimmedTitle = projectTitle.trim();

  const [selectedFile, setSelectedFile] = useState<File | null>(uploadedVideo?.file ?? null);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>(uploadedVideo ? 'success' : 'idle');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState(0);
  const scrollPositionRef = useRef<number>(0);

  useEffect(() => {
    if (uploadStatus !== 'loading') {
      setUploadPct(0);
      return;
    }
    let pct = 0;
    const timer = window.setInterval(() => {
      pct += Math.random() * 10 + (pct < 60 ? 5 : 1.5);
      if (pct >= 90) {
        window.clearInterval(timer);
        pct = 90;
      }
      setUploadPct(Math.round(Math.min(90, pct)));
    }, 120);
    return () => window.clearInterval(timer);
  }, [uploadStatus]);

  const hasUploadedVideo = uploadStatus === 'success' && uploadedVideo !== null;

  useLayoutEffect(() => {
    if (hasUploadedVideo) {
      window.scrollTo(0, scrollPositionRef.current);
    }
  }, [hasUploadedVideo]);

  const useEmptyStateDesign = !hasUploadedVideo;
  const isHighlightMethod = method === 'highlight';
  const hasScenario = items.length > 0;
  const canStart = hasUploadedVideo && trimmedTitle.length > 0 && (isHighlightMethod || hasScenario);

  const triggerUploadError = (message: string) => {
    setUploadError(message);
    setUploadStatus('idle');
    setSelectedFile(null);
    setUploadedVideo(null);
  };

  const processVideoFile = async (file: File) => {
    scrollPositionRef.current = window.scrollY;
    setUploadError(null);
    setUploadedVideo(null);
    setSelectedFile(file);

    if (!isVideoFile(file)) {
      triggerUploadError('동영상 파일만 업로드할 수 있습니다');
      return;
    }

    setUploadStatus('loading');
    const objectUrl = URL.createObjectURL(file);

    try {
      const duration = await loadVideoDuration(objectUrl);

      if (duration > MAX_VIDEO_DURATION_SECONDS) {
        URL.revokeObjectURL(objectUrl);
        triggerUploadError('15분 이내의 동영상만 업로드할 수 있습니다');
        return;
      }

      const thumbnailUrl = await captureVideoThumbnail(objectUrl, duration);
      setUploadedVideo({ file, fileName: file.name, duration, durationLabel: formatDuration(duration), sizeLabel: formatFileSize(file.size), thumbnailUrl, objectUrl });
      setSelectedFile(file);
      setUploadStatus('success');
      setUploadError(null);
    } catch {
      URL.revokeObjectURL(objectUrl);
      triggerUploadError('동영상 파일만 업로드할 수 있습니다');
    }
  };

  const startAnalysis = () => {
    if (!uploadedVideo || !canStart) return;
    onNext({
      file: uploadedVideo.file,
      projectName: trimmedTitle,
      mode: isHighlightMethod ? 'highlight' : 'scenario',
      scenarios: isHighlightMethod ? [] : items,
      videoPath: '',
      videoUrl: uploadedVideo.objectUrl,
      videoName: uploadedVideo.fileName,
      videoDuration: uploadedVideo.duration,
    });
  };

  const ctaLabel = isHighlightMethod ? '하이라이트 추출하기' : `시나리오로 장면 찾기${items.length ? ` · ${items.length}개` : ''}`;
  const checklist: [string, boolean][] = isHighlightMethod
    ? [
        ['프로젝트 제목', trimmedTitle.length > 0],
        ['영상 업로드', hasUploadedVideo],
      ]
    : [
        ['프로젝트 제목', trimmedTitle.length > 0],
        ['영상 업로드', hasUploadedVideo],
        ['장면 1개 이상', hasScenario],
      ];

  return (
    <motion.div
      className="flex min-h-screen w-full flex-col items-center bg-canvas px-16 pt-9 pb-20 max-[760px]:px-5"
      variants={containerStagger}
      initial={shouldReduceMotion ? false : 'hidden'}
      animate={shouldReduceMotion ? undefined : 'visible'}
    >
      <UploadHeader onBack={onBack} projectTitle={projectTitle} onProjectTitleChange={setProjectTitle} useEmptyStateDesign={useEmptyStateDesign} />

      <StepIndicator />

      <motion.div className={cn('upload-panels grid w-full grid-cols-2 gap-4 max-[760px]:grid-cols-1', useEmptyStateDesign ? 'mb-8' : 'mb-10')} variants={containerStagger}>
        <VideoUploadPanel
          accent={accent}
          panelPadding={panelPadding}
          accentTint={accentTint}
          fileInputId={fileInputId}
          hasUploadedVideo={hasUploadedVideo}
          uploadedVideo={uploadedVideo}
          uploadStatus={uploadStatus}
          uploadError={uploadError}
          uploadPct={uploadPct}
          selectedFile={selectedFile}
          useEmptyStateDesign={useEmptyStateDesign}
          onFileSelect={(file) => void processVideoFile(file)}
        />
        <MethodPanel
          accent={accent}
          panelPadding={panelPadding}
          accentTint={accentTint}
          method={method}
          onMethodChange={setMethod}
          items={items}
          onItemsChange={setItems}
          videoFile={hasUploadedVideo ? uploadedVideo.file : null}
          videoDurationLabel={hasUploadedVideo ? uploadedVideo.durationLabel : undefined}
          projectName={trimmedTitle || undefined}
        />
      </motion.div>

      <motion.div className="flex flex-col items-center gap-3 will-change-[transform,opacity]" variants={fadeInUp}>
        <motion.div
          className="inline-block rounded-full"
          animate={
            shouldReduceMotion
              ? undefined
              : {
                  boxShadow: canStart
                    ? ['0 0 0 rgba(0,0,0,0)', `0 10px 28px ${accent}24`, `0 6px 18px ${accent}18`]
                    : [`0 6px 18px ${accent}18`, '0 0 0 rgba(0,0,0,0)', '0 0 0 rgba(0,0,0,0)'],
                }
          }
          transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
        >
          <PillButton
            variant="accent"
            onClick={startAnalysis}
            icon={isHighlightMethod ? 'zap' : 'wand'}
            disabled={!canStart}
            testId="analyze-start-button"
            className="px-10 py-3.5 [font-family:'Plus_Jakarta_Sans','Noto_Sans_KR',sans-serif] text-base font-bold tracking-[-0.3px]"
          >
            {ctaLabel}
          </PillButton>
        </motion.div>

        {!canStart && (
          <div className="flex items-center gap-4" data-testid="start-checklist">
            {checklist.map(([text, ok], index) => (
              <div key={text} className="flex items-center gap-4">
                {index > 0 && <span className="h-px w-4 bg-[rgba(0,0,0,0.1)]" />}
                <span className="flex items-center gap-[5px] text-xs text-ink-56">
                  <span
                    className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full"
                    style={{ border: `1.5px solid ${ok ? accent : 'rgba(0,0,0,0.28)'}` }}
                  >
                    {ok && <span className="h-1.5 w-1.5 rounded-full" style={{ background: accent }} />}
                  </span>
                  {text}
                </span>
              </div>
            ))}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
