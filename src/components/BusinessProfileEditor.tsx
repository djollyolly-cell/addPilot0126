import { useState } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import {
  Sparkles,
  Loader2,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Briefcase,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const TONE_OPTIONS = [
  { value: 'friendly', label: 'Дружелюбный' },
  { value: 'professional', label: 'Деловой' },
  { value: 'expert', label: 'Экспертный' },
];

interface BusinessProfileEditorProps {
  accountId: string;
  userId: string;
}

export function BusinessProfileEditor({ accountId, userId }: BusinessProfileEditorProps) {
  const typedAccountId = accountId as Id<"adAccounts">;
  const typedUserId = userId as Id<"users">;

  const profile = useQuery(api.adAccounts.getBusinessProfile, { accountId: typedAccountId });
  const directions = useQuery(api.businessDirections.list, { accountId: typedAccountId });
  const updateProfile = useMutation(api.adAccounts.updateBusinessProfile);
  const createDirection = useMutation(api.businessDirections.create);
  const updateDirection = useMutation(api.businessDirections.update);
  const removeDirection = useMutation(api.businessDirections.remove);
  const suggestTA = useAction(api.businessDirections.suggestTargetAudience);
  const suggestUspAction = useAction(api.businessDirections.suggestUsp);

  // Profile form state
  const [companyName, setCompanyName] = useState('');
  const [industry, setIndustry] = useState('');
  const [tone, setTone] = useState('');
  const [website, setWebsite] = useState('');
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  // Direction form state
  const [showAddDirection, setShowAddDirection] = useState(false);
  const [newDirName, setNewDirName] = useState('');
  const [newDirTA, setNewDirTA] = useState('');
  const [newDirUsp, setNewDirUsp] = useState('');

  // AI suggestions state
  const [suggestingTA, setSuggestingTA] = useState<string | null>(null); // directionId or 'new'
  const [suggestingUsp, setSuggestingUsp] = useState<string | null>(null);
  const [taSuggestions, setTaSuggestions] = useState<string[]>([]);
  const [uspSuggestions, setUspSuggestions] = useState<string[]>([]);
  const [suggestTarget, setSuggestTarget] = useState<string | null>(null); // which field suggestions are for

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Load profile data once
  if (profile && !profileLoaded) {
    setCompanyName(profile.companyName || '');
    setIndustry(profile.industry || '');
    setTone(profile.tone || '');
    setWebsite(profile.website || '');
    setProfileLoaded(true);
  }

  const handleSaveProfile = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateProfile({
        accountId: typedAccountId,
        companyName: companyName.trim() || undefined,
        industry: industry.trim() || undefined,
        tone: tone || undefined,
        website: website.trim() || undefined,
      });
      setSuccess('Профиль сохранён');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const handleAddDirection = async () => {
    if (!newDirName.trim()) return;
    setError(null);
    try {
      await createDirection({
        accountId: typedAccountId,
        name: newDirName.trim(),
        targetAudience: newDirTA.trim() || undefined,
        usp: newDirUsp.trim() || undefined,
      });
      setNewDirName('');
      setNewDirTA('');
      setNewDirUsp('');
      setShowAddDirection(false);
      setSuccess('Направление добавлено');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    }
  };

  const handleDeleteDirection = async (id: string) => {
    try {
      await removeDirection({ id: id as Id<"businessDirections"> });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления');
    }
  };

  const handleSuggestTA = async (dirId: string, dirName: string) => {
    if (!companyName.trim() || !industry.trim()) {
      setError('Заполните название компании и нишу для AI-подсказок');
      return;
    }
    setSuggestingTA(dirId);
    setSuggestTarget(dirId);
    setTaSuggestions([]);
    try {
      const suggestions = await suggestTA({
        userId: typedUserId,
        companyName: companyName.trim(),
        industry: industry.trim(),
        directionName: dirName,
      });
      setTaSuggestions(suggestions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка генерации');
    } finally {
      setSuggestingTA(null);
    }
  };

  const handleSuggestUsp = async (dirId: string, dirName: string, ta?: string) => {
    if (!companyName.trim() || !industry.trim()) {
      setError('Заполните название компании и нишу для AI-подсказок');
      return;
    }
    setSuggestingUsp(dirId);
    setSuggestTarget(dirId);
    setUspSuggestions([]);
    try {
      const suggestions = await suggestUspAction({
        userId: typedUserId,
        companyName: companyName.trim(),
        industry: industry.trim(),
        directionName: dirName,
        targetAudience: ta,
      });
      setUspSuggestions(suggestions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка генерации');
    } finally {
      setSuggestingUsp(null);
    }
  };

  const handleSelectTASuggestion = async (dirId: string, value: string) => {
    if (dirId === 'new') {
      setNewDirTA(value);
    } else {
      await updateDirection({ id: dirId as Id<"businessDirections">, targetAudience: value });
    }
    setTaSuggestions([]);
    setSuggestTarget(null);
  };

  const handleSelectUspSuggestion = async (dirId: string, value: string) => {
    if (dirId === 'new') {
      setNewDirUsp(value);
    } else {
      await updateDirection({ id: dirId as Id<"businessDirections">, usp: value });
    }
    setUspSuggestions([]);
    setSuggestTarget(null);
  };

  return (
    <div className="space-y-4">
      {/* Messages */}
      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>
      )}
      {success && (
        <div className="p-3 rounded-lg bg-green-500/10 text-green-700 dark:text-green-400 text-sm">{success}</div>
      )}

      {/* Profile fields */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Briefcase className="h-4 w-4 text-primary" />
            Профиль бизнеса
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Название компании</Label>
            <input
              className="w-full mt-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="Например: ФудМастер"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </div>
          <div>
            <Label>Ниша / отрасль</Label>
            <input
              className="w-full mt-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="Например: Общепит и доставка"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
            />
          </div>
          <div>
            <Label>Тон коммуникации</Label>
            <select
              className="w-full mt-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={tone}
              onChange={(e) => setTone(e.target.value)}
            >
              <option value="">Не выбран</option>
              {TONE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <Label>Сайт</Label>
            <input
              className="w-full mt-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="https://example.com"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </div>
          <Button onClick={handleSaveProfile} disabled={saving} size="sm">
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Сохранить профиль
          </Button>
        </CardContent>
      </Card>

      {/* Directions */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Направления бизнеса</CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddDirection(!showAddDirection)}
            >
              <Plus className="h-4 w-4 mr-1" />
              Добавить
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Add direction form */}
          {showAddDirection && (
            <div className="rounded-lg border border-border p-4 space-y-3">
              <div>
                <Label>Название направления</Label>
                <input
                  className="w-full mt-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
                  placeholder="Например: Доставка еды"
                  value={newDirName}
                  onChange={(e) => setNewDirName(e.target.value)}
                />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <Label>Целевая аудитория</Label>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => handleSuggestTA('new', newDirName)}
                    disabled={!newDirName.trim() || suggestingTA !== null}
                  >
                    {suggestingTA === 'new' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="h-3 w-3" />
                    )}
                  </Button>
                </div>
                <input
                  className="w-full mt-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
                  placeholder="Например: Офисные работники 25-45, Москва"
                  value={newDirTA}
                  onChange={(e) => setNewDirTA(e.target.value)}
                />
                {suggestTarget === 'new' && taSuggestions.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {taSuggestions.map((s, i) => (
                      <button
                        key={i}
                        className="w-full text-left text-sm px-3 py-1.5 rounded-md hover:bg-muted transition-colors"
                        onClick={() => handleSelectTASuggestion('new', s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <Label>УТП</Label>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => handleSuggestUsp('new', newDirName, newDirTA)}
                    disabled={!newDirName.trim() || suggestingUsp !== null}
                  >
                    {suggestingUsp === 'new' ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="h-3 w-3" />
                    )}
                  </Button>
                </div>
                <input
                  className="w-full mt-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
                  placeholder="Например: Доставка за 30 минут или бесплатно"
                  value={newDirUsp}
                  onChange={(e) => setNewDirUsp(e.target.value)}
                />
                {suggestTarget === 'new' && uspSuggestions.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {uspSuggestions.map((s, i) => (
                      <button
                        key={i}
                        className="w-full text-left text-sm px-3 py-1.5 rounded-md hover:bg-muted transition-colors"
                        onClick={() => handleSelectUspSuggestion('new', s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddDirection} disabled={!newDirName.trim()}>
                  Сохранить
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowAddDirection(false)}>
                  Отмена
                </Button>
              </div>
            </div>
          )}

          {/* Existing directions */}
          {directions && directions.length > 0 ? (
            directions.map((dir) => (
              <DirectionItem
                key={dir._id}
                direction={dir}
                onDelete={handleDeleteDirection}
                onSuggestTA={handleSuggestTA}
                onSuggestUsp={handleSuggestUsp}
                suggestingTA={suggestingTA}
                suggestingUsp={suggestingUsp}
                suggestTarget={suggestTarget}
                taSuggestions={taSuggestions}
                uspSuggestions={uspSuggestions}
                onSelectTA={handleSelectTASuggestion}
                onSelectUsp={handleSelectUspSuggestion}
                onUpdate={updateDirection}
              />
            ))
          ) : !showAddDirection ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              Нет направлений. Добавьте первое направление бизнеса.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// Direction item with inline editing
function DirectionItem({
  direction,
  onDelete,
  onSuggestTA,
  onSuggestUsp,
  suggestingTA,
  suggestingUsp,
  suggestTarget,
  taSuggestions,
  uspSuggestions,
  onSelectTA,
  onSelectUsp,
  onUpdate,
}: {
  direction: { _id: string; name: string; targetAudience?: string; usp?: string; isActive: boolean };
  onDelete: (id: string) => void;
  onSuggestTA: (dirId: string, name: string) => void;
  onSuggestUsp: (dirId: string, name: string, ta?: string) => void;
  suggestingTA: string | null;
  suggestingUsp: string | null;
  suggestTarget: string | null;
  taSuggestions: string[];
  uspSuggestions: string[];
  onSelectTA: (dirId: string, value: string) => void;
  onSelectUsp: (dirId: string, value: string) => void;
  onUpdate: (args: { id: Id<"businessDirections">; [key: string]: unknown }) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between">
        <button
          className="flex items-center gap-2 text-sm font-medium"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {direction.name}
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          onClick={() => onDelete(direction._id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {!expanded && (direction.targetAudience || direction.usp) && (
        <div className="mt-1 text-xs text-muted-foreground truncate pl-6">
          {direction.targetAudience && `ЦА: ${direction.targetAudience}`}
          {direction.targetAudience && direction.usp && ' · '}
          {direction.usp && `УТП: ${direction.usp}`}
        </div>
      )}

      {expanded && (
        <div className="mt-3 pl-6 space-y-3">
          <div>
            <div className="flex items-center gap-2">
              <Label className="text-xs">Целевая аудитория</Label>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={() => onSuggestTA(direction._id, direction.name)}
                disabled={suggestingTA !== null}
              >
                {suggestingTA === direction._id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
              </Button>
            </div>
            <input
              className="w-full mt-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              value={direction.targetAudience || ''}
              onChange={(e) => onUpdate({ id: direction._id as Id<"businessDirections">, targetAudience: e.target.value })}
              placeholder="Целевая аудитория"
            />
            {suggestTarget === direction._id && taSuggestions.length > 0 && (
              <div className="mt-2 space-y-1">
                {taSuggestions.map((s, i) => (
                  <button
                    key={i}
                    className="w-full text-left text-xs px-3 py-1.5 rounded-md hover:bg-muted transition-colors"
                    onClick={() => onSelectTA(direction._id, s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <Label className="text-xs">УТП</Label>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={() => onSuggestUsp(direction._id, direction.name, direction.targetAudience)}
                disabled={suggestingUsp !== null}
              >
                {suggestingUsp === direction._id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
              </Button>
            </div>
            <input
              className="w-full mt-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              value={direction.usp || ''}
              onChange={(e) => onUpdate({ id: direction._id as Id<"businessDirections">, usp: e.target.value })}
              placeholder="Уникальное торговое предложение"
            />
            {suggestTarget === direction._id && uspSuggestions.length > 0 && (
              <div className="mt-2 space-y-1">
                {uspSuggestions.map((s, i) => (
                  <button
                    key={i}
                    className="w-full text-left text-xs px-3 py-1.5 rounded-md hover:bg-muted transition-colors"
                    onClick={() => onSelectUsp(direction._id, s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
