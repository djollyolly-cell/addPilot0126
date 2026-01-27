import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConvexProvider, ConvexReactClient } from 'convex/react';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './lib/useAuth';
import './index.css';

const convexUrl = import.meta.env.VITE_CONVEX_URL;

if (!convexUrl) {
  console.warn('VITE_CONVEX_URL is not set. Using placeholder.');
}

const convex = new ConvexReactClient(convexUrl || 'https://placeholder.convex.cloud');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConvexProvider client={convex}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ConvexProvider>
  </React.StrictMode>,
);
