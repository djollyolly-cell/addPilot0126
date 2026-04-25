import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/lib/utils";
import { AlertCircle, CheckCircle, Pencil, Trash2 } from "lucide-react";
import { Id } from "../../convex/_generated/dataModel";

export interface CommunityProfile {
  _id: Id<"communityProfiles">;
  vkGroupId: number;
  vkGroupName: string;
  vkGroupAvatarUrl?: string;
  hasVkToken: boolean;
  hasSenlerKey: boolean;
  lastValidatedAt: number;
  lastError?: string;
}

export function CommunityProfileCard({
  profile,
  onEdit,
  onRemove,
}: {
  profile: CommunityProfile;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const hasError = Boolean(profile.lastError);
  return (
    <div
      className="flex items-center gap-3 py-3 border-b border-border last:border-b-0"
      data-testid={`community-profile-${profile.vkGroupId}`}
    >
      {profile.vkGroupAvatarUrl ? (
        <img
          src={profile.vkGroupAvatarUrl}
          alt={profile.vkGroupName}
          className="h-10 w-10 rounded-full object-cover"
        />
      ) : (
        <div className="h-10 w-10 rounded-full bg-muted" />
      )}
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{profile.vkGroupName}</div>
        <div className="text-sm text-muted-foreground flex items-center gap-2">
          <a
            href={`https://vk.com/club${profile.vkGroupId}`}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            vk.com/club{profile.vkGroupId}
          </a>
          <span>·</span>
          {hasError ? (
            <span className="flex items-center gap-1 text-destructive">
              <AlertCircle className="h-3 w-3" />
              Ошибка токена
            </span>
          ) : (
            <span className="flex items-center gap-1 text-success">
              <CheckCircle className="h-3 w-3" />
              Токен проверен {formatRelativeTime(profile.lastValidatedAt)}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          Senler: {profile.hasSenlerKey ? "подключён" : "не подключён"}
        </div>
        {hasError && (
          <div className="text-xs text-destructive mt-1">{profile.lastError}</div>
        )}
      </div>
      <div className="flex gap-1">
        <Button variant="ghost" size="icon" onClick={onEdit} aria-label="Редактировать">
          <Pencil className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={onRemove} aria-label="Удалить">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
