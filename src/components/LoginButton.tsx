import { useState } from 'react';
import { useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { cn } from '../lib/utils';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  storePkceParams,
} from '../lib/pkce';

interface LoginButtonProps {
  className?: string;
}

export function LoginButton({ className }: LoginButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const getVkAuthUrl = useAction(api.auth.getVkAuthUrl);

  const handleLogin = async () => {
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
      window.location.href = authUrl;
    } catch (error) {
      console.error('Failed to get auth URL:', error);
      setIsLoading(false);
    }
  };

  return (
    <button
      onClick={handleLogin}
      disabled={isLoading}
      className={cn(
        'inline-flex items-center justify-center gap-3 px-6 py-3 rounded-lg font-medium transition-all',
        'bg-vk hover:bg-vk-dark text-white',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        className
      )}
      data-testid="login-button"
    >
      {isLoading ? (
        <>
          <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          Подключение...
        </>
      ) : (
        <>
          <VkIcon className="w-5 h-5" />
          Войти через VK
        </>
      )}
    </button>
  );
}

function VkIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12.785 16.241s.288-.032.436-.194c.136-.148.132-.427.132-.427s-.02-1.304.576-1.496c.588-.19 1.341 1.26 2.14 1.818.605.422 1.064.33 1.064.33l2.137-.03s1.117-.071.587-.964c-.043-.073-.308-.661-1.588-1.87-1.34-1.264-1.16-1.059.453-3.246.983-1.332 1.376-2.145 1.253-2.493-.117-.332-.84-.244-.84-.244l-2.406.015s-.178-.025-.31.056c-.13.079-.212.264-.212.264s-.382 1.03-.89 1.907c-1.07 1.85-1.499 1.948-1.674 1.832-.407-.267-.305-1.075-.305-1.648 0-1.793.267-2.54-.521-2.733-.262-.065-.454-.107-1.123-.114-.858-.009-1.585.003-1.996.208-.274.136-.485.44-.356.457.159.022.519.099.71.363.246.341.237 1.107.237 1.107s.142 2.11-.33 2.371c-.324.18-.768-.187-1.72-1.862-.487-.857-.855-1.804-.855-1.804s-.07-.177-.197-.272c-.154-.116-.369-.152-.369-.152l-2.286.015s-.343.01-.469.162c-.112.135-.009.414-.009.414s1.781 4.232 3.8 6.36c1.851 1.951 3.953 1.823 3.953 1.823h.953z" />
    </svg>
  );
}
