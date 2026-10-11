import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/AppShell';
import { useAppStore } from '@/store/useAppStore';

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

  // Initialize theme on mount
  useEffect(() => {
    const resolved = theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : theme;
    document.documentElement.setAttribute('data-theme', resolved);
  }, [theme]);

  // Check onboarding on mount
  useEffect(() => {
    const completed = localStorage.getItem('chatmcp:onboarding-completed');
    if (!completed) {
      setOnboardingOpen(true);
    }
  }, [setOnboardingOpen]);

  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}

export default App;
