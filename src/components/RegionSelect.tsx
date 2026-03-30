import { useState, useEffect, useMemo } from 'react';
import { useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { Loader2, X, MapPin, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface Region {
  id: number;
  name: string;
  level?: number;
  type?: string;
  children?: Region[];
}

interface RegionSelectProps {
  accountId: string;
  value: number[];
  onChange: (regionIds: number[]) => void;
}

/** Flatten the regions tree into a searchable list */
function flattenRegions(regions: Region[], depth = 0): { id: number; name: string; depth: number }[] {
  const result: { id: number; name: string; depth: number }[] = [];
  for (const r of regions) {
    result.push({ id: r.id, name: r.name, depth });
    if (r.children) {
      result.push(...flattenRegions(r.children, depth + 1));
    }
  }
  return result;
}

export function RegionSelect({ accountId, value, onChange }: RegionSelectProps) {
  const fetchRegions = useAction(api.aiCabinet.fetchRegions);
  const [regions, setRegions] = useState<Region[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Load regions on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchRegions({ accountId: accountId as Id<"adAccounts"> });
        if (!cancelled) setRegions(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Ошибка загрузки регионов');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [accountId, fetchRegions]);

  // Flatten for search
  const flat = useMemo(() => {
    if (!regions) return [];
    return flattenRegions(regions);
  }, [regions]);

  // Filtered results
  const filtered = useMemo(() => {
    if (!search.trim()) return flat.slice(0, 50); // Show top 50 by default
    const q = search.toLowerCase();
    return flat.filter((r) => r.name.toLowerCase().includes(q)).slice(0, 30);
  }, [flat, search]);

  // Selected region names for chips
  const selectedNames = useMemo(() => {
    const map = new Map(flat.map((r) => [r.id, r.name]));
    return value.map((id) => ({ id, name: map.get(id) || `#${id}` }));
  }, [flat, value]);

  const toggleRegion = (id: number) => {
    if (value.includes(id)) {
      onChange(value.filter((v) => v !== id));
    } else {
      onChange([...value, id]);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Загрузка регионов...</span>
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-destructive py-2">{error}</p>
    );
  }

  return (
    <div className="space-y-2" data-testid="region-select">
      {/* Selected chips */}
      {selectedNames.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedNames.map((r) => (
            <button
              key={r.id}
              onClick={() => toggleRegion(r.id)}
              className="flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              {r.name}
              <X className="h-3 w-3" />
            </button>
          ))}
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Поиск города или региона..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Region list */}
      <div className="border border-border rounded-lg max-h-48 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            {search ? 'Ничего не найдено' : 'Нет регионов'}
          </p>
        ) : (
          filtered.map((region) => {
            const isSelected = value.includes(region.id);
            return (
              <button
                key={region.id}
                onClick={() => toggleRegion(region.id)}
                className={cn(
                  'w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-muted/50 transition-colors',
                  isSelected && 'bg-primary/5 font-medium',
                )}
                style={{ paddingLeft: `${12 + region.depth * 16}px` }}
              >
                <MapPin className={cn('h-3.5 w-3.5 shrink-0', isSelected ? 'text-primary' : 'text-muted-foreground')} />
                <span className="truncate">{region.name}</span>
                {isSelected && (
                  <span className="ml-auto text-xs text-primary">✓</span>
                )}
              </button>
            );
          })
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Выбрано: {value.length}
      </p>
    </div>
  );
}
