import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/AppShell';
import { useAppStore } from '@/store/useAppStore';
import { SessionRequired } from '@/components/layout/SessionRequired';
import { isHubSessionLost, onHubSessionLost } from '@/lib/session';
import { installOpenInAppTabBridge } from '@/lib/native-open-link';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 1000,
    },
  },
});

export function App() {
  const { theme, setOnboardingOpen } = useAppStore();
  // No (or no longer a) Hub session: the Hub restarted, or this tab was not opened through ChatMCP.
  const [sessionLost, setSessionLost] = useState(isHubSessionLost);
  useEffect(() => onHubSessionLost(() => setSessionLost(true)), []);
  // Links the desktop shell forwards (window.open / target=_blank) arrive as web messages, not as script run in the page.
  useEffect(() => installOpenInAppTabBridge(), []);

  // Initialize theme on mount
  useEffect(() => {
    const preference = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => document.documentElement.setAttribute('data-theme', theme === 'system' ? (preference.matches ? 'light' : 'dark') : theme);
    apply();
    preference.addEventListener('change', apply);
    return () => preference.removeEventListener('change', apply);
  }, [theme]);

  // Check onboarding on mount
  useEffect(() => {
    const completed = localStorage.getItem('chatmcp:onboarding-completed');
    if (!completed) {
      setOnboardingOpen(true);
    }
  }, [setOnboardingOpen]);

  if (sessionLost) return <SessionRequired />;

  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}

export default App;
