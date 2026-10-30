// Loose types for tailwind.preset.js so tests and TypeScript configs can import it.
type Rules = Record<string, Record<string, string>>;

declare const preset: {
  darkMode: "class";
  theme: Record<string, unknown> & { extend: Record<string, unknown> };
  plugins: Array<(api: { addBase: (rules: Rules) => void }) => void>;
};

export default preset;
