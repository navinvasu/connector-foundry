import { describe, expect, it } from 'vitest';
import {
  SIDEBAR_FULL_MIN,
  SIDEBAR_RAIL_MIN,
  sidebarModeForWidth,
  sidebarVisible,
  sidebarWidthForMode,
} from './responsive';

describe('sidebarModeForWidth (FE-06 breakpoint contract)', () => {
  it('is full at desktop widths (1280 and above)', () => {
    expect(sidebarModeForWidth(1280)).toBe('full');
    expect(sidebarModeForWidth(1440)).toBe('full');
    expect(sidebarModeForWidth(1920)).toBe('full');
  });

  it('is the icon rail across the laptop band (1024–1279)', () => {
    expect(sidebarModeForWidth(SIDEBAR_RAIL_MIN)).toBe('rail');
    expect(sidebarModeForWidth(1024)).toBe('rail');
    expect(sidebarModeForWidth(1152)).toBe('rail');
    expect(sidebarModeForWidth(SIDEBAR_FULL_MIN - 1)).toBe('rail');
  });

  it('is overlay below 1024 (tablet/phone), including the 768 AC width', () => {
    expect(sidebarModeForWidth(1023)).toBe('overlay');
    expect(sidebarModeForWidth(768)).toBe('overlay');
    expect(sidebarModeForWidth(390)).toBe('overlay');
  });

  it('falls back to full for degenerate widths (SSR / unset)', () => {
    expect(sidebarModeForWidth(Number.NaN)).toBe('full');
    expect(sidebarModeForWidth(-1)).toBe('full');
  });
});

describe('sidebarWidthForMode', () => {
  it('reserves 256px for full, 72px for rail, nothing for overlay', () => {
    expect(sidebarWidthForMode('full')).toBe(256);
    expect(sidebarWidthForMode('rail')).toBe(72);
    expect(sidebarWidthForMode('overlay')).toBe(0);
  });
});

describe('sidebarVisible', () => {
  it('full and rail sidebars are always visible', () => {
    expect(sidebarVisible('full', false)).toBe(true);
    expect(sidebarVisible('rail', false)).toBe(true);
  });

  it('the overlay drawer shows only while opened', () => {
    expect(sidebarVisible('overlay', false)).toBe(false);
    expect(sidebarVisible('overlay', true)).toBe(true);
  });
});
