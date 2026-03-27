import { useState } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface TextFieldConfig {
  key: 'offer' | 'bullets' | 'benefit' | 'cta';
  label: string;
  maxLength: number;
  placeholder: string;
  rows: number;
}

const FIELDS: TextFieldConfig[] = [
  { key: 'offer', label: 'Основной оффер', maxLength: 60, placeholder: 'Введите основной оффер...', rows: 3 },
  { key: 'bullets', label: 'Буллеты', maxLength: 120, placeholder: 'Введите буллеты...', rows: 3 },
  { key: 'benefit', label: 'Выгода', maxLength: 50, placeholder: 'Введите выгоду...', rows: 3 },
  { key: 'cta', label: 'CTA (призыв к действию)', maxLength: 40, placeholder: 'Введите cta (призыв к действию)...', rows: 3 },
];

interface CreativeEditorProps {
  values: { offer: string; bullets: string; benefit: string; cta: string };
  onChange: (field: string, value: string) => void;
  onGenerateField: (field: 'offer' | 'bullets' | 'benefit' | 'cta') => Promise<void>;
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
  return (
    <div className="space-y-6">
      {FIELDS.map((field) => (
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
            {values[field.key].length}/{field.maxLength} символов
          </div>
        </div>
      ))}
    </div>
  );
}
