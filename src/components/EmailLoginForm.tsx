import { useState } from 'react';
import { useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { cn } from '../lib/utils';
import { Mail, AlertCircle, ExternalLink } from 'lucide-react';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  storePkceParams,
} from '../lib/pkce';

interface EmailLoginFormProps {
  className?: string;
  onSwitchToOAuth?: () => void;
}

export function EmailLoginForm({ className, onSwitchToOAuth }: EmailLoginFormProps) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const getVkAuthUrl = useAction(api.auth.getVkAuthUrl);

  const validateEmail = (value: string): string | null => {
    if (!value.trim()) {
      return 'Введите email';
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(value)) {
      return 'Некорректный формат email';
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const validationError = validateEmail(email);
    if (validationError) {
      setError(validationError);
      return;
    }

    try {
      setIsLoading(true);

      // Generate PKCE parameters
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const state = generateState();

      // Store for callback
      storePkceParams(codeVerifier, state);

      const redirectUri = import.meta.env.VITE_REDIRECT_URI || `${window.location.origin}/auth/callback`;
      const authUrl = await getVkAuthUrl({ redirectUri, codeChallenge, state });
      // Redirect to VK ID — user will enter password on VK's login page
      window.location.href = authUrl;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Произошла ошибка. Попробуйте позже.'
      );
      setIsLoading(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className={cn('space-y-4', className)}
      data-testid="email-login-form"
    >
      {error && (
        <div
          className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm"
          data-testid="email-login-error"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Email field */}
      <div className="space-y-1">
        <label htmlFor="email" className="text-sm font-medium text-foreground">
          Email от VK Ads
        </label>
        <div className="relative">
          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (error) setError(null);
            }}
            placeholder="user@example.com"
            disabled={isLoading}
            className={cn(
              'flex h-10 w-full rounded-md border border-input bg-background pl-10 pr-3 py-2 text-sm',
              'placeholder:text-muted-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              'disabled:cursor-not-allowed disabled:opacity-50'
            )}
            data-testid="email-input"
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Вы будете перенаправлены на страницу VK для ввода пароля.
        При первом входе профиль создастся автоматически.
      </p>

      {/* Submit button */}
      <button
        type="submit"
        disabled={isLoading}
        className={cn(
          'inline-flex items-center justify-center gap-2 w-full px-6 py-3 rounded-lg font-medium transition-all',
          'bg-primary hover:bg-primary/90 text-primary-foreground',
          'disabled:opacity-50 disabled:cursor-not-allowed'
        )}
        data-testid="email-login-button"
      >
        {isLoading ? (
          <>
            <div className="w-5 h-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
            Переход на VK...
          </>
        ) : (
          <>
            Продолжить
            <ExternalLink className="h-4 w-4" />
          </>
        )}
      </button>

      {/* Switch to OAuth */}
      {onSwitchToOAuth && (
        <div className="text-center">
          <button
            type="button"
            onClick={onSwitchToOAuth}
            className="text-sm text-primary hover:underline"
            data-testid="switch-to-oauth"
          >
            Войти через VK напрямую
          </button>
        </div>
      )}
    </form>
  );
}
