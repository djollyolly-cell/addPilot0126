import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Plus, Loader2 } from 'lucide-react';

interface Props {
  sessionToken: string;
}

export function PromoCodesSection({ sessionToken: _sessionToken }: Props) {
  const promos = useQuery(api.billing.listPromoCodes, {});
  const createPromo = useMutation(api.billing.createPromoCode);
  const togglePromo = useMutation(api.billing.togglePromoCode);

  const [showForm, setShowForm] = useState(false);
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [bonusDays, setBonusDays] = useState(30);
  const [maxUses, setMaxUses] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!code.trim() || !description.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createPromo({
        code: code.trim().toUpperCase(),
        description: description.trim(),
        bonusDays,
        maxUses: maxUses ? parseInt(maxUses) : undefined,
      });
      setCode('');
      setDescription('');
      setBonusDays(30);
      setMaxUses('');
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setCreating(false);
    }
  };

  const formatDate = (ts: number) =>
    new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {promos && `${promos.length} промокодов`}
        </span>
        <Button size="sm" onClick={() => setShowForm(!showForm)}>
          <Plus className="w-4 h-4 mr-1" />
          Создать
        </Button>
      </div>

      {showForm && (
        <div className="p-4 border border-border rounded-lg space-y-3">
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Код</Label>
              <Input
                placeholder="COMMUNITY30"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Бонус дней</Label>
              <Input
                type="number"
                value={bonusDays}
                onChange={(e) => setBonusDays(parseInt(e.target.value) || 0)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Описание</Label>
              <Input
                placeholder="Бонус для сообщества"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Макс. использований (пусто = безлимит)</Label>
              <Input
                type="number"
                placeholder="∞"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleCreate} disabled={creating || !code.trim() || !description.trim()}>
              {creating ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
              Создать промокод
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>
              Отмена
            </Button>
          </div>
        </div>
      )}

      {!promos ? (
        <div className="flex justify-center py-4">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : promos.length === 0 ? (
        <p className="text-center text-muted-foreground py-4">Промокодов пока нет</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="pb-2 font-medium text-muted-foreground">Код</th>
                <th className="pb-2 font-medium text-muted-foreground">Описание</th>
                <th className="pb-2 font-medium text-muted-foreground">Бонус</th>
                <th className="pb-2 font-medium text-muted-foreground">Использован</th>
                <th className="pb-2 font-medium text-muted-foreground">Статус</th>
                <th className="pb-2 font-medium text-muted-foreground">Создан</th>
                <th className="pb-2 font-medium text-muted-foreground"></th>
              </tr>
            </thead>
            <tbody>
              {promos.map((p) => (
                <tr key={p._id} className="border-b border-border/50 last:border-0">
                  <td className="py-2 pr-3 font-mono font-bold">{p.code}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{p.description}</td>
                  <td className="py-2 pr-3">+{p.bonusDays} дн.</td>
                  <td className="py-2 pr-3">{p.usedCount}{p.maxUses ? ` / ${p.maxUses}` : ''}</td>
                  <td className="py-2 pr-3">
                    <Badge variant={p.isActive ? 'success' : 'secondary'}>
                      {p.isActive ? 'Активен' : 'Выключен'}
                    </Badge>
                  </td>
                  <td className="py-2 pr-3 text-muted-foreground">{formatDate(p.createdAt)}</td>
                  <td className="py-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => togglePromo({ promoId: p._id })}
                    >
                      {p.isActive ? 'Выключить' : 'Включить'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
