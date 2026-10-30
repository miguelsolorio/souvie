// NativeWind v4: route JSX through nativewind so `className` works on native and web.
// babel-preset-expo adds the Reanimated/Worklets plugin on its own.
module.exports = (api) => {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { jsxImportSource: "nativewind" }], "nativewind/babel"],
  };
};
