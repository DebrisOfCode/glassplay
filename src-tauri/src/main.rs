// Niente console in background nelle build di release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    glassplay_lib::run();
}
