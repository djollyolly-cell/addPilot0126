import { useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, AlertCircle, CheckCircle } from "lucide-react";

type Step = "vk_token" | "senler" | "confirm";

interface ValidatedGroup {
  vkGroupId: number;
  vkGroupName: string;
  vkGroupAvatarUrl?: string;
}

export function CommunityProfileModal({
  userId,
  existingProfileId,
  onClose,
  onSaved,
}: {
  userId: Id<"users">;
  existingProfileId?: Id<"communityProfiles">;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [step, setStep] = useState<Step>("vk_token");
  const [vkToken, setVkToken] = useState("");
  const [senlerKey, setSenlerKey] = useState("");
  const [skipSenler, setSkipSenler] = useState(true);
  const [validated, setValidated] = useState<ValidatedGroup | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validateToken = useAction(api.communityProfiles.validateCommunityToken);
  const validateSenler = useAction(api.communityProfiles.validateSenlerKey);
  const createProfile = useMutation(api.communityProfiles.create);
  const updateProfile = useMutation(api.communityProfiles.update);

  async function handleValidateVk() {
    setError(null);
    setLoading(true);
    try {
      const info = await validateToken({ token: vkToken });
      setValidated(info);
      setStep("senler");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setLoading(false);
    }
  }

  async function handleValidateSenler() {
    if (skipSenler) {
      setStep("confirm");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await validateSenler({ apiKey: senlerKey });
      setStep("confirm");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!validated) return;
    setError(null);
    setLoading(true);
    try {
      if (existingProfileId) {
        await updateProfile({
          id: existingProfileId,
          userId,
          vkCommunityToken: vkToken || undefined,
          vkGroupName: validated.vkGroupName,
          vkGroupAvatarUrl: validated.vkGroupAvatarUrl,
          senlerApiKey: skipSenler ? undefined : (senlerKey || undefined),
        });
      } else {
        await createProfile({
          userId,
          vkGroupId: validated.vkGroupId,
          vkGroupName: validated.vkGroupName,
          vkGroupAvatarUrl: validated.vkGroupAvatarUrl,
          vkCommunityToken: vkToken,
          senlerApiKey: skipSenler ? undefined : senlerKey,
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка сохранения");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      data-testid="community-profile-modal"
    >
      <div className="bg-background rounded-lg shadow-lg w-full max-w-md p-6 space-y-4">
        <h2 className="text-xl font-bold">
          {existingProfileId ? "Редактировать профиль" : "Добавить сообщество"}
        </h2>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {step === "vk_token" && (
          <div className="space-y-3">
            <div>
              <Label htmlFor="vk-token">Токен VK-сообщества</Label>
              <Input
                id="vk-token"
                type="password"
                value={vkToken}
                onChange={(e) => setVkToken(e.target.value)}
                placeholder="vk1.a..."
                data-testid="vk-token-input"
              />
              <a
                href="https://dev.vk.com/ru/api/access-token/community-token/getting-started"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary hover:underline mt-1 inline-block"
              >
                Как получить токен сообщества?
              </a>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={onClose}>Отмена</Button>
              <Button
                onClick={handleValidateVk}
                disabled={loading || !vkToken.trim()}
                data-testid="validate-vk-btn"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Проверить
              </Button>
            </div>
          </div>
        )}

        {step === "senler" && validated && (
          <div className="space-y-3">
            <div className="p-3 rounded-lg bg-success/10 text-success text-sm flex items-center gap-2">
              <CheckCircle className="h-4 w-4" />
              Сообщество: <strong>{validated.vkGroupName}</strong>
            </div>
            <div>
              <Label htmlFor="senler-key">API-ключ Senler (опционально)</Label>
              <Input
                id="senler-key"
                type="password"
                value={senlerKey}
                onChange={(e) => { setSenlerKey(e.target.value); setSkipSenler(false); }}
                placeholder="..."
                disabled={skipSenler}
                data-testid="senler-key-input"
              />
              <label className="flex items-center gap-2 mt-2 text-sm">
                <input
                  type="checkbox"
                  checked={skipSenler}
                  onChange={(e) => setSkipSenler(e.target.checked)}
                  data-testid="skip-senler-checkbox"
                />
                У меня нет Senler — пропустить
              </label>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setStep("vk_token")}>Назад</Button>
              <Button
                onClick={handleValidateSenler}
                disabled={loading || (!skipSenler && !senlerKey.trim())}
                data-testid="validate-senler-btn"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                {skipSenler ? "Пропустить" : "Проверить"}
              </Button>
            </div>
          </div>
        )}

        {step === "confirm" && validated && (
          <div className="space-y-3">
            <div className="p-3 rounded-lg bg-muted text-sm space-y-1">
              <div>Сообщество: <strong>{validated.vkGroupName}</strong></div>
              <div>VK токен: <span className="text-success">ok</span></div>
              <div>Senler: {skipSenler ? "не подключён" : <span className="text-success">ok</span>}</div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setStep("senler")}>Назад</Button>
              <Button
                onClick={handleSave}
                disabled={loading}
                data-testid="save-profile-btn"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Сохранить
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
