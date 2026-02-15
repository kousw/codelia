#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillsScopeFilter {
    All,
    Repo,
    User,
}

impl SkillsScopeFilter {
    pub fn cycle(self) -> Self {
        match self {
            SkillsScopeFilter::All => SkillsScopeFilter::Repo,
            SkillsScopeFilter::Repo => SkillsScopeFilter::User,
            SkillsScopeFilter::User => SkillsScopeFilter::All,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            SkillsScopeFilter::All => "all",
            SkillsScopeFilter::Repo => "repo",
            SkillsScopeFilter::User => "user",
        }
    }

    pub fn matches(self, scope: &str) -> bool {
        match self {
            SkillsScopeFilter::All => true,
            SkillsScopeFilter::Repo => scope == "repo",
            SkillsScopeFilter::User => scope == "user",
        }
    }
}

#[derive(Clone)]
pub struct SkillsListItemState {
    pub name: String,
    pub description: String,
    pub path: String,
    pub scope: String,
    pub enabled: bool,
}

pub struct SkillsListPanelState {
    pub title: String,
    pub header: String,
    pub rows: Vec<String>,
    pub filtered_indices: Vec<usize>,
    pub items: Vec<SkillsListItemState>,
    pub selected: usize,
    pub search_query: String,
    pub scope_filter: SkillsScopeFilter,
}

impl SkillsListPanelState {
    pub fn rebuild(&mut self) {
        let query = self.search_query.trim().to_lowercase();
        self.filtered_indices = self
            .items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                if !self.scope_filter.matches(&item.scope) {
                    return None;
                }
                if query.is_empty() {
                    return Some(index);
                }
                let haystack = format!(
                    "{} {} {}",
                    item.name.to_lowercase(),
                    item.description.to_lowercase(),
                    item.path.to_lowercase()
                );
                haystack.contains(&query).then_some(index)
            })
            .collect();

        if self.filtered_indices.is_empty() {
            self.selected = 0;
            self.rows = vec!["(no skills matched)".to_string()];
        } else {
            self.selected = self
                .selected
                .min(self.filtered_indices.len().saturating_sub(1));
            self.rows = self
                .filtered_indices
                .iter()
                .map(|index| {
                    let item = &self.items[*index];
                    let marker = if item.enabled { "*" } else { "x" };
                    format!(
                        "{marker} [{:<4}] {:<24} {}",
                        item.scope, item.name, item.description
                    )
                })
                .collect();
        }

        let enabled_count = self.items.iter().filter(|item| item.enabled).count();
        self.header = format!(
            "scope={} query=\"{}\" enabled={}/{} | Enter:insert  Space/E:toggle  Tab:scope  type:search",
            self.scope_filter.label(),
            self.search_query,
            enabled_count,
            self.items.len()
        );
    }

    pub fn selected_item_index(&self) -> Option<usize> {
        self.filtered_indices.get(self.selected).copied()
    }
}
