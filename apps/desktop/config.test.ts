/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The desktop shell's files, checked as text (WS13). Rust and the Tauri toolchain are not on the
// development Mac, so these tests need neither: they read tauri.conf.json, the capability file,
// Cargo.toml and main.rs and hold them to the brief and to each other. `cargo` itself runs in CI
// (.github/workflows/desktop.yml).

const HERE = dirname(fileURLToPath(import.meta.url));
const TAURI = join(HERE, "src-tauri");
const MOBILE = join(HERE, "..", "mobile");

// Only the fields these tests read.
interface TauriConf {
  productName: string;
  version: string;
  identifier: string;
  build: { frontendDist: string; beforeBuildCommand: string };
  app: {
    windows: Array<{
      label: string;
      title: string;
      width: number;
      height: number;
      minWidth: number;
    }>;
    security: { csp: string; dangerousDisableAssetCspModification: string[] };
  };
  bundle: { active: boolean; targets: string[]; icon: string[] };
  plugins: { "deep-link": { desktop: { schemes: string[] } } };
}
interface Capability {
  windows: string[];
  permissions: Array<string | { identifier: string; allow?: Array<{ url: string }> }>;
}
interface PackageJson {
  version: string;
  scripts: Record<string, string | undefined>;
  devDependencies?: Record<string, string>;
}

const read = (path: string) => readFileSync(path, "utf8");
const json = <T>(path: string) => JSON.parse(read(path)) as T;

const conf = json<TauriConf>(join(TAURI, "tauri.conf.json"));
const capability = json<Capability>(join(TAURI, "capabilities", "default.json"));
const cargo = read(join(TAURI, "Cargo.toml"));
const mainRs = read(join(TAURI, "src", "main.rs"));
const appJson = json<{ expo: { scheme: string } }>(join(MOBILE, "app.json"));
const mobilePackage = json<PackageJson>(join(MOBILE, "package.json"));
const desktopPackage = json<PackageJson>(join(HERE, "package.json"));

describe("tauri.conf.json", () => {
  it("names the app Souvie, with the identifier from the brief", () => {
    expect(conf.productName).toBe("Souvie");
    expect(conf.identifier).toBe("com.miguelsolorio.souvie.desktop");
    expect(conf.app.windows).toHaveLength(1);
    expect(conf.app.windows[0].title).toBe("Souvie");
    expect(conf.app.windows[0].label).toBe("main");
  });

  it("opens at the brief's 1280 by 800 laptop size, and can shrink to the phone layout", () => {
    const [window] = conf.app.windows;
    expect([window.width, window.height]).toEqual([1280, 800]);
    expect(window.minWidth).toBeLessThan(1024);
  });

  it("bundles the web export from apps/mobile/dist, never a remote address", () => {
    const dist = resolve(TAURI, conf.build.frontendDist);
    expect(dist).toBe(join(MOBILE, "dist"));
    expect(String(conf.build.frontendDist)).not.toMatch(/^https?:/);
  });

  it("builds the export before it bundles, with a script that exists", () => {
    expect(conf.build.beforeBuildCommand).toContain("@mp/mobile");
    expect(conf.build.beforeBuildCommand).toContain("export:web");
    expect(mobilePackage.scripts["export:web"]).toBe("expo export --platform web");
  });

  it("asks for a macOS .app, with icons that exist", () => {
    expect(conf.bundle.active).toBe(true);
    expect(conf.bundle.targets).toContain("app");
    for (const icon of conf.bundle.icon as string[]) {
      expect(existsSync(join(TAURI, icon)), icon).toBe(true);
    }
    expect(conf.bundle.icon).toContain("icons/icon.icns");
  });

  it("takes souvie:// links, the scheme the phone apps use", () => {
    expect(conf.plugins["deep-link"].desktop.schemes).toEqual([appJson.expo.scheme]);
    expect(appJson.expo.scheme).toBe("souvie");
  });

  it("keeps the app version in step with its package", () => {
    expect(conf.version).toBe(desktopPackage.version);
  });
});

