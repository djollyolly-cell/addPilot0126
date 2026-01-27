import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { getPkceParams, clearPkceParams } from '../lib/pkce';

export function AuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const exchangeCode = useAction(api.auth.exchangeCodeForToken);
  const { setSession } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check for OAuth error
    const errorParam = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    if (errorParam) {
      console.error('OAuth error:', errorParam, errorDescription);
      clearPkceParams();
      navigate(`/login?error=cancelled`, { replace: true });
      return;
    }

    // VK ID returns code and device_id in query params
    const code = searchParams.get('code');
    const deviceId = searchParams.get('device_id') || '';
    const stateParam = searchParams.get('state') || '';

    if (!code) {
      clearPkceParams();
      navigate('/login?error=invalid_code', { replace: true });
      return;
    }

    // Get PKCE params from sessionStorage
    const { codeVerifier, state: storedState } = getPkceParams();

    if (!codeVerifier) {
      clearPkceParams();
      navigate('/login?error=missing_verifier', { replace: true });
      return;
    }

    // Validate state to prevent CSRF
    if (storedState && stateParam && storedState !== stateParam) {
      console.error('State mismatch:', storedState, stateParam);
      clearPkceParams();
      navigate('/login?error=state_mismatch', { replace: true });
      return;
    }

    const handleCallback = async () => {
      try {
        const redirectUri = import.meta.env.VITE_REDIRECT_URI || `${window.location.origin}/auth/callback`;
        const result = await exchangeCode({
          code,
          redirectUri,
          codeVerifier,
          deviceId,
          state: stateParam,
        });

        clearPkceParams();

        if (result.success && result.sessionToken) {
          setSession(result.sessionToken);
          navigate('/profile', { replace: true });
        } else {
          navigate('/login?error=token_error', { replace: true });
        }
      } catch (err) {
        console.error('Auth callback error:', err);
        clearPkceParams();
        setError(err instanceof Error ? err.message : 'Unknown error');
        setTimeout(() => {
          navigate('/login?error=token_error', { replace: true });
        }, 3000);
      }
    };

    handleCallback();
  }, [searchParams, navigate, exchangeCode, setSession]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center">
        {error ? (
          <div className="space-y-4">
            <div className="text-destructive text-lg">Ошибка авторизации</div>
            <p className="text-muted-foreground">{error}</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
            <p className="text-muted-foreground">Выполняется авторизация...</p>
          </div>
        )}
      </div>
    </div>
  );
}
