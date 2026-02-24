use crate::app::state::{parse_theme_name, LogColor, ThemeName};
use ratatui::style::Color;
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Copy)]
pub(crate) struct InlinePalette {
    pub(crate) heading: LogColor,
    pub(crate) bold: LogColor,
    pub(crate) inline_code: LogColor,
}

#[derive(Clone, Copy)]
pub(crate) struct UiColors {
    pub(crate) input_bg: Color,
    pub(crate) code_block_bg: Color,
    pub(crate) diff_code_block_bg: Color,  
    pub(crate) diff_added_bg: Color,
    pub(crate) diff_removed_bg: Color,
    pub(crate) log_primary_fg: Color,
    pub(crate) log_muted_fg: Color,
    pub(crate) log_system_fg: Color,
    pub(crate) log_tool_call_fg: Color,
    pub(crate) log_tool_result_fg: Color,
    pub(crate) log_status_fg: Color,
    pub(crate) log_space_fg: Color,
    pub(crate) log_error_fg: Color,
    pub(crate) run_ready_fg: Color,
    pub(crate) run_completed_fg: Color,
    pub(crate) run_cancelled_fg: Color,
    pub(crate) run_error_fg: Color,
    pub(crate) debug_perf_fg: Color,
    pub(crate) bang_prefix_fg: Color,
    pub(crate) panel_divider_fg: Color,
}

#[derive(Clone, Copy)]
struct ThemeDefinition {
    inline_palette: InlinePalette,
    syntect_theme_name: &'static str,
    ui: UiColors,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ThemeKind {
    Codelia,
    Ocean,
    Forest,
    Rose,
    Sakura,
    Mauve,
    Plum,
    Iris,
    Crimson,
    Wine,
}

static THEME_DEFINITION: OnceLock<Mutex<ThemeDefinition>> = OnceLock::new();
static CURRENT_THEME_NAME: OnceLock<Mutex<ThemeName>> = OnceLock::new();

fn theme_kind_for_name(name: ThemeName) -> ThemeKind {
    match name {
        ThemeName::Codelia => ThemeKind::Codelia,
        ThemeName::Ocean => ThemeKind::Ocean,
        ThemeName::Forest => ThemeKind::Forest,
        ThemeName::Rose => ThemeKind::Rose,
        ThemeName::Sakura => ThemeKind::Sakura,
        ThemeName::Mauve => ThemeKind::Mauve,
        ThemeName::Plum => ThemeKind::Plum,
        ThemeName::Iris => ThemeKind::Iris,
        ThemeName::Crimson => ThemeKind::Crimson,
        ThemeName::Wine => ThemeKind::Wine,
    }
}

fn selected_theme_name_from_env() -> ThemeName {
    if let Ok(selected) = std::env::var("CODELIA_TUI_THEME") {
        if let Some(parsed) = parse_theme_name(&selected) {
            return parsed;
        }
    }
    if let Ok(selected) = std::env::var("CODELIA_TUI_MARKDOWN_THEME") {
        if let Some(parsed) = parse_theme_name(&selected) {
            return parsed;
        }
    }
    ThemeName::Codelia
}

fn current_theme_name() -> ThemeName {
    let lock = CURRENT_THEME_NAME.get_or_init(|| Mutex::new(selected_theme_name_from_env()));
    lock.lock()
        .map(|value| *value)
        .unwrap_or(ThemeName::Codelia)
}

pub(crate) fn active_theme_name() -> ThemeName {
    current_theme_name()
}

fn selected_theme_kind() -> ThemeKind {
    theme_kind_for_name(current_theme_name())
}

const fn inline_palette_for_kind(kind: ThemeKind) -> InlinePalette {
    match kind {
        ThemeKind::Ocean => InlinePalette {
            heading: LogColor::rgb(124, 193, 255),
            bold: LogColor::rgb(169, 218, 255),
            inline_code: LogColor::rgb(165, 205, 219),
        },
        ThemeKind::Forest => InlinePalette {
            heading: LogColor::rgb(149, 208, 146),
            bold: LogColor::rgb(186, 230, 173),
            inline_code: LogColor::rgb(167, 206, 188),
        },
        ThemeKind::Rose => InlinePalette {
            heading: LogColor::rgb(201, 112, 130),
            bold: LogColor::rgb(222, 161, 175),
            inline_code: LogColor::rgb(207, 188, 202),
        },
        ThemeKind::Sakura => InlinePalette {
            heading: LogColor::rgb(232, 152, 176),
            bold: LogColor::rgb(244, 193, 210),
            inline_code: LogColor::rgb(232, 208, 220),
        },
        ThemeKind::Mauve => InlinePalette {
            heading: LogColor::rgb(195, 144, 201),
            bold: LogColor::rgb(218, 182, 224),
            inline_code: LogColor::rgb(208, 193, 217),
        },
        ThemeKind::Plum => InlinePalette {
            heading: LogColor::rgb(165, 118, 173),
            bold: LogColor::rgb(191, 156, 199),
            inline_code: LogColor::rgb(186, 174, 197),
        },
        ThemeKind::Iris => InlinePalette {
            heading: LogColor::rgb(157, 140, 214),
            bold: LogColor::rgb(188, 176, 234),
            inline_code: LogColor::rgb(190, 186, 221),
        },
        ThemeKind::Crimson => InlinePalette {
            heading: LogColor::rgb(200, 107, 123),
            bold: LogColor::rgb(217, 138, 154),
            inline_code: LogColor::rgb(193, 176, 205),
        },
        ThemeKind::Wine => InlinePalette {
            heading: LogColor::rgb(176, 122, 143),
            bold: LogColor::rgb(199, 154, 170),
            inline_code: LogColor::rgb(187, 178, 202),
        },
        ThemeKind::Codelia => InlinePalette {
            heading: LogColor::rgb(232, 178, 92),
            bold: LogColor::rgb(248, 208, 120),
            inline_code: LogColor::rgb(215, 188, 155),
        },
    }
}

fn log_color_to_color(value: LogColor) -> Color {
    Color::Rgb(value.r, value.g, value.b)
}

fn ui_for_palette(palette: InlinePalette) -> UiColors {
    UiColors {
        input_bg: Color::Rgb(40, 40, 40),
        code_block_bg: Color::Rgb(36, 44, 52),
        diff_code_block_bg: Color::Rgb(24, 30, 36),   
        diff_added_bg: Color::Rgb(21, 45, 33),
        diff_removed_bg: Color::Rgb(53, 28, 31),
        log_primary_fg: Color::White,
        log_muted_fg: Color::Gray,
        log_system_fg: log_color_to_color(palette.heading),
        log_tool_call_fg: log_color_to_color(palette.bold),
        log_tool_result_fg: Color::Green,
        log_status_fg: log_color_to_color(palette.heading),
        log_space_fg: Color::Black,
        log_error_fg: Color::Red,
        run_ready_fg: Color::White,
        run_completed_fg: Color::LightGreen,
        run_cancelled_fg: Color::LightRed,
        run_error_fg: Color::Red,
        debug_perf_fg: log_color_to_color(palette.inline_code),
        bang_prefix_fg: log_color_to_color(palette.bold),
        panel_divider_fg: Color::DarkGray,
    }
}

fn syntect_theme_name_for_kind(kind: ThemeKind) -> &'static str {
    match kind {
        ThemeKind::Ocean => "base16-ocean.dark",
        ThemeKind::Forest => "Solarized (dark)",
        ThemeKind::Rose
        | ThemeKind::Sakura
        | ThemeKind::Mauve
        | ThemeKind::Plum
        | ThemeKind::Iris
        | ThemeKind::Crimson
        | ThemeKind::Wine
        | ThemeKind::Codelia => "Solarized (dark)",
    }
}

