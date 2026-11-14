import { useEffect, useRef, useState } from 'react';
import Icon from '@/components/Icon';
import { icons } from '@/components/icons';
import { requestVoiceTranscript } from '@/api/chatEdit';
import { isVoiceInputSupported, startVoiceRecording } from '@/lib/voiceRecorder';
import type { VoiceRecording } from '@/lib/voiceRecorder';
import type { EditChatMessage } from '@/types/app';
import type { AiAssistantProps, NaturalLanguageCommandResult } from '@/types/pages/EditorScreen';

type DisplayEditChatMessage = EditChatMessage & {
  pending?: boolean;
  needsConfirm?: boolean;
};

function formatMessageTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

/** 말하는 동안 보이는 스피커 모양 표시. 목소리 크기에 따라 소리 파동이 커진다. */
function SpeakerSticker({ accent, hearing, level, transcribing }: { accent: string; hearing: boolean; level: number; transcribing: boolean }) {
  const wave = (strength: number) => (transcribing ? 0.25 : Math.min(1, 0.18 + level * strength));
  return (
    <div className="relative flex h-11 w-11 flex-none items-center justify-center rounded-full" style={{ background: `${accent}1f` }}>
      <span
        className="absolute inset-0 rounded-full"
        style={{ border: `2px solid ${accent}`, opacity: hearing ? 0.35 : 0.15, transform: `scale(${1 + (transcribing ? 0 : level * 0.35)})`, transition: 'transform 80ms linear, opacity 160ms' }}
      />
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={transcribing ? { animation: 'edit-chat-loading-dot 900ms infinite ease-in-out' } : undefined}>
        <path d="M11 5L6 9H3v6h3l5 4V5z" fill={`${accent}33`} />
        <path d="M15.5 9a4 4 0 010 6" style={{ opacity: wave(2.5), transition: 'opacity 80ms linear' }} />
        <path d="M18 6.5a8 8 0 010 11" style={{ opacity: wave(1.6), transition: 'opacity 80ms linear' }} />
      </svg>
    </div>
  );
}

