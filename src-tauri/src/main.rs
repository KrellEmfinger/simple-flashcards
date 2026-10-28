// Hide the extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init()) // open web links in the normal browser
        .plugin(tauri_plugin_dialog::init()) // "Save as" dialog for exports
        .plugin(tauri_plugin_fs::init()) // write the exported file
        .run(tauri::generate_context!())
        .expect("error while running Simple Flashcards");
}
