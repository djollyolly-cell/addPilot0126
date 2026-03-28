import { Sparkles, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface TextFieldConfig {
  key: 'offer' | 'bullets' | 'benefit' | 'cta' | 'adTitle' | 'adText';
  label: string;
  maxLength: number;
  placeholder: string;
  rows: number;
  section?: 'banner' | 'ad';
}

const FIELDS: TextFieldConfig[] = [
  { key: 'offer', label: 'Оффер на баннере', maxLength: 60, placeholder: 'Главное предложение на картинке...', rows: 2, section: 'banner' },
  { key: 'bullets', label: 'Буллеты на баннере', maxLength: 120, placeholder: 'Ключевые выгоды через « • »...', rows: 2, section: 'banner' },
  { key: 'benefit', label: 'Выгода на баннере', maxLength: 50, placeholder: 'Конкретный результат для клиента...', rows: 2, section: 'banner' },
  { key: 'cta', label: 'CTA на баннере', maxLength: 40, placeholder: 'Призыв к действию...', rows: 2, section: 'banner' },
  { key: 'adTitle', label: 'Заголовок объявления', maxLength: 90, placeholder: 'Заголовок, который остановит скролл...', rows: 2, section: 'ad' },
  { key: 'adText', label: 'Текст объявления', maxLength: 220, placeholder: 'Рекламный текст: боль → решение → результат → CTA...', rows: 4, section: 'ad' },
];

interface CreativeEditorProps {
  values: { offer: string; bullets: string; benefit: string; cta: string; adTitle: string; adText: string };
  onChange: (field: string, value: string) => void;
  onGenerateField: (field: 'offer' | 'bullets' | 'benefit' | 'cta' | 'adTitle' | 'adText') => Promise<void>;
  generatingField: string | null;
  disabled?: boolean;
}

export function CreativeEditor({
  values,
  onChange,
  onGenerateField,
  generatingField,
  disabled,
}: CreativeEditorProps) {
  const bannerFields = FIELDS.filter(f => f.section === 'banner');
  const adFields = FIELDS.filter(f => f.section === 'ad');

  const renderField = (field: TextFieldConfig) => (
        <div
          key={field.key}
          className="rounded-lg border border-border p-4 space-y-2"
          data-testid={`creative-field-${field.key}`}
        >
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-base font-semibold">{field.label}</Label>
              <p className="text-sm text-muted-foreground">
                Введите текст вручную или сгенерируйте с помощью AI
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <textarea
                className={cn(
                  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm',
                  'placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring',
                  'resize-none',
                  disabled && 'opacity-50 cursor-not-allowed'
                )}
                rows={field.rows}
                placeholder={field.placeholder}
                maxLength={field.maxLength}
                value={values[field.key]}
                onChange={(e) => onChange(field.key, e.target.value)}
                disabled={disabled}
              />
            </div>
            <Button
              variant="outline"
              size="icon"
              className="shrink-0 h-10 w-10"
              onClick={() => onGenerateField(field.key)}
              disabled={disabled || generatingField !== null}
              data-testid={`ai-generate-${field.key}`}
            >
              {generatingField === field.key ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            {(values[field.key] || '').length}/{field.maxLength} символов
          </div>
        </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Текст на баннере</h3>
        <div className="space-y-4">
          {bannerFields.map(renderField)}
        </div>
      </div>
      <div className="border-t border-border pt-6">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Текст объявления VK</h3>
        <div className="space-y-4">
          {adFields.map(renderField)}
        </div>
      </div>
    </div>
  );
}
