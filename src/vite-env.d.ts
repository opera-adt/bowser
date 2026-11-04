/// <reference types="vite/client" />

/** The desktop app's window bridge (pywebview), present only inside the app. */
interface Window {
  pywebview?: { api: { pick_folder: () => Promise<string | null> } };
}
