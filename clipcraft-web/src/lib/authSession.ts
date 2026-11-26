import { refreshTokens, type AuthUser } from '@/api/auth';
import { ApiError } from '@/api/client';
import { clearTokens, loadAccessToken, loadAccessTokenExpiresAt, loadRefreshToken, saveTokens } from '@/lib/authStorage';

/** 액세스 토큰(15분 유효)의 남은 시간이 이보다 짧으면 갱신한다 */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface AuthSession {
  accessToken: string;
  /** 이번에 갱신한 경우에만 있다 */
  user?: AuthUser;
}

let queue: Promise<unknown> = Promise.resolve();

// 리프레시 토큰은 한 번만 쓸 수 있어서 갱신이 겹치면 늦은 쪽이 401을 받는다. 탭끼리는 Web Locks로,
// Web Locks가 없는 환경(HTTP 접속 등)에서는 적어도 한 탭 안에서 차례로 실행한다.
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('auth-refresh', task) as Promise<T>;
  }
  const next = queue.then(task);
  queue = next.catch(() => undefined);
  return next;
}

function storedSession(): AuthSession | null {
  const accessToken = loadAccessToken();
  return accessToken ? { accessToken } : null;
}

/**
 * 지금 쓸 수 있는 로그인 상태를 돌려준다. 만료가 가깝거나 만료 시각을 모르면(또는 force) 먼저 갱신한다.
 * 로그인이 끝났으면 null. 네트워크 같은 일시적 오류로 갱신하지 못했고 쓸 토큰도 없으면 예외를 던진다.
 */
export function syncSession(force = false): Promise<AuthSession | null> {
  return exclusive(async () => {
    const accessToken = loadAccessToken();
    const expiresAt = loadAccessTokenExpiresAt();
    // 다른 탭이 이미 갱신해 두었으면 그 토큰을 그대로 쓴다.
    if (!force && accessToken && expiresAt !== null && expiresAt - Date.now() > REFRESH_MARGIN_MS) return { accessToken };

    const refreshToken = loadRefreshToken();
    if (!refreshToken) {
      clearTokens();
      return null;
    }

    try {
      const tokens = await refreshTokens(refreshToken);
      // 요청하는 동안 로그아웃하거나 다시 로그인했으면 받은 토큰은 버린다.
      if (loadRefreshToken() !== refreshToken) return storedSession();
      saveTokens(tokens);
      return { accessToken: tokens.access_token, user: tokens.user };
    } catch (error) {
      if (loadRefreshToken() !== refreshToken) return storedSession();
      if (error instanceof ApiError && error.status === 401) {
        clearTokens();
        return null;
      }
      // 일시적 오류: 아직 만료되지 않은(또는 만료 시각을 모르는) 토큰은 계속 쓰고 다음 확인 때 다시 시도한다.
      if (accessToken && (expiresAt === null || expiresAt > Date.now())) return { accessToken };
      throw error;
    }
  });
}
