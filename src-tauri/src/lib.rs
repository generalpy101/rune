mod ai;
mod fs;
mod platform;
mod pty;
mod sysmon;
mod update;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(pty::PtyManager::default())
        .manage(ai::CommandRegistry::default())
        .manage(ai::ChatRegistry::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_attach,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_cwd,
            pty::pty_busy,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
