import { Outlet, Link, useLocation } from 'react-router-dom';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '../lib/useAuth';
import { Id } from '../../convex/_generated/dataModel';
import {
  LayoutDashboard,
  Building2,
  ListChecks,
  FileBarChart,
  ScrollText,
  Settings,
  LogOut,
  User,
  Wallet,
  Crown,
  Shield,
  Sparkles,
  Film,
  Wand2,
  MessageCircle,
} from 'lucide-react';
import { cn } from '../lib/utils';

const navigation = [
  { name: 'Дашборд', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Кабинеты', href: '/accounts', icon: Building2 },
  { name: 'AI Кабинет', href: '/ai-cabinet', icon: Wand2 },
  { name: 'Правила', href: '/rules', icon: ListChecks },
  { name: 'Отчёты', href: '/reports', icon: FileBarChart },
  { name: 'Креативы', href: '/creatives', icon: Sparkles },
  { name: 'Видео', href: '/videos', icon: Film },
  { name: 'Логи', href: '/logs', icon: ScrollText },
  { name: 'Тарифы', href: '/pricing', icon: Crown },
  { name: 'Поддержка', href: '/support', icon: MessageCircle },
  { name: 'Настройки', href: '/settings', icon: Settings },
];

/** Bottom nav shows 5 key items on mobile */
const bottomNavItems = [
  { name: 'Дашборд', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Кабинеты', href: '/accounts', icon: Building2 },
  { name: 'Правила', href: '/rules', icon: ListChecks },
  { name: 'Отчёты', href: '/reports', icon: FileBarChart },
  { name: 'Настройки', href: '/settings', icon: Settings },
];

const ADMIN_EMAILS = ['13632013@vk.com', '786709647@vk.com'];

export function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const isAdmin = user && (user.isAdmin === true || ADMIN_EMAILS.includes(user.email));

  // Unread support messages count
  const supportThreads = useQuery(
    api.userNotifications.getUserThreads,
    user?.userId ? { userId: user.userId as Id<'users'> } : 'skip'
  );
  const supportUnread = supportThreads?.reduce((sum, t) => sum + t.unreadCount, 0) ?? 0;

  const navItems = [
    ...navigation,
    ...(isAdmin ? [{ name: 'Админ', href: '/admin', icon: Shield }] : []),
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Sidebar — hidden on mobile, visible on md+ */}
      <aside className="hidden md:block fixed inset-y-0 left-0 z-50 w-64 bg-card border-r border-border">
        {/* Logo */}
        <div className="flex items-center gap-2 px-6 py-4 border-b border-border">
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
            <Wallet className="w-5 h-5 text-primary-foreground" />
          </div>
          <span className="text-xl font-bold">AddPilot</span>
        </div>

        {/* Navigation */}
        <nav className="p-4 space-y-1">
          {navItems.map((item) => {
            const isActive = location.pathname === item.href;
            const badge = item.href === '/support' && supportUnread > 0 ? supportUnread : 0;
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
                {badge > 0 && (
                  <span className={cn(
                    'ml-auto text-xs font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1',
                    isActive
                      ? 'bg-primary-foreground text-primary'
                      : 'bg-destructive text-white'
                  )}>
                    {badge}
                  </span>
                )}
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

      {/* Main content — no left padding on mobile, pl-64 on md+ */}
      <main className="md:pl-64 pb-20 md:pb-0">
        <div className="p-4 md:p-8">
          <Outlet />
        </div>
      </main>

      {/* Bottom navigation — visible on mobile only */}
      <nav
        data-testid="bottom-nav"
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border"
      >
        <div className="flex items-center justify-around h-16">
          {bottomNavItems.map((item) => {
            const isActive =
              location.pathname === item.href ||
              (item.href === '/settings' && location.pathname.startsWith('/settings'));
            const badge = item.href === '/support' && supportUnread > 0 ? supportUnread : 0;
            return (
              <Link
                key={item.name}
                to={item.href}
                className={cn(
                  'flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors relative',
                  isActive
                    ? 'text-primary'
                    : 'text-muted-foreground'
                )}
              >
                <div className="relative">
                  <item.icon className="w-5 h-5" />
                  {badge > 0 && (
                    <span className="absolute -top-1.5 -right-2 bg-destructive text-white text-[9px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5">
                      {badge}
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-medium leading-none">{item.name}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
