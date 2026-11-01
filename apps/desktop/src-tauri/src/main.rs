// Souvie desktop shell (WS13): a Tauri 2 window around the Expo web export in apps/mobile/dist.
// The bundle is baked into the app, so it opens with no network and no deploy. Everything the
// person sees is the web app; this file only builds the window's menus and wires the two plugins
// sign-in needs.
//
//   deep link   the operating system hands souvie://callback?code=... (sign-in finished in the
//               system browser) to the page, which listens for it (DesktopDeepLinks.tsx)
//   opener      the page asks to open the sign-in address in the system browser
//
// Menus: App, Edit, View, Window, Help. "Check for Updates" is a disabled placeholder until the
// updater exists (README.md, "Known limits").

// Keeps Windows from opening a console window beside the app in a release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{Menu, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Manager, Wry};

/// Menu item ids. The click handler in `main` matches on them.
const MENU_RELOAD: &str = "reload";
const MENU_CHECK_FOR_UPDATES: &str = "check-for-updates";

/// The window the app opens, named in tauri.conf.json.
const MAIN_WINDOW: &str = "main";

/// The menu bar: App, Edit, View, Window, Help.
///
/// On macOS the first submenu is the application menu whatever its label, so the product name
/// goes there, and Services and the Hide items live in it. Edit holds the standard text commands,
/// without which copy and paste do nothing in a macOS web view.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let product = app.package_info().name.clone();

    let app_menu = SubmenuBuilder::new(app, &product).about(None).separator();
    #[cfg(target_os = "macos")]
    let app_menu = app_menu
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator();
    let app_menu = app_menu.quit().build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let reload = MenuItem::with_id(app, MENU_RELOAD, "Reload", true, Some("CmdOrCtrl+R"))?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&reload)
        .separator()
        .fullscreen()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    // A placeholder: shown, greyed out, and wired to nothing.
    let check_for_updates = MenuItem::with_id(
        app,
        MENU_CHECK_FOR_UPDATES,
        "Check for Updates...",
        false,
        None::<&str>,
    )?;
    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&check_for_updates)
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
        .build()
}

fn main() {
    let mut builder = tauri::Builder::default();

    // Registered first, as the deep link plugin requires.
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // The link itself reaches the page through the deep link plugin. Bring the window up.
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // An installed Windows or Linux app registers souvie:// with the installer. A
            // development run has no installer, so register it at startup there.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }

            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                if event.id().0.as_str() == MENU_RELOAD {
                    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                        let _ = window.eval("window.location.reload()");
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Souvie");
}
