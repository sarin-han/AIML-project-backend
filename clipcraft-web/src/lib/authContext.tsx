import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchCurrentUser, login as loginRequest, logout as logoutRequest, signup as signupRequest, type AuthUser } from '@/api/auth';
import { ApiError } from '@/api/client';
import { syncSession } from '@/lib/authSession';
import { clearTokens, loadAccessToken, loadRefreshToken, saveTokens } from '@/lib/authStorage';

export interface SignupInput {
  name: string;
  email: string;
  password: string;
  termsAccepted: boolean;
  marketingConsent?: boolean;
}

interface AuthContextValue {
  accessToken: string | null;
  loading: boolean;
  login: (email: string, password: string, rememberMe?: boolean) => Promise<void>;
  logout: () => Promise<void>;
  signup: (input: SignupInput) => Promise<void>;
  user: AuthUser | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}

/** 토큰 만료가 가까운지 확인하는 간격. 갱신 여부는 새로고침 시각이 아니라 토큰의 만료 시각으로 정한다. */
const SESSION_CHECK_INTERVAL_MS = 30 * 1000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!loadAccessToken() && !loadRefreshToken()) {
      setLoading(false);
      return;
    }

    // 새로고침했을 때 액세스 토큰이 만료됐거나 곧 만료되면 리프레시 토큰으로 먼저 갱신한다.
    const restore = async () => {
      let session = await syncSession();
      if (!session) return;

      let currentUser = session.user;
      if (!currentUser) {
        try {
          currentUser = await fetchCurrentUser(session.accessToken);
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 401)) throw error;
          session = await syncSession(true);
          if (!session) return;
          currentUser = session.user ?? (await fetchCurrentUser(session.accessToken));
        }
      }
      setUser(currentUser);
      setAccessToken(session.accessToken);
    };

    restore()
      // 일시적 오류라면 토큰은 남아 있어서 새로고침하면 다시 시도한다.
      .catch(() => {
        setUser(null);
        setAccessToken(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;

    const keepAlive = async () => {
      const session = await syncSession();
      if (cancelled) return;
      if (!session) {
        // 리프레시 토큰이 만료·폐기됐거나 다른 탭에서 로그아웃했다.
        setUser(null);
        setAccessToken(null);
        return;
      }
      if (session.accessToken === accessToken) return;

      // 다른 탭에서 계정을 바꿨을 수 있어 사용자 정보도 맞춘다.
      const nextUser = session.user ?? (await fetchCurrentUser(session.accessToken));
      if (cancelled) return;
      setUser((current) => (current?.id === nextUser.id ? current : nextUser));
      setAccessToken(session.accessToken);
    };

    // 일시적 오류는 다음 확인 때 다시 시도한다.
    const check = () => void keepAlive().catch(() => undefined);

    check();
    const timer = window.setInterval(check, SESSION_CHECK_INTERVAL_MS);
    // 백그라운드 탭이나 잠자기에서 돌아오면 타이머를 기다리지 않고 바로 확인한다.
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [accessToken]);

  const login = useCallback(async (email: string, password: string, rememberMe = true) => {
    const tokens = await loginRequest({ email, password, remember_me: rememberMe });
    saveTokens(tokens);
    setUser(tokens.user);
    setAccessToken(tokens.access_token);
  }, []);

  const signup = useCallback(async (input: SignupInput) => {
    const tokens = await signupRequest({
      name: input.name,
      email: input.email,
      password: input.password,
      terms_accepted: input.termsAccepted,
      marketing_consent: input.marketingConsent ?? false,
    });
    saveTokens(tokens);
    setUser(tokens.user);
    setAccessToken(tokens.access_token);
  }, []);

  const logout = useCallback(async () => {
    const refreshToken = loadRefreshToken();
    clearTokens();
    setUser(null);
    setAccessToken(null);

    if (refreshToken) {
      try {
        await logoutRequest(refreshToken);
      } catch {
        // best-effort server-side revoke; local session is already cleared
      }
    }
  }, []);

  const value = useMemo(() => ({ accessToken, loading, login, logout, signup, user }), [accessToken, loading, login, logout, signup, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
