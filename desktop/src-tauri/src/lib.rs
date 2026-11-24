// ShiftBoss desktop shell: starts the bundled ShiftBoss server (unless one is already running),
// shows it in a native window, and keeps a tray icon with notifications for decisions waiting on you.
use std::{collections::HashSet, net::TcpStream, sync::Mutex, thread, time::Duration};

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, Url, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::{process::CommandChild, ShellExt};

const PORT: u16 = 4400;
const HIDDEN_FLAG: &str = "--hidden";

/// The server process this app started, so it can be stopped on quit. None when we reused one.
struct Sidecar(Mutex<Option<CommandChild>>);

fn server_up() -> bool {
    TcpStream::connect_timeout(&([127, 0, 0, 1], PORT).into(), Duration::from_millis(400)).is_ok()
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn go_to(app: &AppHandle, hash: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(&format!("location.hash = {}", serde_json::to_string(hash).unwrap_or_default()));
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open ShiftBoss", true, None::<&str>)?;
    let needs = MenuItem::with_id(app, "needs", "Needs you", true, None::<&str>)?;
    let at_login = app.autolaunch().is_enabled().unwrap_or(false);
    let login = CheckMenuItem::with_id(app, "login", "Start at login", true, at_login, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit ShiftBoss", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &needs, &sep1, &login, &sep2, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("app icon"))
        .tooltip("ShiftBoss")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "needs" => {
                show_main(app);
                go_to(app, "#/needs");
            }
            "login" => {
                let launcher = app.autolaunch();
                let _ = if launcher.is_enabled().unwrap_or(false) { launcher.disable() } else { launcher.enable() };
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Every few seconds: update the tray tooltip with how many decisions wait, and notify for new ones.
fn watch_needs(app: AppHandle) {
    thread::spawn(move || {
        let mut seen: HashSet<i64> = HashSet::new();
        let mut first_pass = true;
        loop {
            thread::sleep(Duration::from_secs(4));
            let url = format!("http://127.0.0.1:{PORT}/api/snapshot");
            let Ok(resp) = ureq::get(&url).timeout(Duration::from_secs(3)).call() else { continue };
            let Ok(snap) = resp.into_json::<serde_json::Value>() else { continue };
            let open: Vec<&serde_json::Value> = snap["needs"]
                .as_array()
                .map(|all| all.iter().filter(|n| n["answer"].is_null()).collect())
                .unwrap_or_default();
            if let Some(tray) = app.tray_by_id("main") {
                let tip = match open.len() {
                    0 => "ShiftBoss · nothing needs you".to_string(),
                    1 => "ShiftBoss · 1 thing needs you".to_string(),
                    n => format!("ShiftBoss · {n} things need you"),
                };
                let _ = tray.set_tooltip(Some(tip));
            }
            for need in &open {
                let id = need["id"].as_i64().unwrap_or_default();
                // Items already open when the app starts are not announced again.
                if seen.insert(id) && !first_pass {
                    let title = need["title"].as_str().unwrap_or("A session needs you");
                    let _ = app.notification().builder().title("ShiftBoss · needs you").body(title).show();
                }
            }
            first_pass = false;
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch just brings the existing window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN_FLAG])))
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            // Reuse a ShiftBoss that is already running (e.g. from a source checkout); otherwise start ours.
            if !server_up() {
                let data_dir = app.path().app_data_dir()?;
                std::fs::create_dir_all(&data_dir)?;
                let (_events, child) = app
                    .shell()
                    .sidecar("shiftboss-server")?
                    .env("SHIFTBOSS_DATA_DIR", data_dir.to_string_lossy().to_string())
                    .env("SHIFTBOSS_PORT", PORT.to_string())
                    .spawn()?;
                *app.state::<Sidecar>().0.lock().unwrap() = Some(child);
            }

            if std::env::args().any(|a| a == HIDDEN_FLAG) {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }

            // Show the loading page until the server answers, then load ShiftBoss itself.
            let handle = app.handle().clone();
            thread::spawn(move || {
                for _ in 0..240 {
                    if server_up() {
                        break;
                    }
                    thread::sleep(Duration::from_millis(250));
                }
                if let (Some(w), Ok(url)) = (handle.get_webview_window("main"), Url::parse(&format!("http://127.0.0.1:{PORT}/"))) {
                    let _ = w.navigate(url);
                }
            });

            build_tray(app)?;
            watch_needs(app.handle().clone());
            Ok(())
        })
        // Closing the window keeps ShiftBoss running in the tray; Quit is in the tray menu.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while starting ShiftBoss")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(child) = app.state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
