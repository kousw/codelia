//! Add shell action icons to Kit's small default component asset bundle.
use gpui_kit::{AssetSource, Result, SharedString};
use std::borrow::Cow;

gpui_kit::assets::icon_assets!(ShellIcons, [FileDiff, X]);

pub struct DesktopAssets;
impl AssetSource for DesktopAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if let Some(bytes) = ShellIcons.load(path)? {
            return Ok(Some(bytes));
        }
        gpui_kit::assets::Assets.load(path)
    }
    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut paths = gpui_kit::assets::Assets.list(path)?;
        paths.extend(ShellIcons.list(path)?);
        paths.sort();
        paths.dedup();
        Ok(paths)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::assets::IconName;
    #[test]
    fn native_action_icons_have_readable_svg_assets() {
        for icon in [
            IconName::FileDiff,
            IconName::X,
            IconName::PanelLeft,
            IconName::FolderOpen,
            IconName::Plus,
        ] {
            let bytes = DesktopAssets.load(&icon.path()).unwrap().unwrap();
            assert!(std::str::from_utf8(&bytes).unwrap().contains("<svg"));
        }
    }
}
