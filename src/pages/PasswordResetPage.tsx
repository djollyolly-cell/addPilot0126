import { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { KeyRound, Mail, CheckCircle, AlertCircle, Loader2, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

function RequestResetForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const requestReset = useAction(api.authEmail.requestPasswordReset);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      setError("Введите email");
      return;
    }
    setSubmitting(true);
    try {
      await requestReset({ email: trimmed });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <Card className="w-full max-w-md" data-testid="reset-sent">
        <CardHeader className="text-center">
          <CheckCircle className="h-12 w-12 text-success mx-auto mb-2" />
          <CardTitle>Проверьте почту</CardTitle>
          <CardDescription>
            Если аккаунт с таким email существует, мы отправили ссылку для сброса пароля.
            Ссылка действительна 1 час.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link to="/login">
            <Button variant="outline" className="w-full">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Вернуться на страницу входа
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md" data-testid="reset-request-form">
      <CardHeader className="text-center">
        <KeyRound className="h-10 w-10 text-primary mx-auto mb-2" />
        <CardTitle>Сброс пароля</CardTitle>
        <CardDescription>
          Введите email, привязанный к вашему аккаунту
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="reset-email">Email</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="reset-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="user@example.com"
                className="pl-10"
                disabled={submitting}
                data-testid="reset-email-input"
              />
            </div>
          </div>
          <Button type="submit" className="w-full" disabled={submitting} data-testid="reset-submit">
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Отправка...
              </>
            ) : (
              "Отправить ссылку"
            )}
          </Button>
          <div className="text-center">
            <Link to="/login" className="text-sm text-primary hover:underline">
              Вернуться на страницу входа
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const tokenInfo = useQuery(api.authEmail.validateResetToken, { token });
  const resetPassword = useAction(api.authEmail.resetPassword);

  if (tokenInfo === undefined) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!tokenInfo.valid) {
    return (
      <Card className="w-full max-w-md" data-testid="reset-invalid">
        <CardHeader className="text-center">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-2" />
          <CardTitle>Ссылка недействительна</CardTitle>
          <CardDescription>
            Ссылка для сброса пароля истекла или уже была использована.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link to="/reset-password">
            <Button variant="outline" className="w-full">
              Запросить новую ссылку
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (success) {
    return (
      <Card className="w-full max-w-md" data-testid="reset-success">
        <CardHeader className="text-center">
          <CheckCircle className="h-12 w-12 text-success mx-auto mb-2" />
          <CardTitle>Пароль изменён</CardTitle>
          <CardDescription>
            Теперь вы можете войти с новым паролем.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link to="/login">
            <Button className="w-full">Войти</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Пароль должен быть не менее 8 символов");
      return;
    }
    if (password !== confirmPassword) {
      setError("Пароли не совпадают");
      return;
    }
    setSubmitting(true);
    try {
      await resetPassword({ token, newPassword: password });
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="w-full max-w-md" data-testid="reset-password-form">
      <CardHeader className="text-center">
        <KeyRound className="h-10 w-10 text-primary mx-auto mb-2" />
        <CardTitle>Новый пароль</CardTitle>
        <CardDescription>Введите новый пароль для аккаунта</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="new-password">Новый пароль</Label>
            <Input
              id="new-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Минимум 8 символов"
              disabled={submitting}
              data-testid="new-password-input"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">Подтвердите пароль</Label>
            <Input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Повторите пароль"
              disabled={submitting}
              data-testid="confirm-password-input"
            />
          </div>
          <Button type="submit" className="w-full" disabled={submitting} data-testid="reset-password-submit">
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Сохранение...
              </>
            ) : (
              "Сохранить пароль"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function PasswordResetPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background" data-testid="password-reset-page">
      {token ? <ResetPasswordForm token={token} /> : <RequestResetForm />}
    </div>
  );
}
