import type { AuthTokens } from '@/api/auth';

const ACCESS_TOKEN_KEY = 'auth-access-token';
const REFRESH_TOKEN_KEY = 'auth-refresh-token';
const ACCESS_EXPIRES_AT_KEY = 'auth-access-expires-at';

function readItem(key: string): string | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function loadAccessToken(): string | null {
  return readItem(ACCESS_TOKEN_KEY);
}

export function loadRefreshToken(): string | null {
  return readItem(REFRESH_TOKEN_KEY);
}

/** 액세스 토큰이 만료되는 시각(이 기기의 시계 기준, ms). 모르면 null */
export function loadAccessTokenExpiresAt(): number | null {
  const value = Number(readItem(ACCESS_EXPIRES_AT_KEY));
  return value > 0 ? value : null;
}

export function saveTokens({ access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn }: AuthTokens): void {
  try {
    // 서버 시각과 기기 시계가 어긋나도 맞도록, 받은 시점에 유효 시간(초)을 더해 둔다.
    window.localStorage.setItem(ACCESS_EXPIRES_AT_KEY, String(Date.now() + expiresIn * 1000));
    window.localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    window.localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  } catch {
    // localStorage may be unavailable in restricted browser contexts.
  }
}

export function clearTokens(): void {
  try {
    window.localStorage.removeItem(ACCESS_TOKEN_KEY);
    window.localStorage.removeItem(REFRESH_TOKEN_KEY);
    window.localStorage.removeItem(ACCESS_EXPIRES_AT_KEY);
  } catch {
    // localStorage may be unavailable in restricted browser contexts.
  }
}
