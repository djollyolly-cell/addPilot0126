import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';

interface User {
  userId: string;
  vkId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  telegramChatId?: string;
  subscriptionTier: 'freemium' | 'start' | 'pro';
  onboardingCompleted: boolean;
}

interface EmailLoginResult {
  success: boolean;
  error?: string;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: () => Promise<void>;
  loginWithEmail: (email: string, password: string) => Promise<EmailLoginResult>;
  logout: () => Promise<void>;
  setSession: (token: string) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const SESSION_KEY = 'adpilot_session';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [sessionToken, setSessionToken] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(SESSION_KEY);
    }
    return null;
  });

  const user = useQuery(
    api.auth.validateSession,
    sessionToken ? { token: sessionToken } : 'skip'
  );

  const logoutMutation = useMutation(api.auth.logout);
  const getVkAuthUrl = useAction(api.auth.getVkAuthUrl);
  const emailLoginAction = useAction(api.authEmail.loginWithEmail);

  const isLoading = sessionToken !== null && user === undefined;
  const isAuthenticated = user !== null && user !== undefined;

  const setSession = (token: string) => {
    localStorage.setItem(SESSION_KEY, token);
    setSessionToken(token);
  };

  const login = async () => {
    const { generateCodeVerifier, generateCodeChallenge, generateState, storePkceParams } = await import('./pkce');
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = generateState();
    storePkceParams(codeVerifier, state);

    const redirectUri = import.meta.env.VITE_REDIRECT_URI || `${window.location.origin}/auth/callback`;
    const authUrl = await getVkAuthUrl({ redirectUri, codeChallenge, state });
    window.location.href = authUrl;
  };

  const loginWithEmail = async (email: string, password: string): Promise<EmailLoginResult> => {
    try {
      const result = await emailLoginAction({ email, password });
      if (result.success && result.sessionToken) {
        setSession(result.sessionToken);
        return { success: true };
      }
      return { success: false, error: result.error || 'Ошибка авторизации' };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Произошла ошибка',
      };
    }
  };

  const logout = async () => {
    if (sessionToken) {
      await logoutMutation({ token: sessionToken });
      localStorage.removeItem(SESSION_KEY);
      setSessionToken(null);
    }
  };

  // Clear invalid session
  useEffect(() => {
    if (sessionToken && user === null) {
      localStorage.removeItem(SESSION_KEY);
      setSessionToken(null);
    }
  }, [sessionToken, user]);

  return (
    <AuthContext.Provider
      value={{
        user: user as User | null,
        isAuthenticated,
        isLoading,
        login,
        loginWithEmail,
        logout,
        setSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    // Return default values when used outside provider (for initial render)
    return {
      user: null,
      isAuthenticated: false,
      isLoading: true,
      login: async () => {},
      loginWithEmail: async () => ({ success: false, error: 'Not initialized' }),
      logout: async () => {},
      setSession: () => {},
    };
  }
  return context;
}
