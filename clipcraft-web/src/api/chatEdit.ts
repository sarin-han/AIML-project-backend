import { requestJson } from '@/api/client';

export type ChatEditCommand =
  | { type: 'SET_RANGE'; clip_id: number; start: number; end: number }
  | { type: 'SET_SPEED'; clip_id: number; speed: number }
  | { type: 'SET_MUTED'; clip_id: number; muted: boolean }
  | { type: 'MOVE'; clip_id: number; to_index: number }
  | { type: 'SWAP'; clip_id: number; with_clip_id: number }
  | { type: 'DELETE'; clip_id: number }
  | { type: 'ADD_SUBTITLE'; clip_id: number; text: string }
  | { type: 'SET_SUBTITLE_TEXT'; clip_id: number; text: string }
  | { type: 'DELETE_SUBTITLE'; clip_id: number }
  | { type: 'MOVE_SUBTITLE'; clip_id: number; vertical?: 'top' | 'middle' | 'bottom'; horizontal?: 'left' | 'center' | 'right' }
  | { type: 'STYLE_SUBTITLE'; clip_id: number; size_factor?: number; color?: string; box?: boolean; font?: string };

export interface ChatEditClip {
  id: number;
  scenario: string;
  title?: string;
  start: number;
  end: number;
  speed: number;
  muted: boolean;
  subtitle?: string;
}

export interface ChatEditResponse {
  reply: string;
  commands: ChatEditCommand[];
  needs_confirm: boolean;
  question: string | null;
}

interface ChatEditRequest {
  threadId: string;
  message: string;
  clips: ChatEditClip[];
  videoDuration: number;
  confirm?: boolean;
}

/** 채팅 편집 Agent(백엔드 /chat/edit)에 한 번 요청한다. */
export function requestChatEdit({ threadId, message, clips, videoDuration, confirm }: ChatEditRequest): Promise<ChatEditResponse> {
  return requestJson<ChatEditResponse>('/chat/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_id: threadId, message, clips, video_duration: videoDuration, confirm }),
  });
}

/** 녹음한 음성을 글자로 바꾼다(백엔드 /chat/transcribe). */
export async function requestVoiceTranscript(audio: Blob): Promise<string> {
  const form = new FormData();
  form.append('audio', audio, 'voice');
  const { text } = await requestJson<{ text: string }>('/chat/transcribe', { method: 'POST', body: form });
  return text;
}
