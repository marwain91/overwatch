import { create } from 'zustand';

type Theme = 'light' | 'dark' | 'system';
type Resolved = 'light' | 'dark';

interface ThemeState {
  theme: Theme;
  resolved: Resolved;
  setTheme: (theme: Theme) => void;
}

function getSystemTheme(): Resolved {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(resolved: Resolved) {
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

const stored = (localStorage.getItem('overwatch_theme') as Theme) || 'system';
const initialResolved = stored === 'system' ? getSystemTheme() : stored;
applyTheme(initialResolved);

export const useThemeStore = create<ThemeState>((set) => ({
  theme: stored,
  resolved: initialResolved,

  setTheme: (theme: Theme) => {
    localStorage.setItem('overwatch_theme', theme);
    const resolved = theme === 'system' ? getSystemTheme() : theme;
    applyTheme(resolved);
    set({ theme, resolved });
  },
}));

// Listen for system preference changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const state = useThemeStore.getState();
  if (state.theme === 'system') {
    const resolved = getSystemTheme();
    applyTheme(resolved);
    useThemeStore.setState({ resolved });
  }
});