describe("content security policy", () => {
  const csp = String(conf.app.security.csp);
  const directive = (name: string) =>
    csp
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name} `));

  it("lets scripts come only from the bundle", () => {
    expect(directive("script-src")).toBe("script-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("*.*");
  });

  it("forbids plugins and foreign forms and base tags", () => {
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("base-uri")).toBe("base-uri 'self'");
    expect(directive("form-action")).toBe("form-action 'self'");
  });

  it("allows the calls the app makes: Supabase over https and wss, and the shell's own IPC", () => {
    const connect = directive("connect-src") ?? "";
    expect(connect).toContain("https://*.supabase.co");
    expect(connect).toContain("wss://*.supabase.co");
    expect(connect).toContain("ipc:");
    expect(connect).toContain("http://ipc.localhost");
  });

  it("shows pictures from the stores and from Storage, over https only", () => {
    expect(directive("img-src")).toContain("https:");
    expect(directive("img-src")).not.toContain("http:");
  });

  it("keeps inline styles, which react-native-web writes, without Tauri hashing them away", () => {
    // A hash in style-src makes browsers ignore 'unsafe-inline', and every style="..." in the
    // exported pages would be dropped. Tauri is told to leave style-src alone.
    expect(directive("style-src")).toContain("'unsafe-inline'");
    expect(conf.app.security.dangerousDisableAssetCspModification).toEqual(["style-src"]);
  });
});

describe("capabilities", () => {
  const permissions = capability.permissions as Array<string | { identifier: string }>;
  const ids = permissions.map((p) => (typeof p === "string" ? p : p.identifier));

  it("applies to the main window only", () => {
    expect(capability.windows).toEqual([conf.app.windows[0].label]);
  });

  it("lets the page hear deep links", () => {
    // plugin:event|listen is how the deep link package subscribes (desktop.spec.ts shows it).
    expect(ids).toContain("core:event:default");
    expect(ids).toContain("deep-link:default");
  });

  it("opens only https addresses in the system browser", () => {
    const open = permissions.find(
      (p): p is { identifier: string; allow: Array<{ url: string }> } =>
        typeof p === "object" && p.identifier === "opener:allow-open-url",
    );
    expect(open?.allow).toEqual([{ url: "https://*" }]);
    // Not the plugin's default set, which would also reveal files in a folder.
    expect(ids).not.toContain("opener:default");
  });
});

describe("main.rs", () => {
  it("builds the five menus the brief names, in order", () => {
    const menus = [...mainRs.matchAll(/SubmenuBuilder::new\(app, ("?[^)]+)\)/g)].map(
      (match) => match[1],
    );
    expect(menus).toEqual(["&product", '"Edit"', '"View"', '"Window"', '"Help"']);
    expect(mainRs).toContain(
      ".items(&[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu])",
    );
  });

  it("has a Check for Updates placeholder that is shown and disabled", () => {
    expect(mainRs).toMatch(/MENU_CHECK_FOR_UPDATES,\s*"Check for Updates\.\.\.",\s*false,/);
  });

  it("registers the two plugins the capability file allows, and the single instance one first", () => {
    expect(mainRs).toContain("tauri_plugin_deep_link::init()");
    expect(mainRs).toContain("tauri_plugin_opener::init()");
    expect(mainRs.indexOf("tauri_plugin_single_instance::init")).toBeLessThan(
      mainRs.indexOf("tauri_plugin_deep_link::init()"),
    );
  });

  it("loads the page from the bundle: no remote window URL anywhere in the Rust", () => {
    expect(mainRs).not.toMatch(/WebviewUrl::External|https?:\/\//);
  });
});

describe("Cargo.toml", () => {
  it("depends on tauri 2 and the three plugins", () => {
    expect(cargo).toMatch(/^tauri = \{ version = "2"/m);
    expect(cargo).toMatch(/^tauri-plugin-deep-link = "2"/m);
    expect(cargo).toMatch(/^tauri-plugin-opener = "2"/m);
    // generate_context! expands to code that names serde_json; CI failed without it.
    expect(cargo).toMatch(/^serde_json = "1"/m);
    expect(cargo).toMatch(
      /tauri-plugin-single-instance = \{ version = "2", features = \["deep-link"\] \}/,
    );
    expect(cargo).toMatch(/^tauri-build = \{ version = "2"/m);
  });

  it("has a build script", () => {
    expect(existsSync(join(TAURI, "build.rs"))).toBe(true);
  });
});

describe("the desktop package", () => {
  it("has a tauri script and no dev, build, lint, test or typecheck task for the root to pick up", () => {
    expect(desktopPackage.scripts.tauri).toBe("tauri");
    for (const task of ["dev", "build", "lint", "test", "typecheck"]) {
      expect(desktopPackage.scripts[task], task).toBeUndefined();
    }
  });

  it("pins the CLI to the version the plugins were read against", () => {
    expect(desktopPackage.devDependencies["@tauri-apps/cli"]).toMatch(/^2\.\d+\.\d+$/);
  });
});
