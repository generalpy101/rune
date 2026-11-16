mod ai;
mod browser;
mod fs;
mod platform;
mod pty;
mod sysmon;
mod update;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let handler: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
        pty::pty_spawn,
        pty::pty_attach,
        pty::pty_write,
        pty::pty_resize,
        pty::pty_kill,
        pty::pty_cwd,
        pty::pty_busy,
        pty::agent_spawn,
        fs::list_dir,
        fs::read_file,
        fs::write_file,
        fs::create_file,
        fs::create_dir,
        fs::rename_path,
        fs::move_path,
        fs::copy_path,
        fs::duplicate_path,
        fs::delete_path,
        fs::home_dir,
        fs::reveal_in_finder,
        fs::git_status,
        fs::git_branch,
        fs::git_file_head,
        fs::notify,
        fs::walk_dir,
        ai::ai_chat,
        ai::cancel_chat,
        ai::ai_list_models,
        ai::run_command,
        ai::cancel_command,
        ai::cancel_all_commands,
        ai::list_running_commands,
        ai::run_background,
        ai::command_output,
        sysmon::list_listening_ports,
        sysmon::kill_process,
        update::check_update,
        update::install_update,
        browser::browser_open,
        browser::browser_navigate,
        browser::browser_nav,
        browser::browser_set_bounds,
        browser::browser_set_visible,
        browser::browser_close,
        browser::browser_clear_data,
        browser::import::browser_profiles,
        browser::import::browser_import_bookmarks,
        browser::cookies::browser_import_cookies,
    ];
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(pty::PtyManager::default())
        .manage(ai::CommandRegistry::default())
        .manage(ai::ChatRegistry::default())
        .channel_interceptor(browser::deliver_channel_payload)
        .on_page_load(|webview, payload| {
            // Rune's UI (re)loaded: drop browser webviews from the old page.
            if webview.label() == browser::MAIN_WEBVIEW
                && payload.event() == tauri::webview::PageLoadEvent::Started
            {
                browser::close_all(webview.app_handle());
            }
        })
        .invoke_handler(move |invoke| {
            // Browser panes host untrusted pages in child webviews of this
            // window. Only Rune's own UI webview may call app commands.
            if invoke.message.webview_ref().label() != browser::MAIN_WEBVIEW {
                invoke
                    .resolver
                    .reject("Rune commands are not available to web pages");
                return true;
            }
            handler(invoke)
        });
    // ⌘W from a focused browser page must close the pane, not the window.
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(browser::app_menu::<tauri::Wry>)
        .on_menu_event(browser::on_menu_event::<tauri::Wry>);
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