fn build_theme_definition(name: ThemeName) -> ThemeDefinition {
    let kind = theme_kind_for_name(name);
    let inline_palette = inline_palette_for_kind(kind);
    ThemeDefinition {
        inline_palette,
        syntect_theme_name: syntect_theme_name_for_kind(kind),
        ui: ui_for_palette(inline_palette),
    }
}

fn theme_definition_mutex() -> &'static Mutex<ThemeDefinition> {
    THEME_DEFINITION.get_or_init(|| Mutex::new(build_theme_definition(current_theme_name())))
}

pub(crate) fn apply_theme_name(name: ThemeName) {
    if let Ok(mut current) = CURRENT_THEME_NAME
        .get_or_init(|| Mutex::new(selected_theme_name_from_env()))
        .lock()
    {
        *current = name;
    }
    if let Ok(mut definition) = theme_definition_mutex().lock() {
        *definition = build_theme_definition(name);
    }
}

pub(crate) fn inline_palette() -> InlinePalette {
    theme_definition_mutex()
        .lock()
        .map(|theme| theme.inline_palette)
        .unwrap_or_else(|_| inline_palette_for_kind(selected_theme_kind()))
}

pub(crate) fn ui_colors() -> UiColors {
    theme_definition_mutex()
        .lock()
        .map(|theme| theme.ui)
        .unwrap_or_else(|_| ui_for_palette(inline_palette_for_kind(selected_theme_kind())))
}

pub(crate) fn syntect_theme_name() -> &'static str {
    theme_definition_mutex()
        .lock()
        .map(|theme| theme.syntect_theme_name)
        .unwrap_or("Solarized (dark)")
}

pub(crate) fn inline_palette_for(theme: &str) -> InlinePalette {
    let name = parse_theme_name(theme).unwrap_or(ThemeName::Codelia);
    inline_palette_for_kind(theme_kind_for_name(name))
}
