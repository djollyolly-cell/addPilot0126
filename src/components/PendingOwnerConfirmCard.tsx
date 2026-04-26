import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccountsMultiselect } from "./AccountsMultiselect";
import { Badge } from "@/components/ui/badge";

interface TransferredAccount {
  _id: string;
  name: string;
}

interface Invite {
  _id: string;
  email: string;
  status: string;
  acceptedByUserName?: string;
  transferredAccounts: TransferredAccount[];
}

interface Props {
  invite: Invite;
  ownerUserId: string;
}

export function PendingOwnerConfirmCard({ invite, ownerUserId }: Props) {
  const confirm = useMutation(api.orgAuth.confirmInviteByOwner);
  const reject = useMutation(api.orgAuth.rejectInviteByOwner);
  const [transferIds, setTransferIds] = useState<string[]>(invite.transferredAccounts.map((a) => a._id));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await confirm({
        inviteId: invite._id as Id<"orgInvites">,
        ownerUserId: ownerUserId as Id<"users">,
        transferAccountIds: transferIds as Id<"adAccounts">[],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await reject({
        inviteId: invite._id as Id<"orgInvites">,
        ownerUserId: ownerUserId as Id<"users">,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="border-warning border-2" data-testid={`pending-confirm-${invite.email}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Ожидает подтверждения: {invite.email}
          <Badge variant="warning">{invite.status === "accepted" ? "Принял" : "Ожидает"}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {invite.status === "accepted" ? (
          <>
            <p className="text-sm">
              {invite.acceptedByUserName ?? invite.email} принял приглашение
              {invite.transferredAccounts.length > 0
                ? ` и предлагает перенести ${invite.transferredAccounts.length} кабинетов в организацию.`
                : "."}
            </p>
            {invite.transferredAccounts.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Подтвердите кабинеты для переноса:</p>
                <AccountsMultiselect
                  accounts={invite.transferredAccounts}
                  selected={transferIds}
                  onChange={setTransferIds}
                />
              </div>
            )}
            {error && <div className="text-sm text-destructive">{error}</div>}
            <div className="flex gap-2">
              <Button onClick={handleConfirm} disabled={submitting}>Подтвердить</Button>
              <Button onClick={handleReject} variant="destructive" disabled={submitting}>Отклонить</Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Приглашение отправлено, ожидает принятия менеджером.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
