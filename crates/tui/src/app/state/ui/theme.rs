use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeName {
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

impl ThemeName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codelia => "codelia",
            Self::Ocean => "ocean",
            Self::Forest => "forest",
            Self::Rose => "rose",
            Self::Sakura => "sakura",
            Self::Mauve => "mauve",
            Self::Plum => "plum",
            Self::Iris => "iris",
            Self::Crimson => "crimson",
            Self::Wine => "wine",
        }
    }

    pub fn aliases(self) -> &'static [&'static str] {
        match self {
            Self::Codelia => &["amber"],
            Self::Rose => &["rose-gold", "rosegold"],
            Self::Crimson => &["crimson-mist", "crimsonmist"],
            Self::Wine => &["wine-steel", "winesteel"],
            _ => &[],
        }
    }
}

impl fmt::Display for ThemeName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ThemeOption {
    pub name: ThemeName,
    pub preview: &'static str,
}

const THEME_OPTIONS: &[ThemeOption] = &[
    ThemeOption {
        name: ThemeName::Codelia,
        preview: "warm amber accents (default)",
    },
    ThemeOption {
        name: ThemeName::Ocean,
        preview: "cool blue accents",
    },
    ThemeOption {
        name: ThemeName::Forest,
        preview: "calm green accents",
    },
    ThemeOption {
        name: ThemeName::Rose,
        preview: "dusty rose accents",
    },
    ThemeOption {
        name: ThemeName::Sakura,
        preview: "light pink accents",
    },
    ThemeOption {
        name: ThemeName::Mauve,
        preview: "soft violet accents",
    },
    ThemeOption {
        name: ThemeName::Plum,
        preview: "deep purple accents",
    },
    ThemeOption {
        name: ThemeName::Iris,
        preview: "indigo accents",
    },
    ThemeOption {
        name: ThemeName::Crimson,
        preview: "rich red accents",
    },
    ThemeOption {
        name: ThemeName::Wine,
        preview: "wine-magenta accents",
    },
];

pub fn theme_options() -> &'static [ThemeOption] {
    THEME_OPTIONS
}

pub fn parse_theme_name(value: &str) -> Option<ThemeName> {
    let trimmed = value.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        return Some(ThemeName::Codelia);
    }
    THEME_OPTIONS.iter().find_map(|option| {
        (trimmed == option.name.as_str()
            || option.name.aliases().iter().any(|alias| *alias == trimmed))
        .then_some(option.name)
    })
}
