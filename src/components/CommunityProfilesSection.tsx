import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useAuth } from "@/lib/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Loader2, Users } from "lucide-react";
import { CommunityProfileCard } from "@/components/CommunityProfileCard";
import { CommunityProfileModal } from "@/components/CommunityProfileModal";

const PROFILE_LIMIT = 50;

export function CommunityProfilesSection() {
  const { user } = useAuth();
  const userId = user?.userId as Id<"users"> | undefined;
  const profiles = useQuery(
    api.communityProfiles.list,
    userId ? { userId } : "skip"
  );
  const removeProfile = useMutation(api.communityProfiles.remove);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<Id<"communityProfiles"> | undefined>();

  const isLoading = profiles === undefined;

  async function handleRemove(id: Id<"communityProfiles">, name: string) {
    if (!userId) return;
    if (!confirm(`Удалить профиль сообщества «${name}»?`)) return;
    await removeProfile({ id, userId });
  }

  return (
    <Card data-testid="community-profiles-section">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          Профили сообществ
        </CardTitle>
        <Button
          size="sm"
          onClick={() => { setEditingId(undefined); setModalOpen(true); }}
          disabled={isLoading || (profiles && profiles.length >= PROFILE_LIMIT)}
          data-testid="add-community-profile-btn"
        >
          <Plus className="h-4 w-4 mr-1" /> Добавить
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : profiles.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4">
            Нет подключённых сообществ. Добавьте первое, чтобы подтягивать диалоги
            и Senler-подписки в отчёты клиентам.
          </div>
        ) : (
          <div>
            {profiles.map((p) => (
              <CommunityProfileCard
                key={p._id}
                profile={p}
                onEdit={() => { setEditingId(p._id); setModalOpen(true); }}
                onRemove={() => handleRemove(p._id, p.vkGroupName)}
              />
            ))}
            <div className="text-xs text-muted-foreground mt-3">
              Подключено: {profiles.length} / {PROFILE_LIMIT}
            </div>
          </div>
        )}
      </CardContent>
      {modalOpen && userId && (
        <CommunityProfileModal
          userId={userId}
          existingProfileId={editingId}
          existingProfile={
            editingId
              ? profiles?.find((p) => p._id === editingId)
              : undefined
          }
          onClose={() => setModalOpen(false)}
          onSaved={() => setModalOpen(false)}
        />
      )}
    </Card>
  );
}
