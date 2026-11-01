# Souvie desktop

The desktop app is the Expo web export in a Tauri 2 window. There is no second codebase: the
screens are `apps/mobile`, built for the web (`web.output: "static"`), and this folder wraps the
result in a native window with menus. macOS first. Windows builds run in CI and may fail until the
Windows job is proven.

Why Tauri and not React Native macOS or Windows: those lag Expo's React Native version by several
releases and Expo has no desktop target (`docs/01-architecture.md`, "Platform versions").

## How it fits together

```
apps/mobile  --expo export--> apps/mobile/dist  --tauri build--> Souvie.app
 (screens)                    (static files)                     (a window around them)
```

- The bundle is baked into the app. It opens with no network and needs no deploy. Nothing loads a
  remote page.
- `src-tauri/tauri.conf.json` points `frontendDist` at `../../mobile/dist` and runs
  `pnpm --filter @mp/mobile export:web` first, so `tauri build` always bundles a fresh export.
- `src-tauri/src/main.rs` builds the menus and registers two plugins. All the screens are web code.
- The window is 1280 by 800 and can shrink to 800 by 560. At 1024 wide and up the planner shows
  seven columns, the grocery list two panes and a run a table; below that the layouts follow the
  tablet and phone widths (`packages/ui/src/layout.ts`).

## Build it

You need Rust (1.90 or newer), through rustup, and on macOS the Xcode command line tools. The Mac
used for this project has neither installed, and nothing in the repo installs them for you. CI
builds the app (`.github/workflows/desktop.yml`), so you can also take the `.app` from there.

```bash
# once
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
corepack pnpm install

# a window on the Expo dev server (http://localhost:8081), with hot reload
cd apps/desktop && corepack pnpm tauri dev

# the real thing: exports the web app, compiles the shell, writes the .app
cd apps/desktop && corepack pnpm tauri build
open src-tauri/target/release/bundle/macos/Souvie.app
```

The web export reads `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` from the repo
root `.env.local`, as the phone app does. An app built without them opens on the "Backend: not
configured" screen.

To change the icon, replace `apps/mobile/assets/icon.png` (1024 by 1024) and run
`corepack pnpm --filter @mp/desktop icons`.

## Menus

The menu bar has five menus.

| Menu | Holds |
|---|---|
| Souvie (App) | About, Services and Hide on macOS, Quit |
| Edit | Undo, Redo, Cut, Copy, Paste, Select All. Without these, copy and paste do nothing in a macOS web view |
| View | Reload (Cmd or Ctrl R), Enter Full Screen |
| Window | Minimize, Zoom, Close Window |
| Help | Check for Updates, shown and disabled |

"Check for Updates" is a placeholder. The updater is a later workstream.

## Sign-in on the desktop

Sign-in does not happen inside the window. Google refuses to sign anyone in inside an embedded web
view, and the page lives at `tauri://localhost` (macOS) or `http://tauri.localhost` (Windows),
which no email client or identity provider can send a person back to.

So the desktop app does what the phone apps do:

1. The page asks Supabase for the sign-in address with `redirectTo = souvie://callback` and opens
   it in the system browser (Tauri opener plugin).
2. The person signs in there. Supabase redirects to `souvie://callback?code=...`.
3. The operating system hands that link to Souvie (Tauri deep link plugin). The page opens
   `/callback?code=...`, and the callback screen swaps the code for a session. The PKCE verifier
   never left the window's storage.

Email sign-in links work the same way, and the six digit code in the email works as it does
everywhere. The other links the app takes (`souvie://join/<token>`, `souvie://oauth/kroger`) open
their routes too. Anything else is ignored (`src/features/auth/desktopLinks.ts` in `apps/mobile`).

**Local Supabase.** The opener may open `https` addresses only (`opener:allow-open-url` allows
`https://*` and nothing else). Google sign-in against a Supabase project on a plain
`http://` address, such as the local stack at `http://127.0.0.1:54321`, is refused: the sign-in
address never opens. Develop desktop sign-in against the hosted project, or use the six digit
email code, which needs no browser.

**Supabase setup.** Nothing new: `souvie://callback` is already in the redirect allow list for the
phone apps. Do not add `tauri://localhost`. It would not work, and it widens the list.

macOS registers `souvie://` when the app is installed, so deep links work only from the built
`.app` (in `/Applications` or anywhere you opened it from), not from `tauri dev`. To try one:
`open "souvie://callback?code=test"`.

## Sign and notarize (not done yet)

An unsigned app opens on the Mac that built it and shows a warning on every other. To ship it:

1. Join the Apple Developer Program and create a "Developer ID Application" certificate. Export it
   as a `.p12`.
2. Create an app-specific password at appleid.apple.com, or an App Store Connect API key.
3. Set these where the build runs (CI secrets, or your shell). Tauri signs and notarizes during
   `tauri build` when it finds them. Never commit them.

   | Variable | Value |
   |---|---|
   | `APPLE_CERTIFICATE` | the `.p12`, base64 encoded (CI only) |
   | `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password (CI only) |
   | `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
   | `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | the Apple ID, its app-specific password, the team |
   | or `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH` | the API key route |

4. Add `"dmg"` to `bundle.targets` in `tauri.conf.json` to also get a disk image.
5. Windows: buy a code signing certificate and set `bundle.windows.certificateThumbprint`, or sign
   the installer after the build with `signtool`.

Until then, someone who trusts the build can open it with right click, Open, or run
`xattr -dr com.apple.quarantine Souvie.app`.

## Security notes

- `tauri.conf.json` sets a content security policy: scripts only from the bundle, calls only to
  the app itself, Supabase, PostHog and Sentry, pictures over https. Add a host there before the
  app calls a new one.
- The page may ask the shell for three things (`src-tauri/capabilities/default.json`): window and
  event basics, `souvie://` links, and opening an `https` address in the system browser. It cannot
  read files, run commands or reach the network through the shell.
- `config.test.ts` holds these files to the brief and to each other without Rust installed.

## Known limits

- **Updates.** No updater, no update server. The menu item is a placeholder.
- **Signing.** Not signed or notarized (above).
- **Push.** The desktop app registers no push token. The profile screen says so.
- **Kroger connect and the assisted checkout.** Both open a page inside the app today (an auth
  session popup, a WebView). The desktop window has neither yet. Connecting a store, and shopping
  on a retailer's own site, are phone features until WS08's host and WS10's adapters get a desktop
  mount. The shell can hold a WebView; the host is not mounted in it.
- **Windows and Linux.** `main.rs` compiles for both and the CI Windows job builds it, but nothing
  has been run on them. The deep link scheme registers at install time there.
- **`Cargo.lock`.** Committed, from the first CI build, because the Mac this was written on has no
  Rust. Cargo keeps to it. After you change a dependency in `Cargo.toml`, build once on a Mac with
  Rust (or take the artifact from CI) and commit the new lock.
