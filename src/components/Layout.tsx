import { Outlet, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/useAuth';
import {
  LayoutDashboard,
  ListChecks,
  BarChart3,
  ScrollText,
  Settings,
  LogOut,
  User,
  Wallet,
} from 'lucide-react';
import { cn } from '../lib/utils';

const navigation = [
  { name: 'Дашборд', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Правила', href: '/rules', icon: ListChecks },
  { name: 'Аналитика', href: '/analytics', icon: BarChart3 },
  { name: 'Логи', href: '/logs', icon: ScrollText },
  { name: 'Настройки', href: '/settings', icon: Settings },
];

export function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();

  return (
    <div className="min-h-screen bg-background">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-50 w-64 bg-card border-r border-border">
        {/* Logo */}
        <div className="flex items-center gap-2 px-6 py-4 border-b border-border">
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
            <Wallet className="w-5 h-5 text-primary-foreground" />
          </div>
          <span className="text-xl font-bold">AdPilot</span>
        </div>

        {/* Navigation */}
        <nav className="p-4 space-y-1">
          {navigation.map((item) => {
            const isActive = location.pathname === item.href;
            return (
              <Link
                key={item.name}
                to={item.href}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <item.icon className="w-5 h-5" />
                {item.name}
              </Link>
            );
          })}
        </nav>

        {/* User section */}
        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-border">
          <Link
            to="/profile"
            className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-lg transition-colors',
              location.pathname === '/profile'
                ? 'bg-primary/10 text-primary'
                : 'hover:bg-muted'
            )}
            data-testid="user-profile-link"
          >
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.name || 'User'}
                className="w-8 h-8 rounded-full"
              />
            ) : (
              <div className="w-8 h-8 bg-muted rounded-full flex items-center justify-center">
                <User className="w-4 h-4 text-muted-foreground" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {user?.name || 'Пользователь'}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {user?.email}
              </p>
            </div>
          </Link>

          <button
            onClick={() => logout()}
            className="flex items-center gap-3 px-3 py-2 mt-2 w-full rounded-lg text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            data-testid="logout-button"
          >
            <LogOut className="w-5 h-5" />
            Выйти
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="pl-64">
        <div className="p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
