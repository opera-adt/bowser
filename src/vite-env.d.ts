/// <reference types="vite/client" />

/** The desktop app's window bridge (pywebview), present only inside the app. */
interface Window {
  pywebview?: {
    api: {
      pick_folder: () => Promise<string | null>;
      /** Show a Save dialog and write the file; the path written, or null if cancelled. */
      save_file?: (name: string, dataBase64: string) => Promise<string | null>;
      /** Open an https page in the system browser (a sign-in page). */
      open_url?: (url: string) => Promise<boolean>;
    };
  };
}
