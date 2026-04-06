import { useEffect, useState } from 'react';
import { useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

/**
 * GetUNIQ OAuth callback page.
 * Opened in a popup window. Extracts code from URL, exchanges for token, then closes.
 * Parent window reads result from localStorage.
 */
export default function GetUniqCallback() {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Обмен кода на токен...');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exchangeCode = useAction((api as any).agencyProviders.getuniqExchangeCode);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const error = params.get('error');

    // Read saved state from sessionStorage (set before redirect)
    const userId = sessionStorage.getItem('getuniq_userId');
    const providerId = sessionStorage.getItem('getuniq_providerId');
    const redirectUri = sessionStorage.getItem('getuniq_redirectUri');

    if (error) {
      setStatus('error');
      setMessage(`GetUNIQ отказал в доступе: ${error}`);
      localStorage.setItem('getuniq_result', JSON.stringify({ error }));
      return;
    }

    if (!code || !userId || !providerId || !redirectUri) {
      setStatus('error');
      setMessage('Отсутствуют необходимые параметры. Попробуйте заново.');
      return;
    }

    exchangeCode({
      userId: userId as Id<"users">,
      providerId: providerId as Id<"agencyProviders">,
      code,
      redirectUri,
    })
      .then(() => {
        setStatus('success');
        setMessage('Авторизация успешна! Окно закроется автоматически.');
        localStorage.setItem('getuniq_result', JSON.stringify({ success: true }));
        // Close popup after short delay
        setTimeout(() => window.close(), 1500);
      })
      .catch((err: Error) => {
        setStatus('error');
        setMessage(err.message || 'Ошибка обмена кода');
        localStorage.setItem('getuniq_result', JSON.stringify({ error: err.message }));
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="text-center space-y-4">
        {status === 'loading' && (
          <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto" />
        )}
        {status === 'success' && (
          <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto" />
        )}
        {status === 'error' && (
          <AlertCircle className="h-12 w-12 text-destructive mx-auto" />
        )}
        <p className="text-lg font-medium">{message}</p>
        {status === 'error' && (
          <button
            onClick={() => window.close()}
            className="text-sm text-primary hover:underline"
          >
            Закрыть окно
          </button>
        )}
      </div>
    </div>
  );
}
