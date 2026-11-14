/** 브라우저가 녹음할 수 있는 형식. Chrome은 webm, Safari는 mp4(m4a)만 된다. */
export function pickRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type));
}

export function isVoiceInputSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

/** 말이 끝났다고 보는 침묵 길이 */
export const SILENCE_STOP_MS = 1300;
/** 녹음을 시작하고도 아무 말이 없으면 포기하는 시간 */
export const NO_SPEECH_TIMEOUT_MS = 7000;
/** 한 번에 녹음할 수 있는 최대 길이 */
export const MAX_RECORDING_MS = 30000;
const MIN_RECORDING_MS = 600;
const MIN_SPEECH_LEVEL = 0.02;

export type VoiceStopReason = 'silence' | 'no-speech' | 'max-length';

/**
 * 목소리 크기(0~1 근처 RMS)를 계속 넣으면 "말이 끝났는지"를 알려 준다.
 * 처음 0.3초로 주변 소음 크기를 재서 기준으로 삼고, 말이 시작된 뒤 침묵이 이어지면 끝낸다.
 */
export function createSilenceDetector() {
  let startedAt: number | null = null;
  let noiseFloor = 0;
  let calibrationSamples = 0;
  let speaking = false;
  let lastVoiceAt = 0;

  return {
    /** now는 밀리초 시각. 돌려주는 값: 'speech'(말하는 중) | 'quiet'(대기) | 멈춰야 하는 이유 */
    feed(level: number, now: number): 'speech' | 'quiet' | VoiceStopReason {
      if (startedAt === null) startedAt = now;
      const elapsed = now - startedAt;

      if (elapsed < 300) {
        noiseFloor = (noiseFloor * calibrationSamples + level) / (calibrationSamples + 1);
        calibrationSamples += 1;
        return 'quiet';
      }
      if (elapsed >= MAX_RECORDING_MS) return 'max-length';

      const threshold = Math.max(MIN_SPEECH_LEVEL, noiseFloor * 2.5);
      if (level >= threshold) {
        speaking = true;
        lastVoiceAt = now;
        return 'speech';
      }
      if (!speaking) return elapsed >= NO_SPEECH_TIMEOUT_MS ? 'no-speech' : 'quiet';
      return now - lastVoiceAt >= SILENCE_STOP_MS ? 'silence' : 'speech';
    },
  };
}

export interface VoiceRecording {
  /** 녹음을 끝내고 소리 데이터를 돌려준다. 너무 짧으면 null. */
  stop: () => Promise<Blob | null>;
  /** 녹음을 버린다 */
  cancel: () => void;
}

export interface VoiceRecordingOptions {
  /** 말이 끝났거나 아무 말이 없어서 스스로 끝낼 때 부른다. 이때 stop() 또는 cancel()을 부르면 된다. */
  onAutoStop?: (reason: VoiceStopReason) => void;
  /** 지금 목소리 크기(0~1)와 말하는 중인지. 화면 표시용 */
  onLevel?: (level: number, speaking: boolean) => void;
}

/** 마이크 녹음을 시작한다. 권한은 사용자의 버튼 클릭 안에서 요청해야 Safari에서도 허용된다. */
export async function startVoiceRecording({ onAutoStop, onLevel }: VoiceRecordingOptions = {}): Promise<VoiceRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickRecordingMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  const startedAt = Date.now();

  // 목소리 크기 측정(자동 종료와 화면 표시용). 지원하지 않는 환경이면 수동 종료만 된다.
  let audioContext: AudioContext | null = null;
  let timer: number | null = null;
  const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (AudioContextClass) {
    audioContext = new AudioContextClass();
    void audioContext.resume();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const detector = createSilenceDetector();
    const autoStopDisabled = (window as unknown as { __CLIPCRAFT_NO_VOICE_AUTOSTOP__?: boolean }).__CLIPCRAFT_NO_VOICE_AUTOSTOP__ === true;
    let stopped = false;

    timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) sum += value * value;
      const level = Math.sqrt(sum / samples.length);
      const state = detector.feed(level, Date.now());
      onLevel?.(Math.min(1, level * 8), state === 'speech');
      if (state !== 'speech' && state !== 'quiet' && !stopped && !autoStopDisabled) {
        stopped = true;
        onAutoStop?.(state);
      }
    }, 60);
  }

  const release = () => {
    if (timer !== null) window.clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());
    void audioContext?.close();
  };

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.start();

  return {
    stop: () =>
      new Promise((resolve) => {
        recorder.onstop = () => {
          release();
          const tooShort = Date.now() - startedAt < MIN_RECORDING_MS;
          resolve(tooShort || chunks.length === 0 ? null : new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }));
        };
        if (recorder.state === 'inactive') recorder.onstop(new Event('stop'));
        else recorder.stop();
      }),
    cancel: () => {
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
  };
}
