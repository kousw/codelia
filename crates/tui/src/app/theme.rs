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
    pub(crate) surface_fg: Color,
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
pub(crate) enum ColorScheme {
    Dark,
    Light,
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
static COLOR_SCHEME: OnceLock<ColorScheme> = OnceLock::new();

fn color_scheme() -> ColorScheme {
    *COLOR_SCHEME.get_or_init(|| ColorScheme::Dark)
}

pub(crate) fn initialize_color_scheme(scheme: ColorScheme) {
    let _ = COLOR_SCHEME.set(scheme);
}

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

const fn darken_for_light(value: LogColor) -> LogColor {
    LogColor::rgb(value.r / 2, value.g / 2, value.b / 2)
}

const fn inline_palette_for_scheme(kind: ThemeKind, scheme: ColorScheme) -> InlinePalette {
    let palette = inline_palette_for_kind(kind);
    match scheme {
        ColorScheme::Dark => palette,
        ColorScheme::Light => InlinePalette {
            heading: darken_for_light(palette.heading),
            bold: darken_for_light(palette.bold),
            inline_code: darken_for_light(palette.inline_code),
        },
    }
}

fn log_color_to_color(value: LogColor) -> Color {
    Color::Rgb(value.r, value.g, value.b)
}

fn ui_for_palette(palette: InlinePalette, scheme: ColorScheme) -> UiColors {
    let accent_heading = log_color_to_color(palette.heading);
    let accent_bold = log_color_to_color(palette.bold);
    let accent_inline = log_color_to_color(palette.inline_code);
    match scheme {
        ColorScheme::Dark => UiColors {
            input_bg: Color::Rgb(40, 40, 40),
            code_block_bg: Color::Rgb(36, 44, 52),
            diff_code_block_bg: Color::Rgb(24, 30, 36),
            diff_added_bg: Color::Rgb(21, 45, 33),
            diff_removed_bg: Color::Rgb(53, 28, 31),
            surface_fg: Color::Rgb(238, 238, 238),
            log_primary_fg: Color::Reset,
            log_muted_fg: Color::Gray,
            log_system_fg: accent_heading,
            log_tool_call_fg: accent_bold,
            log_tool_result_fg: Color::Reset,
            log_status_fg: accent_heading,
            log_space_fg: Color::Reset,
            log_error_fg: Color::LightRed,
            run_ready_fg: Color::Reset,
            run_completed_fg: Color::LightGreen,
            run_cancelled_fg: Color::LightRed,
            run_error_fg: Color::LightRed,
            debug_perf_fg: accent_inline,
            bang_prefix_fg: accent_bold,
            panel_divider_fg: Color::DarkGray,
        },
        ColorScheme::Light => UiColors {
            input_bg: Color::Rgb(242, 242, 242),
            code_block_bg: Color::Rgb(246, 248, 250),
            diff_code_block_bg: Color::Rgb(240, 242, 244),
            diff_added_bg: Color::Rgb(224, 244, 232),
            diff_removed_bg: Color::Rgb(252, 228, 232),
            surface_fg: Color::Rgb(32, 33, 36),
            log_primary_fg: Color::Reset,
            log_muted_fg: Color::DarkGray,
            log_system_fg: accent_heading,
            log_tool_call_fg: accent_bold,
            log_tool_result_fg: Color::Reset,
            log_status_fg: accent_heading,
            log_space_fg: Color::Reset,
            log_error_fg: Color::Rgb(176, 32, 42),
            run_ready_fg: Color::Reset,
            run_completed_fg: Color::Rgb(30, 122, 62),
            run_cancelled_fg: Color::Rgb(176, 32, 42),
            run_error_fg: Color::Rgb(176, 32, 42),
            debug_perf_fg: accent_inline,
            bang_prefix_fg: accent_bold,
            panel_divider_fg: Color::Rgb(160, 160, 160),
        },
    }
}

fn syntect_theme_name_for_kind(kind: ThemeKind, scheme: ColorScheme) -> &'static str {
    if scheme == ColorScheme::Light {
        return "Solarized (light)";
    }
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
    let scheme = color_scheme();
    let inline_palette = inline_palette_for_scheme(kind, scheme);
    ThemeDefinition {
        inline_palette,
        syntect_theme_name: syntect_theme_name_for_kind(kind, scheme),
        ui: ui_for_palette(inline_palette, scheme),
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
        .unwrap_or_else(|_| inline_palette_for_scheme(selected_theme_kind(), color_scheme()))
}

pub(crate) fn ui_colors() -> UiColors {
    theme_definition_mutex()
        .lock()
        .map(|theme| theme.ui)
        .unwrap_or_else(|_| {
            let scheme = color_scheme();
            ui_for_palette(
                inline_palette_for_scheme(selected_theme_kind(), scheme),
                scheme,
            )
        })
}

pub(crate) fn syntect_theme_name() -> &'static str {
    theme_definition_mutex()
        .lock()
        .map(|theme| theme.syntect_theme_name)
        .unwrap_or("Solarized (dark)")
}

