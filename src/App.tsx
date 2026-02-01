import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { ProfilePage } from './pages/ProfilePage';
import { AccountsPage } from './pages/AccountsPage';
import { RulesPage } from './pages/RulesPage';
import { DashboardPage } from './pages/DashboardPage';
import { AuthCallback } from './pages/AuthCallback';
import { AdsCallback } from './pages/AdsCallback';
import { TelegramSettingsPage } from './pages/TelegramSettingsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { LogsPage } from './pages/LogsPage';
import { SettingsPage } from './pages/SettingsPage';
import { PricingPage } from './pages/PricingPage';
import { useAuth } from './lib/useAuth';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
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

function App() {
  return (
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
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/telegram" element={<TelegramSettingsPage />} />
        <Route path="/pricing" element={<PricingPage />} />
      </Route>

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
