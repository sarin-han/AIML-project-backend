import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchCurrentUser, login as loginRequest, refreshTokens, logout as logoutRequest, signup as signupRequest, type AuthTokens, type AuthUser } from '@/api/auth';
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

/** 액세스 토큰은 15분만 유효하므로 만료되기 전에 갱신한다 */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

function applyTokens(tokens: AuthTokens): void {
  saveTokens(tokens.access_token, tokens.refresh_token);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = loadAccessToken();
    const refreshToken = loadRefreshToken();

    if (!token && !refreshToken) {
      setLoading(false);
      return;
    }

    const restoreFromRefresh = async () => {
      if (!refreshToken) throw new Error('no refresh token');
      const tokens = await refreshTokens(refreshToken);
      applyTokens(tokens);
      setUser(tokens.user);
      setAccessToken(tokens.access_token);
    };

    // 새로고침했을 때 액세스 토큰이 만료돼 있으면 리프레시 토큰으로 로그인 상태를 되살린다.
    (token ? fetchCurrentUser(token).then((currentUser) => {
      setUser(currentUser);
      setAccessToken(token);
    }) : Promise.reject(new Error('no access token')))
      .catch(() => restoreFromRefresh())
      .catch(() => {
        clearTokens();
        setUser(null);
        setAccessToken(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!accessToken) return;

    const timer = window.setInterval(() => {
      const refreshToken = loadRefreshToken();
      if (!refreshToken) return;

      refreshTokens(refreshToken)
        .then((tokens) => {
          applyTokens(tokens);
          setAccessToken(tokens.access_token);
        })
        .catch(() => {
          // 리프레시 토큰이 만료·폐기됐으면 로그아웃 상태로 돌린다.
          clearTokens();
          setUser(null);
          setAccessToken(null);
        });
    }, REFRESH_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [accessToken]);

  const login = useCallback(async (email: string, password: string, rememberMe = true) => {
    const tokens = await loginRequest({ email, password, remember_me: rememberMe });
    applyTokens(tokens);
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
    applyTokens(tokens);
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
