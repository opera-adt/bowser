/** Appearance: follows the system unless the user picks light or dark (Project tab). */
export type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'bowser-theme';
export const THEME_EVENT = 'bowser-theme';

/** The theme on screen now (a ``system`` choice resolved). */
export const shownTheme = (): 'light' | 'dark' => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
let stopWatching: (() => void) | null = null;

export function readThemeChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  stopWatching?.();
  stopWatching = null;
  try {
    if (choice === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch { /* the choice just won't survive a reload */ }
  const media = window.matchMedia?.('(prefers-color-scheme: light)');
  const set = () => {
    const light = choice === 'light' || (choice === 'system' && !!media?.matches);
    document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  };
  set();
  // Lets every control showing the theme (the rail toggle, Project › Appearance) follow.
  window.dispatchEvent(new CustomEvent<ThemeChoice>(THEME_EVENT, { detail: choice }));
  if (choice === 'system' && media) {
    media.addEventListener('change', set);
    stopWatching = () => media.removeEventListener('change', set);
  }
}
