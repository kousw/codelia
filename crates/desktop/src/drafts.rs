//! Current unsent composer data only; no I/O, transcript, prompt answers or diagnostics.
use crate::state::{Conversation, State};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const DRAFT_BYTES: usize = 256 * 1024;
pub const TOTAL_BYTES: usize = 4 * 1024 * 1024;
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DraftText {
    pub text: String,
    pub title: String,
}
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DraftSnapshot {
    pub selected: String,
    pub drafts: BTreeMap<String, DraftText>,
}
impl DraftSnapshot {
    pub fn fits(state: &State, skip: Option<&str>) -> bool {
        let drafts: Vec<_> = state
            .conversations
            .iter()
            .filter(|(key, c)| !c.draft.is_empty() && skip != Some(key.as_str()))
            .collect();
        state.key().len() <= 256
            && drafts.len() <= 64
            && drafts.iter().all(|(id, c)| {
                id.len() <= 256 && c.draft.len() <= DRAFT_BYTES && c.title.len() <= 512
            })
            && drafts
                .iter()
                .map(|(_, c)| c.draft.len() + c.title.len())
                .sum::<usize>()
                <= TOTAL_BYTES
    }
    pub fn matches(&self, state: &State) -> bool {
        self.selected == state.key()
            && self.drafts.len()
                == state
                    .conversations
                    .values()
                    .filter(|c| !c.draft.is_empty())
                    .count()
            && self.drafts.iter().all(|(id, d)| {
                state
                    .conversations
                    .get(id)
                    .is_some_and(|c| c.draft == d.text && c.title == d.title)
            })
    }
    pub fn capture(state: &State) -> Self {
        Self {
            selected: state.key(),
            drafts: state
                .conversations
                .iter()
                .filter(|(_, c)| !c.draft.is_empty())
                .map(|(key, c)| {
                    (
                        key.clone(),
                        DraftText {
                            text: c.draft.clone(),
                            title: c.title.clone(),
                        },
                    )
                })
                .collect(),
        }
    }
    pub fn validate(&self) -> bool {
        self.selected.len() <= 256
            && self.drafts.len() <= 64
            && self.drafts.iter().all(|(id, d)| {
                !id.is_empty()
                    && id.len() <= 256
                    && d.text.len() <= DRAFT_BYTES
                    && d.title.len() <= 512
                    && !d.text.is_empty()
            })
            && self
                .drafts
                .values()
                .map(|d| d.text.len() + d.title.len())
                .sum::<usize>()
                <= TOTAL_BYTES
    }
    pub fn restore(self, state: &mut State) -> bool {
        // Startup text typed while disk load is in flight always stays in its unique local thread.
        let local = Self::capture(state);
        let keep_selection = !local.drafts.is_empty() || state.busy || state.loading;
        for (key, draft) in self.drafts {
            state.conversations.entry(key.clone()).or_insert_with(|| {
                let mut conversation = Conversation::default();
                conversation.draft = draft.text;
                conversation.title = draft.title;
                conversation.transcript_evicted = !key.starts_with("draft-");
                conversation
            });
        }
        if !keep_selection && state.conversations.contains_key(&self.selected) {
            if self.selected.starts_with("draft-") {
                state.draft_key = self.selected;
                state.session = None;
            } else {
                state.session = Some(self.selected);
            }
            true
        } else {
            false
        }
    }
}
