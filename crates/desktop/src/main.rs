extern crate gpui_kit as gpui;
mod app;
mod application;
mod assets;
mod client_tool;
mod draft_controller;
mod draft_store;
mod drafts;
mod git;
mod launch;
mod runtime_adapter;
mod state;
mod tasks_view;
mod transport;
mod ui;
use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::*;
fn main() {
    let launch = match std::env::current_exe()
        .map_err(anyhow::Error::from)
        .and_then(|exe| launch::resolve(std::env::args_os().nth(1), &exe))
    {
        Ok(launch) => launch,
        Err(error) => {
            eprintln!("codelia-desktop launch failed: {error:#}");
            std::process::exit(1);
        }
    };
    gpui_kit::application()
        .with_assets(assets::DesktopAssets)
        .run(move |cx| {
            gpui_kit::init(cx);
            Theme::change(ThemeMode::Light, None, cx);
            Theme::update(cx, |theme| {
                theme.primary = rgb(0x18181b).into();
                theme.primary_foreground = rgb(0xffffff).into();
                theme.background = rgb(0xffffff).into();
                theme.foreground = rgb(0x18181b).into();
                theme.border = rgb(0xe4e4e7).into();
                theme.ring = rgb(0x71717a).into();
                theme.focus_ring = false;
                theme.shadow = false;
                theme.radius = px(6.);
            });
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            cx.bind_keys([
                KeyBinding::new("cmd-q", app::Quit, None),
                KeyBinding::new("cmd-enter", app::Send, Some("Codelia")),
                KeyBinding::new("cmd-enter", app::Send, Some("Composer > Input")),
            ]);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(1240.), px(830.)),
                    cx,
                ))),
                titlebar: Some(TitlebarOptions {
                    title: Some("Codelia".into()),
                    ..Default::default()
                }),
                window_min_size: Some(size(px(760.), px(560.))),
                ..Default::default()
            };
            gpui_kit::open_window(options, cx, |window, cx| {
                cx.new(|cx| app::Desktop::new(launch.root, launch.runtime, window, cx))
            })
            .expect("Open Codelia window");
            cx.activate(true);
        });
}
