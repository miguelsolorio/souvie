/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  // "media" makes NativeWind 4.2 throw on web in dev ("Cannot manually set color scheme")
  // when its stylesheet loads after the runtime. "class" avoids that. Dark mode itself is
  // left to the UI workstreams (WS04, WS14), which toggle it with NativeWind's colorScheme.
  darkMode: "class",
  theme: {
    extend: {
      // One placeholder color. Real tokens come from packages/ui (WS04, WS14).
      colors: {
        brand: "#2F6B4F",
      },
    },
  },
  plugins: [],
};
