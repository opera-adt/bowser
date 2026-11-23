/** Shared by the rail's Open button (components/OpenDataset.tsx) and its tests. */

/**
 * The desktop app's File menu asks the page with this event (detail: "open" or "picker"). The page
 * cancels it when it handles the request; an uncancelled event (no page app, e.g. on the picker)
 * lets the menu fall back to loading the picker.
 */
export const OPEN_EVENT = 'bowser:open-dataset';

/** The page for a dataset, or the picker. Kept small so tests can replace navigation. */
export const nav = { go: (href: string) => { window.location.href = href; } };
