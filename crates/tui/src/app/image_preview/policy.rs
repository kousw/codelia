use ratatui_image::{
    protocol::{halfblocks::Halfblocks, kitty::StatefulKitty, StatefulProtocolType},
    FontSize,
};

#[derive(Clone, Debug)]
pub(crate) struct PreviewPolicy {
    pub font: FontSize,
    pub kitty_id: Option<u32>,
    pub label: String,
}

impl Default for PreviewPolicy {
    fn default() -> Self {
        Self {
            font: FontSize::new(8, 16),
            kitty_id: None,
            label: "halfblocks (text cells; no terminal queries)".into(),
        }
    }
}

impl PreviewPolicy {
    pub fn resolve(
        request: Option<&str>,
        alternate: bool,
        tmux: bool,
        font: Option<FontSize>,
    ) -> Self {
        let fallback = |reason: &str| Self {
            label: format!("halfblocks ({reason})"),
            ..Self::default()
        };
        match request {
            None | Some("halfblocks") => Self::default(),
            Some("kitty") if !alternate => fallback("Kitty requires --tui-mode alternate"),
            Some("kitty") if tmux => fallback("Kitty disabled in tmux; settings unchanged"),
            Some("kitty") => match font
                .filter(|f| f.width > 0 && f.height > 0 && f.width <= 32 && f.height <= 64)
            {
                Some(font) => Self {
                    font,
                    // One reusable virtual image per TUI process, not one per resize/open.
                    kitty_id: Some(0xc00000 | (std::process::id() & 0x3fffff)),
                    label: "Kitty (explicit opt-in; alternate screen)".into(),
                },
                None => fallback("no safe pixel cell size from OS; Kitty disabled"),
            },
            Some(_) => fallback("unknown CODELIA_TUI_IMAGE_PROTOCOL; use halfblocks or kitty"),
        }
    }

    pub(super) fn protocol_type(&self) -> StatefulProtocolType {
        match self.kitty_id {
            Some(id) => StatefulProtocolType::Kitty(StatefulKitty::new(id, false)),
            None => StatefulProtocolType::Halfblocks(Halfblocks::default()),
        }
    }
}
