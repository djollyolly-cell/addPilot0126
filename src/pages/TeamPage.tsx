import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useAuth } from "@/lib/useAuth";
import { useOrganization } from "@/lib/useOrganization";
import { usePermissions } from "@/lib/usePermissions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { PermissionsCheckboxGroup } from "@/components/PermissionsCheckboxGroup";
import { AccountsMultiselect } from "@/components/AccountsMultiselect";
import { PendingOwnerConfirmCard } from "@/components/PendingOwnerConfirmCard";
import { Users, Plus, Loader2 } from "lucide-react";

export default function TeamPage() {
  const { user } = useAuth();
  const org = useOrganization();
  const { canInviteMembers, isOwner } = usePermissions();

  const accounts = useQuery(
    api.adAccounts.list,
    user?.userId ? { userId: user.userId as Id<"users"> } : "skip"
  );

  const pendingInvites = useQuery(
    api.organizations.listPendingInvites,
    org?._id ? { orgId: org._id, requesterId: user!.userId as Id<"users"> } : "skip"
  );

  const inviteManager = useMutation(api.organizations.inviteManager);
  const removeMember = useMutation(api.organizations.removeMember);

  const [showInviteForm, setShowInviteForm] = useState(false);
  const [email, setEmail] = useState("");
  const [perms, setPerms] = useState<string[]>(["rules", "reports"]);
  const [assigned, setAssigned] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!org) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Вы не состоите в организации. Перейдите в <a href="/pricing" className="text-primary underline">Тарифы</a> для подключения Agency.
      </div>
    );
  }

  const handleInvite = async () => {
    setError(null);
    if (!email.trim()) { setError("Введите email"); return; }
    setSubmitting(true);
    try {
      await inviteManager({
        orgId: org._id,
        invitedBy: user!.userId as Id<"users">,
        email: email.trim(),
        permissions: perms,
        assignedAccountIds: assigned as Id<"adAccounts">[],
      });
      setEmail("");
      setPerms(["rules", "reports"]);
      setAssigned([]);
      setShowInviteForm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (memberId: string) => {
    if (!window.confirm("Удалить менеджера из команды?")) return;
    try {
      await removeMember({
        memberId: memberId as Id<"orgMembers">,
        requesterId: user!.userId as Id<"users">,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
    }
  };

  const activeManagers = (org.members ?? []).filter(
    (m) => m.status === "active" && m.role === "manager"
  );

  return (
    <div className="space-y-6" data-testid="team-page">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Users className="h-6 w-6 text-primary" />
          Команда
        </h1>
        {(canInviteMembers() || isOwner()) && (
          <Button onClick={() => setShowInviteForm(true)} data-testid="invite-btn">
            <Plus className="h-4 w-4 mr-2" />
            Пригласить
          </Button>
        )}
      </div>

      {/* Pending invites */}
      {pendingInvites && pendingInvites.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Ожидают подтверждения</h2>
          {pendingInvites.map((inv) => (
            <PendingOwnerConfirmCard
              key={inv._id}
              invite={inv}
              ownerUserId={user!.userId}
            />
          ))}
        </div>
      )}

      {/* Invite form */}
      {showInviteForm && (
        <Card data-testid="invite-form">
          <CardHeader><CardTitle>Новое приглашение</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Email менеджера</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="manager@company.com"
                data-testid="invite-email"
              />
            </div>
            <div>
              <Label>Права</Label>
              <PermissionsCheckboxGroup selected={perms} onChange={setPerms} />
            </div>
            <div>
              <Label>Назначенные кабинеты</Label>
              <AccountsMultiselect accounts={accounts ?? []} selected={assigned} onChange={setAssigned} />
            </div>
            {error && <div className="text-sm text-destructive">{error}</div>}
            <div className="flex gap-2">
              <Button onClick={handleInvite} disabled={submitting} data-testid="send-invite">
                {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Отправить инвайт
              </Button>
              <Button variant="outline" onClick={() => setShowInviteForm(false)}>Отмена</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Active managers */}
      <Card>
        <CardHeader>
          <CardTitle>Активные менеджеры ({activeManagers.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {activeManagers.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              В команде пока нет менеджеров. Пригласите первого!
            </p>
          ) : (
            activeManagers.map((m) => {
              return (
                <div key={m._id} className="flex items-center justify-between py-3 border-b last:border-0">
                  <div>
                    <div className="font-medium">{m.contactEmail ?? "—"}</div>
                    <div className="text-sm text-muted-foreground">
                      {m.permissions.length} прав &middot; {m.assignedAccountIds.length} кабинетов
                    </div>
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {m.permissions.slice(0, 3).map((p) => (
                        <Badge key={p} variant="secondary" className="text-[10px]">{p}</Badge>
                      ))}
                      {m.permissions.length > 3 && (
                        <Badge variant="secondary" className="text-[10px]">+{m.permissions.length - 3}</Badge>
                      )}
                    </div>
                  </div>
                  {isOwner() && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleRemove(m._id)}
                      data-testid={`remove-member-${m._id}`}
                    >
                      Удалить
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
