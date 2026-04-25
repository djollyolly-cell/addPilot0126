import { useState } from 'react';
import { useAuth } from '../../lib/useAuth';
import { Card, CardContent } from '../../components/ui/card';
import { Shield, Users, BarChart3, Wrench, ScrollText, Activity, ClipboardList, Stethoscope, Blocks } from 'lucide-react';
import { AdminUsersTab } from './AdminUsersTab';
import { AdminMetricsTab } from './AdminMetricsTab';
import { AdminToolsTab } from './AdminToolsTab';
import { AdminLogsTab } from './AdminLogsTab';
import { AdminHealthTab } from './AdminHealthTab';
import { AdminAuditTab } from './AdminAuditTab';
import { AdminRuleDiagnosticTab } from './AdminRuleDiagnosticTab';
import { AdminModulesTab } from './AdminModulesTab';

const ADMIN_EMAILS = ['13632013@vk.com', '786709647@vk.com'];
const SESSION_KEY = 'adpilot_session';

const TABS = [
  { id: 'users', label: 'Пользователи', icon: Users },
  { id: 'metrics', label: 'Метрики', icon: BarChart3 },
  { id: 'tools', label: 'Инструменты', icon: Wrench },
  { id: 'logs', label: 'Логи', icon: ScrollText },
  { id: 'health', label: 'Здоровье', icon: Activity },
  { id: 'audit', label: 'Аудит', icon: ClipboardList },
  { id: 'rules-diagnostic', label: 'Диагностика правил', icon: Stethoscope },
  { id: 'modules', label: 'Модули', icon: Blocks },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function AdminPage() {
  const { user } = useAuth();
  const isAdmin = user && (user.isAdmin === true || ADMIN_EMAILS.includes(user.email));

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <Shield className="w-12 h-12 text-destructive mx-auto mb-4" />
            <h2 className="text-xl font-bold mb-2">Нет доступа</h2>
            <p className="text-muted-foreground">
              У вас нет прав для доступа к админ-панели.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <AdminDashboard />;
}

function AdminDashboard() {
  const [activeTab, setActiveTab] = useState<TabId>('users');
  const sessionToken = localStorage.getItem(SESSION_KEY) || '';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Shield className="w-8 h-8 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Админ-панель</h1>
          <p className="text-muted-foreground">Управление пользователями и статистика</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      {activeTab === 'users' && <AdminUsersTab sessionToken={sessionToken} />}
      {activeTab === 'metrics' && <AdminMetricsTab sessionToken={sessionToken} />}
      {activeTab === 'tools' && <AdminToolsTab sessionToken={sessionToken} />}
      {activeTab === 'logs' && <AdminLogsTab sessionToken={sessionToken} />}
      {activeTab === 'health' && <AdminHealthTab sessionToken={sessionToken} />}
      {activeTab === 'audit' && <AdminAuditTab sessionToken={sessionToken} />}
      {activeTab === 'rules-diagnostic' && <AdminRuleDiagnosticTab sessionToken={sessionToken} />}
      {activeTab === 'modules' && <AdminModulesTab sessionToken={sessionToken} />}
    </div>
  );
}
