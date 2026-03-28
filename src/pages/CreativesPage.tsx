import { useState } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '@/lib/useAuth';
import { Id } from '../../convex/_generated/dataModel';
import { Sparkles, Loader2, AlertCircle, Wand2, Building2, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CreativeEditor } from '@/components/CreativeEditor';
import { Label } from '@/components/ui/label';
import { CreativeGallery } from '@/components/CreativeGallery';

const GENERATION_LIMITS: Record<string, Record<string, number>> = {
  freemium: { text: 5, image: 2 },
  start: { text: 50, image: 20 },
  pro: { text: 200, image: 50 },
};

export function CreativesPage() {
  const { user } = useAuth();

  const [values, setValues] = useState({
    offer: '',
    bullets: '',
    benefit: '',
    cta: '',
  });
  const [generatingField, setGeneratingField] = useState<string | null>(null);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Get active account from settings
  const settings = useQuery(
    api.userSettings.get,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );

  const accountId = settings?.activeAccountId;

  const accounts = useQuery(
    api.adAccounts.list,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );
  const setActiveAccount = useMutation(api.userSettings.setActiveAccount);

  const directions = useQuery(
    api.businessDirections.list,
    accountId ? { accountId: accountId as Id<"adAccounts"> } : 'skip'
  );
  const profile = useQuery(
    api.adAccounts.getBusinessProfile,
    accountId ? { accountId: accountId as Id<"adAccounts"> } : 'skip'
  );

  const [selectedDirectionId, setSelectedDirectionId] = useState<string>('');

  // Queries
  const creatives = useQuery(
    api.creatives.list,
    user?.userId && accountId
      ? { userId: user.userId as Id<"users">, accountId: accountId as Id<"adAccounts"> }
      : 'skip'
  );

  const usage = useQuery(
    api.aiLimits.getUsage,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );

  // Mutations & Actions
  const createCreative = useMutation(api.creatives.create);
  const deleteCreative = useMutation(api.creatives.deleteCreative);
  const generateText = useAction(api.creatives.generateText);
  const generateImage = useAction(api.creatives.generateImage);

  const tier = user?.subscriptionTier || 'freemium';
  const limits = GENERATION_LIMITS[tier] || GENERATION_LIMITS.freemium;
  const textRemaining = limits.text - (usage?.text || 0);
  const imageRemaining = limits.image - (usage?.image || 0);

  const isLoading = creatives === undefined;

  // Auto-select if only one direction
  const activeDirections = directions?.filter((d: any) => d.isActive) || [];
  if (activeDirections.length === 1 && !selectedDirectionId && activeDirections[0]._id) {
    setSelectedDirectionId(activeDirections[0]._id);
  }
  const selectedDirection = activeDirections.find((d: any) => d._id === selectedDirectionId);

  const handleFieldChange = (field: string, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }));
  };

  const handleGenerateField = async (field: 'offer' | 'bullets' | 'benefit' | 'cta') => {
    if (!user?.userId) return;
    setError(null);
    setGeneratingField(field);
    try {
      const fieldContext = Object.entries(values)
        .filter(([k, v]) => k !== field && v)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ');

      const bizParts: string[] = [];
      if (profile?.companyName) bizParts.push(`Компания: ${profile.companyName}`);
      if (profile?.industry) bizParts.push(`Ниша: ${profile.industry}`);
      if (profile?.tone) bizParts.push(`Тон: ${profile.tone}`);
      if (selectedDirection?.name) bizParts.push(`Направление: ${selectedDirection.name}`);
      if (selectedDirection?.targetAudience) bizParts.push(`ЦА: ${selectedDirection.targetAudience}`);
      if (selectedDirection?.usp) bizParts.push(`УТП: ${selectedDirection.usp}`);

      const context = [fieldContext, ...bizParts].filter(Boolean).join('; ') || undefined;

      const generated = await generateText({
        userId: user.userId as Id<"users">,
        field,
        context,
      });
      setValues((prev) => ({ ...prev, [field]: generated }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка генерации текста');
    } finally {
      setGeneratingField(null);
    }
  };

  const handleGenerateImage = async () => {
    if (!user?.userId || !accountId) return;
    if (!values.offer.trim()) {
      setError('Введите хотя бы основной оффер');
      return;
    }

    setError(null);
    setGeneratingImage(true);
    try {
      // Create creative record first
      const creativeId = await createCreative({
        userId: user.userId as Id<"users">,
        accountId: accountId as Id<"adAccounts">,
        offer: values.offer,
        bullets: values.bullets,
        benefit: values.benefit,
        cta: values.cta,
      });

      // Generate image
      const bizParts: string[] = [];
      if (profile?.companyName) bizParts.push(profile.companyName);
      if (profile?.industry) bizParts.push(profile.industry);
      if (selectedDirection?.name) bizParts.push(selectedDirection.name);
      const businessContext = bizParts.length > 0 ? bizParts.join(', ') : undefined;

      await generateImage({
        creativeId,
        userId: user.userId as Id<"users">,
        offer: values.offer,
        bullets: values.bullets,
        benefit: values.benefit,
        cta: values.cta,
        businessContext,
      });

      setSuccess('Креатив сгенерирован!');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка генерации креатива');
    } finally {
      setGeneratingImage(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteCreative({ id: id as Id<"creatives"> });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления');
    } finally {
      setDeletingId(null);
    }
  };

  if (!accountId) {
    return (
      <div className="space-y-6" data-testid="creatives-page">
        <div className="flex items-center gap-2">
          <Sparkles className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">Генерация Креативов</h1>
        </div>
        <div className="text-center py-12">
          <Building2 className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-medium mb-2">Выберите аккаунт</h3>
          {accounts && accounts.length > 0 ? (
            <div className="max-w-xs mx-auto mt-4">
              <select
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                defaultValue=""
                onChange={async (e) => {
                  if (e.target.value && user?.userId) {
                    await setActiveAccount({
                      userId: user.userId as Id<"users">,
                      accountId: e.target.value as Id<"adAccounts">,
                    });
                  }
                }}
              >
                <option value="" disabled>Выберите рекламный аккаунт...</option>
                {accounts.map((acc) => (
                  <option key={acc._id} value={acc._id}>
                    {acc.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="text-muted-foreground">
              Подключите рекламный аккаунт в разделе Кабинеты
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="creatives-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-primary" />
            Генерация Креативов
          </h1>
          <p className="text-muted-foreground mt-1">
            Создавайте креативы с помощью AI
          </p>
        </div>
      </div>

      {/* Generation counter */}
      <Card>
        <CardContent className="flex items-center gap-3 py-3">
          <Wand2 className="h-5 w-5 text-primary" />
          <div>
            <p className="text-sm font-medium">
              Доступно генераций:{' '}
              <span className="text-primary">{Math.max(0, imageRemaining)}</span>
              {' '}изображений, {' '}
              <span className="text-primary">{Math.max(0, textRemaining)}</span>
              {' '}текстов
            </p>
            <p className="text-xs text-muted-foreground">
              Вы можете сгенерировать ещё {Math.max(0, imageRemaining)} креативов
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Business profile hint */}
      {profile !== undefined && directions !== undefined && (
        !profile?.companyName || !profile?.industry || activeDirections.length === 0
      ) && (
        <div className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-sm">
          <Info className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-foreground">Заполните профиль бизнеса для точной генерации</p>
            <p className="text-muted-foreground mt-0.5">
              {!profile?.companyName || !profile?.industry
                ? 'Укажите название компании и нишу в '
                : 'Добавьте направления бизнеса в '}
              <a href="/accounts" className="text-primary hover:underline font-medium">
                разделе Кабинеты
              </a>
              {' '}→ Профиль бизнеса. Это позволит AI создавать более релевантные креативы.
            </p>
          </div>
        </div>
      )}

      {/* Messages */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="p-3 rounded-lg bg-green-500/10 text-green-700 dark:text-green-400 text-sm">
          {success}
        </div>
      )}

      {/* Editor */}
      <Card>
        <CardContent className="pt-6">
          <CreativeEditor
            values={values}
            onChange={handleFieldChange}
            onGenerateField={handleGenerateField}
            generatingField={generatingField}
            disabled={generatingImage}
          />

          {/* Direction selector */}
          {activeDirections.length > 0 && (
            <div className="mt-4">
              <Label>Направление бизнеса</Label>
              <div className="flex gap-2 mt-1">
                <select
                  className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
                  value={selectedDirectionId}
                  onChange={(e) => setSelectedDirectionId(e.target.value)}
                >
                  <option value="">Выберите направление...</option>
                  {activeDirections.map((dir: any) => (
                    <option key={dir._id} value={dir._id}>{dir.name}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div className="mt-6">
            <Button
              size="lg"
              className="w-full"
              onClick={handleGenerateImage}
              disabled={generatingImage || !values.offer.trim()}
              data-testid="generate-creative-btn"
            >
              {generatingImage ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Генерация...
                </>
              ) : (
                <>
                  <Wand2 className="h-4 w-4 mr-2" />
                  Сгенерировать креатив
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Gallery */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Сгенерированные креативы</h2>
        {isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <CreativeGallery
            creatives={(creatives || []) as any}
            onDelete={handleDelete}
            deleting={deletingId}
          />
        )}
      </div>
    </div>
  );
}
