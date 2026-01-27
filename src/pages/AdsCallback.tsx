import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

// VK Ads now uses Client Credentials Grant (no redirect needed).
// This page is kept as a fallback redirect to /accounts.
export function AdsCallback() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate('/accounts', { replace: true });
  }, [navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
        <p className="text-muted-foreground">Перенаправление...</p>
      </div>
    </div>
  );
}