export default function AiAssistant({ accent, onApplyCommand, onClose, onReset }: AiAssistantProps) {
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<DisplayEditChatMessage[]>([]);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  const recordingRef = useRef<VoiceRecording | null>(null);
  const [voice, setVoice] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceSupported = isVoiceInputSupported();

  useEffect(() => {
    const chatScroll = chatScrollRef.current;
    if (!chatScroll) return;

    window.requestAnimationFrame(() => {
      chatScroll.scrollTop = chatScroll.scrollHeight;
    });
  }, [messages]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recordingRef.current?.cancel();
    };
  }, []);

  const sendMessage = async (text: string = draft, confirm?: boolean) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const loadingId = now + 1;

    // 확인 버튼은 이전 질문에 대한 답이므로 버튼을 없앤다
    setMessages((current) => [
      ...current.map((message) => (message.needsConfirm ? { ...message, needsConfirm: false } : message)),
      { id: now, role: 'user', content: trimmed, createdAt },
      { id: loadingId, role: 'system', content: '', createdAt, pending: true },
    ]);
    setDraft('');
    setBusy(true);

    let result: NaturalLanguageCommandResult;
    try {
      result = await onApplyCommand(trimmed, confirm);
    } catch {
      result = { status: 'error', message: '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.' };
    }
    if (!mountedRef.current) return;

    setMessages((current) =>
      current.map((message) => (message.id === loadingId ? { id: loadingId, role: 'system', content: result.message, createdAt, needsConfirm: result.needsConfirm } : message)),
    );
    setBusy(false);
  };

  const [voiceLevel, setVoiceLevel] = useState(0);
  const [voiceHearing, setVoiceHearing] = useState(false);

  /** 녹음을 끝내고 글자로 바꾼 뒤 채팅처럼 바로 보낸다. 직접 눌러도, 말이 끝나서 자동으로도 여기로 온다. */
  const finishVoice = async (discard = false, notice?: string) => {
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (!recording) return;
    setVoiceLevel(0);
    setVoiceHearing(false);

    if (discard) {
      recording.cancel();
      setVoice('idle');
      if (notice) setVoiceError(notice);
      return;
    }

    setVoice('transcribing');
    try {
      const audio = await recording.stop();
      if (!audio) {
        setVoiceError('소리가 너무 짧아요. 마이크를 누르고 말해 주세요.');
        return;
      }
      const text = await requestVoiceTranscript(audio);
      if (!mountedRef.current) return;
      if (!text) setVoiceError('말씀을 알아듣지 못했어요. 다시 말해 주세요.');
      else await sendMessage(text);
    } catch (error) {
      if (mountedRef.current) setVoiceError(error instanceof Error ? error.message : '음성을 글자로 바꾸지 못했어요.');
    } finally {
      if (mountedRef.current) setVoice('idle');
    }
  };

  /** 마이크 버튼: 누르면 듣기 시작한다. 말이 끝나면 자동으로 보내고, 직접 다시 눌러도 바로 보낸다. */
  const toggleVoice = async () => {
    setVoiceError(null);
    if (voice === 'recording') {
      await finishVoice();
      return;
    }

    if (voice !== 'idle' || busy) return;
    try {
      recordingRef.current = await startVoiceRecording({
        onLevel: (level, speaking) => {
          if (!mountedRef.current) return;
          setVoiceLevel(level);
          setVoiceHearing(speaking);
        },
        onAutoStop: (reason) => {
          if (!mountedRef.current) return;
          if (reason === 'no-speech') void finishVoice(true, '말소리가 들리지 않아서 듣기를 멈췄어요. 다시 눌러 말해 주세요.');
          else void finishVoice();
        },
      });
      setVoice('recording');
    } catch (error) {
      const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      setVoiceError(denied ? '마이크 권한이 필요해요. 브라우저 주소창에서 마이크를 허용해 주세요.' : '마이크를 사용할 수 없어요.');
    }
  };

  const clearHistory = () => {
    setMessages([]);
    setBusy(false);
    onReset?.();
  };

  return (
    <aside className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-[rgba(0,0,0,0.08)] px-[18px] py-3.5">
        <div className="flex h-6 w-6 items-center justify-center rounded-full" style={{ background: accent }}>
          <Icon d={icons.bot} size={12} stroke="#fff" />
        </div>
        <span className="text-[13px] font-[540] tracking-[-0.2px]">AI 어시스턴트</span>
        <div className="flex-1" />
        <button
          className="cursor-pointer rounded-full border border-[rgba(0,0,0,0.1)] bg-white px-2.5 py-1 text-[11px] font-[480] text-black/45 transition-colors hover:text-black/70 disabled:cursor-default disabled:opacity-35"
          disabled={messages.length === 0}
          onClick={clearHistory}
          type="button"
        >
          기록 초기화
        </button>
        {onClose && (
          <button aria-label="AI 어시스턴트 닫기" className="cursor-pointer border-0 bg-transparent p-1 text-[16px] leading-none text-black/35 hover:text-black/70" onClick={onClose} type="button">
            ×
          </button>
        )}
      </div>

      <div ref={chatScrollRef} className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3.5">
        <style>{`@keyframes edit-chat-message-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } } @keyframes edit-chat-loading-dot { 0%, 80%, 100% { opacity: 0.25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }`}</style>
        {messages.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-[12px] leading-[1.5] text-black/30">
            어떤 장면을 편집할까요? <br />
            원하는 장면과 편집 내용을 입력해보세요
          </div>
        ) : (
          messages.map((message) => {
            const isUser = message.role === 'user';

            return (
              <div key={message.id} className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`} style={{ animation: 'edit-chat-message-in 180ms ease-out both' }}>
                <div
                  className="max-w-[88%] rounded-[10px] px-3 py-2 text-[12.5px] leading-[1.45] break-words"
                  style={{
                    background: isUser ? accent : 'rgba(0,0,0,0.05)',
                    color: isUser ? '#fff' : 'rgba(0,0,0,0.72)',
                  }}
                >
                  {message.pending ? (
                    <span className="flex h-[18px] items-center gap-1">
                      {[0, 1, 2].map((dot) => (
                        <span
                          key={dot}
                          className="h-1.5 w-1.5 rounded-full bg-black/35"
                          style={{ animation: `edit-chat-loading-dot 900ms ${dot * 120}ms infinite ease-in-out` }}
                        />
                      ))}
                    </span>
                  ) : (
                    message.content
                  )}
                </div>
                {message.needsConfirm && (
                  <div className="flex gap-1.5">
                    <button className="cursor-pointer rounded-full border-0 px-3 py-1 text-[11.5px] font-[540] text-white disabled:opacity-40" data-testid="chat-confirm-yes" disabled={busy} onClick={() => void sendMessage('응', true)} style={{ background: accent }} type="button">
                      응
                    </button>
                    <button className="cursor-pointer rounded-full border border-[rgba(0,0,0,0.12)] bg-white px-3 py-1 text-[11.5px] font-[480] text-black/60 disabled:opacity-40" data-testid="chat-confirm-no" disabled={busy} onClick={() => void sendMessage('아니', false)} type="button">
                      아니
                    </button>
                  </div>
                )}
                {!message.pending && <div className="px-1 font-mono text-[9.5px] text-black/25">{formatMessageTime(message.createdAt)}</div>}
              </div>
            );
          })
        )}
      </div>

      <div className="border-t border-[rgba(0,0,0,0.08)] px-3.5 py-2.5">
        {voice !== 'idle' && (
          <div className="mb-2 flex items-center gap-3 rounded-2xl border border-[rgba(0,0,0,0.08)] bg-[rgba(0,0,0,0.025)] px-3.5 py-2.5" data-testid="chat-voice-status" data-voice={voice} style={{ animation: 'edit-chat-message-in 180ms ease-out both' }}>
            <SpeakerSticker accent={accent} hearing={voiceHearing} level={voiceLevel} transcribing={voice === 'transcribing'} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[12.5px] font-[540] tracking-[-0.2px] text-black/75">
                {voice === 'transcribing' ? '글자로 바꾸는 중…' : voiceHearing ? '듣고 있어요' : '말씀하세요'}
              </span>
              <span className="text-[11px] text-black/40">{voice === 'transcribing' ? '잠시만요' : '말이 끝나면 자동으로 보내요'}</span>
            </div>
            {voice === 'recording' && (
              <button className="cursor-pointer rounded-full border border-[rgba(0,0,0,0.12)] bg-white px-2.5 py-1 text-[11px] font-[480] text-black/55 hover:text-black/80" data-testid="chat-voice-cancel" onClick={() => void finishVoice(true)} type="button">
                취소
              </button>
            )}
          </div>
        )}
        {voice === 'idle' && voiceError && (
          <div className="px-1 pb-1.5 text-[11px]" data-testid="chat-voice-status" style={{ color: '#C0392B' }}>
            {voiceError}
          </div>
        )}
        <div className="flex items-center gap-2 rounded-full border border-[rgba(0,0,0,0.12)] py-[7px] pr-[7px] pl-3.5">
          <input
            data-testid="chat-input"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void sendMessage();
            }}
            placeholder="예: 끓이는 장면 2배속 해줘"
            className="flex-1 border-0 bg-transparent text-[12.5px] outline-none"
            value={draft}
          />
          {voiceSupported && (
            <button
              aria-label={voice === 'recording' ? '말 끝내고 보내기' : '음성으로 말하기'}
              aria-pressed={voice === 'recording'}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-[rgba(0,0,0,0.12)] bg-white p-0 disabled:cursor-default disabled:opacity-40"
              data-testid="chat-voice-button"
              disabled={busy || voice === 'transcribing'}
              onClick={() => void toggleVoice()}
              style={voice === 'recording' ? { background: accent, borderColor: accent } : undefined}
              title={voice === 'recording' ? '지금 바로 보내기' : '음성으로 편집 (말이 끝나면 자동으로 보내요)'}
              type="button"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={voice === 'recording' ? '#fff' : 'rgba(0,0,0,0.6)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="3" width="6" height="12" rx="3" />
                <path d="M5 11a7 7 0 0014 0M12 18v3" />
              </svg>
            </button>
          )}
          <button data-testid="chat-send-button" className="flex h-7 cursor-pointer items-center gap-1.5 rounded-full border-0 px-3 text-[11.5px] font-[540] text-white" onClick={() => void sendMessage()} disabled={busy} style={{ background: accent }} type="button">
            <Icon d={icons.send} size={11} stroke="#fff" />
          </button>
        </div>
      </div>
    </aside>
  );
}
