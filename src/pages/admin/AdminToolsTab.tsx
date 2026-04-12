import { useState } from 'react';
import { Tag, Send, MessageSquare, Stethoscope, Bell, ChevronDown, ChevronRight } from 'lucide-react';
import { PromoCodesSection } from './sections/PromoCodesSection';
import { BroadcastSection } from './sections/BroadcastSection';
import { FeedbackListSection } from './sections/FeedbackListSection';
import { DiagnosticSection } from './sections/DiagnosticSection';
import { AlertSettingsSection } from './sections/AlertSettingsSection';

interface Props {
  sessionToken: string;
}

const SECTIONS = [
  { id: 'promos', label: 'Промокоды', icon: Tag },
  { id: 'broadcast', label: 'Рассылка', icon: Send },
  { id: 'feedback', label: 'Обратная связь', icon: MessageSquare },
  { id: 'diagnostic', label: 'Диагностика', icon: Stethoscope },
  { id: 'alerts', label: 'Уведомления', icon: Bell },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export function AdminToolsTab({ sessionToken }: Props) {
  const [openSections, setOpenSections] = useState<Set<SectionId>>(new Set(['promos']));

  const toggle = (id: SectionId) => {
    const next = new Set(openSections);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpenSections(next);
  };

  return (
    <div className="space-y-3">
      {SECTIONS.map((section) => {
        const Icon = section.icon;
        const isOpen = openSections.has(section.id);
        return (
          <div key={section.id} className="border border-border rounded-lg">
            <button
              className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/30 transition-colors"
              onClick={() => toggle(section.id)}
            >
              {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              <Icon className="w-4 h-4" />
              {section.label}
            </button>
            {isOpen && (
              <div className="px-4 pb-4">
                {section.id === 'promos' && <PromoCodesSection sessionToken={sessionToken} />}
                {section.id === 'broadcast' && <BroadcastSection sessionToken={sessionToken} />}
                {section.id === 'feedback' && <FeedbackListSection sessionToken={sessionToken} />}
                {section.id === 'diagnostic' && <DiagnosticSection />}
                {section.id === 'alerts' && <AlertSettingsSection sessionToken={sessionToken} />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
