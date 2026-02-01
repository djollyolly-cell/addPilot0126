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
  subscriptionExpiresAt?: number;
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
const SESSION_TIMESTAMP_KEY = 'adpilot_session_ts';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (matches server)

// Check if session is expired on client side
function isSessionExpired(): boolean {
  const timestamp = localStorage.getItem(SESSION_TIMESTAMP_KEY);
  if (!timestamp) return false;
  return Date.now() - parseInt(timestamp, 10) > SESSION_MAX_AGE_MS;
}

// Clear all auth-related data from storage
function clearAuthStorage() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_TIMESTAMP_KEY);
  // Clear any PKCE params that might be lingering
  sessionStorage.removeItem('pkce_code_verifier');
  sessionStorage.removeItem('pkce_state');
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [sessionToken, setSessionToken] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      // Check for expired session on load
      if (isSessionExpired()) {
        clearAuthStorage();
        return null;
      }
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
    localStorage.setItem(SESSION_TIMESTAMP_KEY, Date.now().toString());
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
      try {
        await logoutMutation({ token: sessionToken });
      } catch {
        // Ignore errors during logout (session might already be invalid)
      }
    }
    clearAuthStorage();
    setSessionToken(null);
  };

  // Clear invalid session
  useEffect(() => {
    if (sessionToken && user === null) {
      clearAuthStorage();
      setSessionToken(null);
    }
  }, [sessionToken, user]);

  // Sync logout across browser tabs
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === SESSION_KEY && e.newValue === null) {
        // Another tab logged out
        setSessionToken(null);
      } else if (e.key === SESSION_KEY && e.newValue && !sessionToken) {
        // Another tab logged in
        setSessionToken(e.newValue);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [sessionToken]);

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
