// Window sizes the specs use. Pass one to `test.use` to run a describe block in it.

/** The brief's laptop: the desktop layouts. The default in playwright.config.ts. */
export const DESKTOP = { viewport: { width: 1280, height: 800 } } as const;

/** The brief's phone, 390 by 844, as a touch device: the phone layouts, which must not change. */
export const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
} as const;
