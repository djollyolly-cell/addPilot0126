import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { Layout } from './components/Layout';
import { useAuth } from './lib/useAuth';

// Lazy load pages for code splitting
const LandingPage = lazy(() => import('./pages/LandingPage').then(m => ({ default: m.LandingPage })));
const LoginPage = lazy(() => import('./pages/LoginPage').then(m => ({ default: m.LoginPage })));
const ProfilePage = lazy(() => import('./pages/ProfilePage').then(m => ({ default: m.ProfilePage })));
const AccountsPage = lazy(() => import('./pages/AccountsPage').then(m => ({ default: m.AccountsPage })));
const RulesPage = lazy(() => import('./pages/RulesPage').then(m => ({ default: m.RulesPage })));
const DashboardPage = lazy(() => import('./pages/DashboardPage').then(m => ({ default: m.DashboardPage })));
const AuthCallback = lazy(() => import('./pages/AuthCallback').then(m => ({ default: m.AuthCallback })));
const AdsCallback = lazy(() => import('./pages/AdsCallback').then(m => ({ default: m.AdsCallback })));
const GetUniqCallback = lazy(() => import('./pages/GetUniqCallback'));
const TelegramSettingsPage = lazy(() => import('./pages/TelegramSettingsPage').then(m => ({ default: m.TelegramSettingsPage })));
const ReportsPage = lazy(() => import('./pages/ReportsPage').then(m => ({ default: m.ReportsPage })));
const LogsPage = lazy(() => import('./pages/LogsPage').then(m => ({ default: m.LogsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));
const PricingPage = lazy(() => import('./pages/PricingPage').then(m => ({ default: m.PricingPage })));
const PrivacyPage = lazy(() => import('./pages/PrivacyPage').then(m => ({ default: m.PrivacyPage })));
const TermsPage = lazy(() => import('./pages/TermsPage').then(m => ({ default: m.TermsPage })));
const AdminPage = lazy(() => import('./pages/AdminPage').then(m => ({ default: m.AdminPage })));
const SupportPage = lazy(() => import('./pages/SupportPage').then(m => ({ default: m.SupportPage })));
const CreativesPage = lazy(() => import('./pages/CreativesPage').then(m => ({ default: m.CreativesPage })));
const VideosPage = lazy(() => import('./pages/VideosPage').then(m => ({ default: m.VideosPage })));
const AICabinetPage = lazy(() => import('./pages/AICabinetPage'));
const AICabinetNewPage = lazy(() => import('./pages/AICabinetNewPage'));
const AICabinetDetailPage = lazy(() => import('./pages/AICabinetDetailPage'));

// Loading spinner component
function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    // Save the intended destination for redirect after login
    const redirectUrl = location.pathname + location.search;
    sessionStorage.setItem('auth_redirect', redirectUrl);
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}

const ADMIN_EMAILS = ['13632013@vk.com', '786709647@vk.com'];

function AdminGate({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user || !ADMIN_EMAILS.includes(user.email)) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
        <div className="text-4xl mb-4">🚧</div>
        <h2 className="text-xl font-bold mb-2">Модуль в разработке</h2>
        <p className="text-muted-foreground">Эта функция скоро станет доступна.</p>
      </div>
    );
  }
  return <>{children}</>;
}

function App() {
  return (
    <Suspense fallback={<PageLoader />}>
    <Routes>
      {/* Landing page for non-authenticated users */}
      <Route
        path="/"
        element={
          <PublicRoute>
            <LandingPage />
          </PublicRoute>
        }
      />
      <Route
        path="/login"
        element={
          <PublicRoute>
            <LoginPage />
          </PublicRoute>
        }
      />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/auth/ads-callback" element={<AdsCallback />} />
      <Route path="/auth/getuniq-callback" element={<GetUniqCallback />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />

      {/* Protected app routes */}
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/ai-cabinet" element={<AdminGate><AICabinetPage /></AdminGate>} />
        <Route path="/ai-cabinet/new" element={<AdminGate><AICabinetNewPage /></AdminGate>} />
        <Route path="/ai-cabinet/:id" element={<AdminGate><AICabinetDetailPage /></AdminGate>} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/creatives" element={<AdminGate><CreativesPage /></AdminGate>} />
        <Route path="/videos" element={<AdminGate><VideosPage /></AdminGate>} />
        <Route path="/analytics" element={<Navigate to="/dashboard" replace />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/telegram" element={<TelegramSettingsPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/support" element={<SupportPage />} />
        <Route path="/admin" element={<AdminPage />} />
      </Route>

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}

export default App;
