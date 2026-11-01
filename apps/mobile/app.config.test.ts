import { describe, expect, it } from "vitest";
import config, { webOrigin, withRouterOrigin } from "./app.config";
import appJson from "./app.json";

describe("webOrigin", () => {
  it("accepts an https origin and drops any path", () => {
    expect(webOrigin("https://souvie.pages.dev")).toBe("https://souvie.pages.dev");
    expect(webOrigin(" https://app.example.com/ ")).toBe("https://app.example.com");
    expect(webOrigin("https://app.example.com/some/path?x=1")).toBe("https://app.example.com");
  });

  it("refuses anything that is not a deployed https origin", () => {
    expect(webOrigin(undefined)).toBeNull();
    expect(webOrigin("")).toBeNull();
    // The development value in .env.example must never reach a production bundle.
    expect(webOrigin("http://localhost:8081")).toBeNull();
    expect(webOrigin("not a url")).toBeNull();
    expect(webOrigin("souvie://callback")).toBeNull();
  });
});

describe("withRouterOrigin", () => {
  it("adds the origin to a bare expo-router plugin", () => {
    expect(withRouterOrigin(["expo-router", "expo-web-browser"], "https://a.example")).toEqual([
      ["expo-router", { origin: "https://a.example" }],
      "expo-web-browser",
    ]);
  });

  it("keeps the options an expo-router entry already has", () => {
    expect(withRouterOrigin([["expo-router", { root: "src/app" }]], "https://a.example")).toEqual([
      ["expo-router", { root: "src/app", origin: "https://a.example" }],
    ]);
  });

  it("changes nothing without an origin", () => {
    const plugins = ["expo-router"];
    expect(withRouterOrigin(plugins, null)).toBe(plugins);
  });
});

describe("app config for the static web export", () => {
  it("app.json asks for static output with the Metro bundler (not 'server', SDK 58's default)", () => {
    expect(appJson.expo.web.output).toBe("static");
    expect(appJson.expo.web.bundler).toBe("metro");
  });

  it("keeps the scheme and the favicon", () => {
    expect(appJson.expo.scheme).toBe("souvie");
    expect(appJson.expo.web.favicon).toBe("./assets/favicon.png");
  });

  it("the dynamic config passes app.json through", () => {
    const built = config({
      config: appJson.expo as never,
      projectRoot: ".",
      staticConfigPath: null,
      packageJsonPath: null,
    });
    expect(built.web?.output).toBe("static");
    expect(built.scheme).toBe("souvie");
    expect(built.plugins?.length).toBe(appJson.expo.plugins.length);
  });
});
