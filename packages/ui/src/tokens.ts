// Design tokens (WS14). The single source for the app (NativeWind preset) and the marketing
// site (tokens.css is generated from this file). Do not hand-edit a second copy anywhere.
//
// Keep this file plain, erasable TypeScript (no enums, no parameter properties, `import type`
// only). Node loads it directly for `tailwind.preset.js` and `apps/marketing/scripts/sync-brand.mjs`.
//
// Contrast rules the tests enforce (src/tokens.test.ts): every text token meets WCAG AA 4.5:1
// on each surface it is allowed on, in both modes. Non-text accents meet 3:1.

/** Color scales, 50 (lightest) to 900 (darkest). Mode independent. */
const scale = {
  // Herb green. 600 is the brand fill in light mode.
  primary: {
    50: "#F0F7F3",
    100: "#D9EBE0",
    200: "#B3D7C1",
    300: "#84BC9B",
    400: "#52A076",
    500: "#3A8A5F",
    600: "#2F6B4F",
    700: "#255640",
    800: "#1D4432",
    900: "#143024",
  },
  // Warm stone. Surfaces and text.
  neutral: {
    50: "#FAF8F5",
    100: "#F2EEE8",
    200: "#E4DED4",
    300: "#CFC7BA",
    400: "#A39A8B",
    500: "#7A7164",
    600: "#5B5449",
    700: "#433E36",
    800: "#2B2823",
    900: "#1A1814",
  },
  // Teal. Distinct from the brand green so a success banner never reads as a primary button.
  success: {
    50: "#EDF8F6",
    100: "#D2EFEA",
    200: "#A6DED5",
    300: "#6FC5B8",
    400: "#3AA697",
    500: "#1E8A7C",
    600: "#17706A",
    700: "#135A56",
    800: "#0F4745",
    900: "#0B3433",
  },
  // Saffron.
  warning: {
    50: "#FFF8E6",
    100: "#FEEFC2",
    200: "#FCDD85",
    300: "#F7C648",
    400: "#E8A81C",
    500: "#C98A0B",
    600: "#A06B07",
    700: "#7C5207",
    800: "#5C3C06",
    900: "#3E2A05",
  },
  // Tomato.
  danger: {
    50: "#FEF2F0",
    100: "#FDDFDA",
    200: "#FABBB1",
    300: "#F58D7D",
    400: "#EA5D49",
    500: "#D63D2B",
    600: "#B72E1F",
    700: "#962519",
    800: "#751D14",
    900: "#55150E",
  },
} as const;

/** Semantic aliases. Use these in screens; reach for `scale` only when building a new alias. */
const light = {
  // Surfaces
  surface: scale.neutral[50],
  surfaceRaised: "#FFFFFF",
  surfaceSunken: scale.neutral[100],
  surfaceInverse: scale.neutral[900],
  surfaceBrand: scale.primary[50],
  surfaceSuccess: scale.success[50],
  surfaceWarning: scale.warning[50],
  surfaceDanger: scale.danger[50],
  // Brand fill (buttons, selected states) and its pressed state
  primary: scale.primary[600],
  primaryPressed: scale.primary[700],
  // Status accents (icons, indicators). Not for body text: use the text* tokens.
  success: scale.success[600],
  warning: scale.warning[600],
  danger: scale.danger[600],
  // Text
  text: scale.neutral[900],
  textMuted: scale.neutral[600],
  textInverse: scale.neutral[50],
  textOnPrimary: "#FFFFFF",
  textLink: scale.primary[700],
  textSuccess: scale.success[700],
  textWarning: scale.warning[700],
  textDanger: scale.danger[700],
  // Borders. `border` is decorative (hairlines). `borderStrong` and `borderFocus` mark
  // interactive boundaries and meet 3:1.
  border: scale.neutral[200],
  borderStrong: scale.neutral[500],
  borderFocus: scale.primary[600],
} as const;

const dark = {
  surface: scale.neutral[900],
  surfaceRaised: scale.neutral[800],
  surfaceSunken: "#12100D",
  surfaceInverse: scale.neutral[50],
  surfaceBrand: "#14261D",
  surfaceSuccess: "#0F2927",
  surfaceWarning: "#2D2208",
  surfaceDanger: "#2E1411",
  primary: scale.primary[400],
  primaryPressed: scale.primary[300],
  success: scale.success[400],
  warning: scale.warning[400],
  danger: scale.danger[400],
  text: scale.neutral[50],
  textMuted: scale.neutral[300],
  textInverse: scale.neutral[900],
  textOnPrimary: scale.neutral[900],
  textLink: scale.primary[300],
  textSuccess: scale.success[300],
  textWarning: scale.warning[300],
  textDanger: scale.danger[300],
  border: scale.neutral[700],
  borderStrong: scale.neutral[400],
  borderFocus: scale.primary[300],
} as const;

export const tokens = {
  color: { scale, light, dark },

  // Sizes and line heights are in px (React Native points). The web build converts to rem.
  type: {
    fontFamily: {
      sans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
      display:
        "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, 'Iowan Old Style', Georgia, serif",
    },
    display: { size: 40, lineHeight: 44, weight: "700", letterSpacing: -0.6 },
    title: { size: 24, lineHeight: 30, weight: "600", letterSpacing: -0.2 },
    body: { size: 16, lineHeight: 24, weight: "400", letterSpacing: 0 },
    caption: { size: 13, lineHeight: 18, weight: "500", letterSpacing: 0.1 },
  },

  // 4pt grid. The key is the step, the value is points: space[3] is 12.
  space: {
    0: 0,
    1: 4,
    2: 8,
    3: 12,
    4: 16,
    5: 20,
    6: 24,
    8: 32,
    10: 40,
    12: 48,
    16: 64,
    20: 80,
  },

  radius: { none: 0, sm: 6, md: 10, lg: 16, xl: 24, full: 9999 },

  // Color is a hex plus an opacity so it maps to both React Native shadow props and CSS.
  shadow: {
    sm: {
      offsetX: 0,
      offsetY: 1,
      blur: 2,
      spread: 0,
      color: "#1A1814",
      opacity: 0.08,
      elevation: 1,
    },
    md: {
      offsetX: 0,
      offsetY: 4,
      blur: 12,
      spread: 0,
      color: "#1A1814",
      opacity: 0.1,
      elevation: 3,
    },
    lg: {
      offsetX: 0,
      offsetY: 12,
      blur: 32,
      spread: 0,
      color: "#1A1814",
      opacity: 0.14,
      elevation: 8,
    },
  },
} as const;

export type Tokens = typeof tokens;
export type ColorMode = "light" | "dark";
