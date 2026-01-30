import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LoginButton } from '../components/LoginButton';
import { EmailLoginForm } from '../components/EmailLoginForm';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Wallet, Shield, Bell, BarChart3 } from 'lucide-react';
import { cn } from '../lib/utils';

type LoginMode = 'oauth' | 'email';

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const error = searchParams.get('error');
  const [loginMode, setLoginMode] = useState<LoginMode>('oauth');

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col">
      {/* Header */}
      <header className="p-6">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 bg-primary rounded-lg flex items-center justify-center">
            <Wallet className="w-6 h-6 text-primary-foreground" />
          </div>
          <span className="text-2xl font-bold text-foreground">AddPilot</span>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <Card className="shadow-xl" data-testid="login-card">
            <CardHeader className="text-center">
              <CardTitle className="text-2xl">Добро пожаловать</CardTitle>
              <CardDescription>
                AddPilot сохраняет ваш бюджет, пока вы спите
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Login mode tabs */}
              <div className="flex rounded-lg bg-muted p-1" data-testid="login-mode-tabs">
                <button
                  type="button"
                  onClick={() => setLoginMode('oauth')}
                  className={cn(
                    'flex-1 py-2 px-3 rounded-md text-sm font-medium transition-all',
                    loginMode === 'oauth'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  data-testid="tab-oauth"
                >
                  VK OAuth
                </button>
                <button
                  type="button"
                  onClick={() => setLoginMode('email')}
                  className={cn(
                    'flex-1 py-2 px-3 rounded-md text-sm font-medium transition-all',
                    loginMode === 'email'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  data-testid="tab-email"
                >
                  Email
                </button>
              </div>

              {error && (
                <div
                  className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm"
                  data-testid="login-error"
                >
                  {error === 'invalid_code' && 'Невалидный код авторизации. Попробуйте снова.'}
                  {error === 'cancelled' && 'Авторизация была отменена.'}
                  {error === 'token_error' && 'Ошибка получения токена. Попробуйте снова.'}
                  {!['invalid_code', 'cancelled', 'token_error'].includes(error) &&
                    'Произошла ошибка. Попробуйте снова.'}
                </div>
              )}

              {loginMode === 'oauth' ? (
                <>
                  <LoginButton className="w-full" />
                  <p className="text-xs text-center text-muted-foreground">
                    Нет аккаунта? Он создастся автоматически при первом входе
                  </p>
                  <div className="text-center">
                    <button
                      type="button"
                      onClick={() => setLoginMode('email')}
                      className="text-sm text-primary hover:underline"
                      data-testid="switch-to-email"
                    >
                      Войти по Email
                    </button>
                  </div>
                </>
              ) : (
                <EmailLoginForm
                  onSwitchToOAuth={() => setLoginMode('oauth')}
                />
              )}

              <p className="text-xs text-center text-muted-foreground">
                Нажимая кнопку, вы соглашаетесь с{' '}
                <a href="#" className="underline hover:text-foreground">
                  условиями использования
                </a>{' '}
                и{' '}
                <a href="#" className="underline hover:text-foreground">
                  политикой конфиденциальности
                </a>
              </p>
            </CardContent>
          </Card>

          {/* Features */}
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <FeatureCard
              icon={Shield}
              title="Защита"
              description="24/7 мониторинг"
            />
            <FeatureCard
              icon={Bell}
              title="Уведомления"
              description="Мгновенные алерты"
            />
            <FeatureCard
              icon={BarChart3}
              title="Аналитика"
              description="Отчёты об экономии"
            />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="p-6 text-center text-sm text-muted-foreground">
        © 2026 AddPilot. Все права защищены.
      </footer>
    </div>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="text-center p-4 rounded-lg bg-white/50 backdrop-blur">
      <div className="w-10 h-10 mx-auto mb-2 rounded-full bg-primary/10 flex items-center justify-center">
        <Icon className="w-5 h-5 text-primary" />
      </div>
      <h3 className="font-medium text-sm">{title}</h3>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