fn syntect_fallback_theme_name_for_scheme(scheme: ColorScheme) -> &'static str {
    match scheme {
        ColorScheme::Dark => "Solarized (dark)",
        ColorScheme::Light => "InspiredGitHub",
    }
}

pub(crate) fn syntect_fallback_theme_name() -> &'static str {
    syntect_fallback_theme_name_for_scheme(color_scheme())
}

#[cfg(test)]
pub(crate) fn inline_palette_for(theme: &str) -> InlinePalette {
    let name = parse_theme_name(theme).unwrap_or(ThemeName::Codelia);
    inline_palette_for_kind(theme_kind_for_name(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn light_scheme_uses_dark_accents_and_light_surfaces() {
        let palette = inline_palette_for_scheme(ThemeKind::Codelia, ColorScheme::Light);
        let colors = ui_for_palette(palette, ColorScheme::Light);

        assert_eq!(palette.heading, LogColor::rgb(116, 89, 46));
        assert_eq!(colors.input_bg, Color::Rgb(242, 242, 242));
        assert_eq!(colors.surface_fg, Color::Rgb(32, 33, 36));
        assert_eq!(colors.log_primary_fg, Color::Reset);
    }

    #[test]
    fn every_light_accent_meets_normal_text_contrast_on_white() {
        fn linear(component: u8) -> f64 {
            let value = f64::from(component) / 255.0;
            if value <= 0.04045 {
                value / 12.92
            } else {
                ((value + 0.055) / 1.055).powf(2.4)
            }
        }

        fn contrast_on_white(color: LogColor) -> f64 {
            let luminance =
                0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
            1.05 / (luminance + 0.05)
        }

        let kinds = [
            ThemeKind::Codelia,
            ThemeKind::Ocean,
            ThemeKind::Forest,
            ThemeKind::Rose,
            ThemeKind::Sakura,
            ThemeKind::Mauve,
            ThemeKind::Plum,
            ThemeKind::Iris,
            ThemeKind::Crimson,
            ThemeKind::Wine,
        ];
        for kind in kinds {
            let palette = inline_palette_for_scheme(kind, ColorScheme::Light);
            for color in [palette.heading, palette.bold, palette.inline_code] {
                assert!(
                    contrast_on_white(color) >= 4.5,
                    "{kind:?} accent {color:?} lacks contrast on white"
                );
            }
        }
    }

    #[test]
    fn light_scheme_selects_light_syntax_theme() {
        assert_eq!(
            syntect_theme_name_for_kind(ThemeKind::Ocean, ColorScheme::Light),
            "Solarized (light)"
        );
        assert_eq!(
            syntect_theme_name_for_kind(ThemeKind::Ocean, ColorScheme::Dark),
            "base16-ocean.dark"
        );
        assert_eq!(
            syntect_fallback_theme_name_for_scheme(ColorScheme::Light),
            "InspiredGitHub"
        );
    }
}
