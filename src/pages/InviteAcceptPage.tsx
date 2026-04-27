import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useAuth } from "@/lib/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Building2, Mail, Shield, AlertCircle } from "lucide-react";

export default function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { user, loginWithEmail, setSession } = useAuth();
  const invite = useQuery(api.orgAuth.getInviteInfo, token ? { token } : "skip");

  const acceptForCurrent = useMutation(api.orgAuth.acceptInviteForCurrentUser);
  const acceptAsNew = useAction(api.orgAuth.acceptInviteAsNewUser);

  const [mode, setMode] = useState<"choice" | "existing-vk" | "existing-email" | "new">("choice");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!token) return <div className="p-8">Неверная ссылка.</div>;
  if (invite === undefined) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (invite === null) return <div className="p-8">Инвайт не найден.</div>;
  if (invite.status === "expired") {
    return <div className="p-8 text-destructive">Срок действия приглашения истёк.</div>;
  }
  if (invite.status !== "pending") {
    return <div className="p-8">Инвайт уже {invite.status}.</div>;
  }

  const handleAcceptForCurrent = async () => {
    if (!user) {
      setError("Сначала войдите в свой аккаунт");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await acceptForCurrent({ token: token!, userId: user.userId as any });
      navigate("/dashboard?invite=accepted");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setSubmitting(false);
    }
  };

  const handleAcceptAsNew = async () => {
    if (!name.trim()) { setError("Введите имя"); return; }
    if (password.length < 8) { setError("Пароль не менее 8 символов"); return; }
    setSubmitting(true);
    setError(null);
    try {
      const result = await acceptAsNew({ token: token!, name: name.trim(), password });
      setSession(result.sessionToken);
      navigate("/dashboard?invite=accepted");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
      setSubmitting(false);
    }
  };

  const handleEmailLogin = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const loginResult = await loginWithEmail(invite.email, password);
      if (!loginResult.success) {
        setError(loginResult.error ?? "Ошибка входа");
        setSubmitting(false);
        return;
      }
      // After login, switch to existing-vk mode where user is now set
      setMode("existing-vk");
      setSubmitting(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-8">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-6 w-6 text-primary" />
            Приглашение в {invite.orgName}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <span>Контактный email: <strong>{invite.email}</strong></span>
            </div>
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              <span>Права: {invite.permissions.join(", ") || "—"}</span>
            </div>
            <div>Назначено кабинетов: {invite.assignedAccountIdsCount}</div>
            <div>Пригласил: {invite.inviterName}</div>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {mode === "choice" && (
            <div className="space-y-4">
              <h3 className="font-semibold">Как принять приглашение?</h3>
              <div className="grid gap-3">
                <Button
                  variant="outline"
                  onClick={() => setMode("existing-vk")}
                  className="justify-start h-auto p-4"
                  data-testid="invite-existing-account"
                >
                  У меня уже есть аккаунт AddPilot — войти
                </Button>
                <Button
                  variant="default"
                  onClick={() => setMode("new")}
                  className="justify-start h-auto p-4"
                  data-testid="invite-new-account"
                >
                  Создать новый аккаунт
                </Button>
              </div>
            </div>
          )}

          {mode === "existing-vk" && (
            <div className="space-y-4">
              {user ? (
                <>
                  <p className="text-sm">
                    Вы залогинены как <strong>{user.email}</strong>.
                    Принять приглашение от этого аккаунта?
                  </p>
                  <div className="flex gap-2">
                    <Button onClick={handleAcceptForCurrent} disabled={submitting} data-testid="invite-accept-btn">
                      {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      Принять
                    </Button>
                    <Button variant="outline" onClick={() => setMode("choice")}>
                      Назад
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm">Сначала войдите:</p>
                  <Button
                    variant="vk"
                    onClick={() => navigate("/login?redirectTo=/invite/" + token)}
                  >
                    Войти через VK
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setMode("existing-email")}
                  >
                    Войти по email и паролю
                  </Button>
                </>
              )}
            </div>
          )}

          {mode === "existing-email" && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Войдите с email и паролем, чтобы принять приглашение.
              </p>
              <div>
                <Label htmlFor="login-email">Email</Label>
                <Input id="login-email" type="email" value={invite.email} disabled />
              </div>
              <div>
                <Label htmlFor="login-pwd">Пароль</Label>
                <Input
                  id="login-pwd"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <Button onClick={handleEmailLogin} disabled={submitting}>
                  {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Войти и принять
                </Button>
                <Button variant="outline" onClick={() => setMode("existing-vk")}>
                  Назад
                </Button>
              </div>
              <Link to="/reset-password" className="text-sm text-primary hover:underline">
                Забыли пароль?
              </Link>
            </div>
          )}

          {mode === "new" && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Email <strong>{invite.email}</strong> будет привязан к новому аккаунту.
              </p>
              <div>
                <Label htmlFor="name">Имя</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="pwd">Пароль (мин. 8 символов)</Label>
                <Input id="pwd" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <div className="flex gap-2">
                <Button onClick={handleAcceptAsNew} disabled={submitting} data-testid="invite-create-account">
                  {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Создать аккаунт
                </Button>
                <Button variant="outline" onClick={() => setMode("choice")}>
                  Назад
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
