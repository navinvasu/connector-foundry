/**
 * FE-06 — responsive shell contract.
 *
 * The console shell has three sidebar modes, derived from viewport width:
 *  - `full`    (≥1280px): 256px sidebar with labels — the desktop layout.
 *  - `rail`    (1024–1279px): 72px icon rail — laptop width keeps every
 *              destination one click away without eating content width.
 *  - `overlay` (<1024px): sidebar hidden off-canvas, opened from the
 *              header hamburger over a backdrop — tablet/phone width.
 *
 * Pure functions so the breakpoint contract is unit-tested; Layout.tsx
 * only renders what these return. Content must never scroll horizontally:
 * wide tables/code scroll inside their own wrappers, never the page.
 */
export type SidebarMode = 'full' | 'rail' | 'overlay';

/** Viewport width (px) at/above which the full labeled sidebar fits. */
export const SIDEBAR_FULL_MIN = 1280;
/** Viewport width (px) at/above which at least the icon rail fits. */
export const SIDEBAR_RAIL_MIN = 1024;

export function sidebarModeForWidth(width: number): SidebarMode {
  if (!Number.isFinite(width) || width < 0) return 'full';
  if (width >= SIDEBAR_FULL_MIN) return 'full';
  if (width >= SIDEBAR_RAIL_MIN) return 'rail';
  return 'overlay';
}

/** Horizontal space the sidebar reserves in normal flow (overlay reserves none). */
export function sidebarWidthForMode(mode: SidebarMode): number {
  if (mode === 'full') return 256;
  if (mode === 'rail') return 72;
  return 0;
}

/** In overlay mode the drawer is visible only while explicitly opened. */
export function sidebarVisible(mode: SidebarMode, drawerOpen: boolean): boolean {
  return mode !== 'overlay' || drawerOpen;
}
