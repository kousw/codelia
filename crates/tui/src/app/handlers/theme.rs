use crate::app::state::parse_theme_name;
use crate::app::theme::apply_theme_name;

pub(crate) fn apply_theme_from_name(name: &str) -> bool {
    let Some(parsed) = parse_theme_name(name) else {
        return false;
    };
    apply_theme_name(parsed);
    true
}
