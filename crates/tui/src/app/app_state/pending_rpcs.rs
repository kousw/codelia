use super::ShellRuleRpc;
use crate::app::state::upload::PendingUpload;
use crate::app::state::{ModelListMode, ModelSetScope, SkillsScopeFilter};
use std::collections::{HashMap, HashSet};

#[derive(Debug)]
pub(crate) enum PendingRpc {
    Initialize,
    AutoReview,
    ShellRules(ShellRuleRpc),
    ImageModelGet,
    ImageModelConfigure,
    ImageArtifact {
        artifact_id: String,
        preview_revision: u64,
    },
    SessionList {
        show_all: bool,
    },
    SessionHistory,
    SessionOpen,
    SessionUpdate,
    ModelList {
        mode: ModelListMode,
        scope: ModelSetScope,
    },
    ModelSet,
    McpList {
        detail_id: Option<String>,
    },
    LaneList,
    LaneStatus,
    LaneClose,
    LaneCreate,
    SkillsList {
        query: Option<String>,
        scope: Option<SkillsScopeFilter>,
    },
    ContextInspect,
    Logout,
    ShellExec,
    ShellStart,
    ShellWait,
    ShellDetach,
    TaskList,
    TaskStatus,
    TaskCancel,
    ThemeSet,
    RunStart,
    RunSteer {
        client_steer_id: String,
    },
    RunCancel,
    Upload(PendingUpload),
}

impl PendingRpc {
    pub fn slot(&self) -> Option<PendingRpcSlot> {
        match self {
            Self::Initialize => Some(PendingRpcSlot::Initialize),
            Self::AutoReview => Some(PendingRpcSlot::AutoReview),
            Self::ShellRules(_) => Some(PendingRpcSlot::ShellRules),
            Self::ImageModelGet => Some(PendingRpcSlot::ImageModelGet),
            Self::ImageModelConfigure => Some(PendingRpcSlot::ImageModelConfigure),
            Self::ImageArtifact { .. } => Some(PendingRpcSlot::ImageArtifact),
            Self::SessionList { .. } => Some(PendingRpcSlot::SessionList),
            Self::SessionHistory => Some(PendingRpcSlot::SessionHistory),
            Self::SessionOpen => Some(PendingRpcSlot::SessionOpen),
            Self::SessionUpdate => Some(PendingRpcSlot::SessionUpdate),
            Self::ModelList { .. } => Some(PendingRpcSlot::ModelList),
            Self::ModelSet => Some(PendingRpcSlot::ModelSet),
            Self::McpList { .. } => Some(PendingRpcSlot::McpList),
            Self::LaneList => Some(PendingRpcSlot::LaneList),
            Self::LaneStatus => Some(PendingRpcSlot::LaneStatus),
            Self::LaneClose => Some(PendingRpcSlot::LaneClose),
            Self::LaneCreate => Some(PendingRpcSlot::LaneCreate),
            Self::SkillsList { .. } => Some(PendingRpcSlot::SkillsList),
            Self::ContextInspect => Some(PendingRpcSlot::ContextInspect),
            Self::Logout => Some(PendingRpcSlot::Logout),
            Self::ShellExec => Some(PendingRpcSlot::ShellExec),
            Self::ShellStart => Some(PendingRpcSlot::ShellStart),
            Self::ShellWait => Some(PendingRpcSlot::ShellWait),
            Self::ShellDetach => Some(PendingRpcSlot::ShellDetach),
            Self::TaskList => Some(PendingRpcSlot::TaskList),
            Self::TaskStatus => Some(PendingRpcSlot::TaskStatus),
            Self::TaskCancel => Some(PendingRpcSlot::TaskCancel),
            Self::ThemeSet => Some(PendingRpcSlot::ThemeSet),
            Self::RunStart => Some(PendingRpcSlot::RunStart),
            Self::RunSteer { .. } => None,
            Self::RunCancel => Some(PendingRpcSlot::RunCancel),
            Self::Upload(_) => Some(PendingRpcSlot::Upload),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum PendingRpcSlot {
    Initialize,
    AutoReview,
    ShellRules,
    ImageModelGet,
    ImageModelConfigure,
    ImageArtifact,
    SessionList,
    SessionHistory,
    SessionOpen,
    SessionUpdate,
    ModelList,
    ModelSet,
    McpList,
    LaneList,
    LaneStatus,
    LaneClose,
    LaneCreate,
    SkillsList,
    ContextInspect,
    Logout,
    ShellExec,
    ShellStart,
    ShellWait,
    ShellDetach,
    TaskList,
    TaskStatus,
    TaskCancel,
    ThemeSet,
    RunStart,
    RunCancel,
    Upload,
}

impl PendingRpcSlot {
    pub fn blocks_auto_start(self) -> bool {
        match self {
            Self::Initialize | Self::RunStart | Self::RunCancel | Self::Upload => false,
            Self::AutoReview
            | Self::ShellRules
            | Self::ImageModelGet
            | Self::ImageModelConfigure
            | Self::ImageArtifact
            | Self::SessionList
            | Self::SessionHistory
            | Self::SessionOpen
            | Self::SessionUpdate
            | Self::ModelList
            | Self::ModelSet
            | Self::McpList
            | Self::LaneList
            | Self::LaneStatus
            | Self::LaneClose
            | Self::LaneCreate
            | Self::SkillsList
            | Self::ContextInspect
            | Self::Logout
            | Self::ShellExec
            | Self::ShellStart
            | Self::ShellWait
            | Self::ShellDetach
            | Self::TaskList
            | Self::TaskStatus
            | Self::TaskCancel
            | Self::ThemeSet => true,
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct PendingRpcs {
    by_id: HashMap<String, PendingRpc>,
    slot_ids: HashMap<PendingRpcSlot, String>,
    /// Active server-initiated `tui_ask_user_choice` request IDs.
    pub client_tool_choice_ids: HashSet<String>,
}

impl PendingRpcs {
    /// Registers a pending RPC under `id`.
    ///
    /// Singleton variants (those with `rpc.slot().is_some()`) evict and return any
    /// previous entry in the same slot (last-write-wins). Multi-in-flight variants
    /// (`RunSteer`) coexist across distinct IDs and return `None`. If `id` was
    /// already present under another entry, that stale entry is cleaned up first
    /// (without being returned as a same-slot eviction).
    pub fn insert(&mut self, id: String, rpc: PendingRpc) -> Option<(String, PendingRpc)> {
        if let Some(slot) = rpc.slot() {
            let evicted = self.remove_slot(slot);
            self.take(&id);
            self.slot_ids.insert(slot, id.clone());
            self.by_id.insert(id, rpc);
            evicted
        } else {
            self.take(&id);
            self.by_id.insert(id, rpc);
            None
        }
    }

    pub fn take(&mut self, response_id: &str) -> Option<PendingRpc> {
        let rpc = self.by_id.remove(response_id)?;
        if let Some(slot) = rpc.slot() {
            self.slot_ids.remove(&slot);
        }
        Some(rpc)
    }

    pub fn remove_slot(&mut self, slot: PendingRpcSlot) -> Option<(String, PendingRpc)> {
        let id = self.slot_ids.remove(&slot)?;
        let rpc = self.by_id.remove(&id)?;
        Some((id, rpc))
    }

    pub fn has_slot(&self, slot: PendingRpcSlot) -> bool {
        self.slot_ids.contains_key(&slot)
    }

    pub fn slot_id(&self, slot: PendingRpcSlot) -> Option<&str> {
        self.slot_ids.get(&slot).map(String::as_str)
    }

    pub fn slot_entry(&self, slot: PendingRpcSlot) -> Option<(&str, &PendingRpc)> {
        let id = self.slot_id(slot)?;
        Some((id, self.by_id.get(id)?))
    }

    pub fn upload(&self) -> Option<&PendingUpload> {
        match self.slot_entry(PendingRpcSlot::Upload) {
            Some((_, PendingRpc::Upload(upload))) => Some(upload),
            _ => None,
        }
    }

    pub fn take_upload(&mut self) -> Option<PendingUpload> {
        match self.remove_slot(PendingRpcSlot::Upload) {
            Some((_, PendingRpc::Upload(upload))) => Some(upload),
            _ => None,
        }
    }

    pub fn set_upload(&mut self, upload: PendingUpload) {
        self.insert(upload.request_id().to_owned(), PendingRpc::Upload(upload));
    }

    pub fn has_run_steers(&self) -> bool {
        self.by_id
            .values()
            .any(|rpc| matches!(rpc, PendingRpc::RunSteer { .. }))
    }

    #[cfg(test)]
    pub fn clear_run_steers(&mut self) {
        self.by_id.retain(|_, rpc| rpc.slot().is_some());
    }

    pub fn has_auto_start_blockers(&self) -> bool {
        self.slot_ids.keys().any(|slot| slot.blocks_auto_start())
    }

    pub fn has_shell_rule_run(&self) -> bool {
        matches!(
            self.slot_entry(PendingRpcSlot::ShellRules),
            Some((_, PendingRpc::ShellRules(ShellRuleRpc::Run { .. })))
        )
    }
}

#[cfg(test)]
mod tests {
    use super::super::ShellRuleScope;
    use super::*;

    #[test]
    fn singleton_replacement_evicts_stale_id_and_keeps_new_metadata() {
        let mut pending = PendingRpcs::default();
        pending.insert("old".into(), PendingRpc::SessionList { show_all: true });

        let evicted = pending.insert("new".into(), PendingRpc::SessionList { show_all: false });

        assert!(
            matches!(evicted, Some((id, PendingRpc::SessionList { show_all: true })) if id == "old")
        );
        assert!(pending.take("old").is_none());
        assert_eq!(pending.slot_id(PendingRpcSlot::SessionList), Some("new"));
        assert!(matches!(
            pending.take("new"),
            Some(PendingRpc::SessionList { show_all: false })
        ));
        assert!(pending.by_id.is_empty());
        assert!(pending.slot_ids.is_empty());
    }

    #[test]
    fn reused_request_id_releases_its_previous_slot() {
        let mut pending = PendingRpcs::default();
        pending.insert("same".into(), PendingRpc::SessionList { show_all: true });
        pending.insert(
            "old-model".into(),
            PendingRpc::ModelList {
                mode: ModelListMode::Picker,
                scope: ModelSetScope::Config,
            },
        );
        let evicted = pending.insert(
            "same".into(),
            PendingRpc::ModelList {
                mode: ModelListMode::List,
                scope: ModelSetScope::Session,
            },
        );

        assert!(matches!(evicted, Some((id, PendingRpc::ModelList { .. })) if id == "old-model"));
        assert!(!pending.has_slot(PendingRpcSlot::SessionList));
        assert!(pending.take("old-model").is_none());
        assert!(matches!(
            pending.take("same"),
            Some(PendingRpc::ModelList {
                mode: ModelListMode::List,
                scope: ModelSetScope::Session,
            })
        ));
        assert!(pending.by_id.is_empty());
        assert!(pending.slot_ids.is_empty());

        pending.insert("same".into(), PendingRpc::SessionOpen);
        pending.insert(
            "same".into(),
            PendingRpc::RunSteer {
                client_steer_id: "steer".into(),
            },
        );
        assert!(!pending.has_slot(PendingRpcSlot::SessionOpen));
        assert!(pending.has_run_steers());
        pending.insert("same".into(), PendingRpc::SessionOpen);
        assert!(!pending.has_run_steers());
        assert!(pending.has_slot(PendingRpcSlot::SessionOpen));
    }

    #[test]
    fn session_open_blocks_auto_start_until_answered() {
        let mut pending = PendingRpcs::default();
        pending.insert("open".into(), PendingRpc::SessionOpen);

        assert!(pending.has_auto_start_blockers());
        assert!(matches!(
            pending.take("open"),
            Some(PendingRpc::SessionOpen)
        ));
        assert!(!pending.has_slot(PendingRpcSlot::SessionOpen));
        assert!(!pending.has_auto_start_blockers());
    }

    #[test]
    fn image_artifact_has_one_slot() {
        let mut pending = PendingRpcs::default();
        for (id, preview_revision) in [("first", 1), ("second", 2)] {
            pending.insert(
                id.into(),
                PendingRpc::ImageArtifact {
                    artifact_id: id.into(),
                    preview_revision,
                },
            );
        }
        assert!(pending.take("first").is_none());
        assert!(matches!(
            pending.remove_slot(PendingRpcSlot::ImageArtifact),
            Some((id, PendingRpc::ImageArtifact { artifact_id, preview_revision: 2 }))
                if id == "second" && artifact_id == "second"
        ));
        assert!(pending.take("second").is_none());
        assert!(!pending.has_slot(PendingRpcSlot::ImageArtifact));
    }

    #[test]
    fn steers_match_independently_and_clear_without_affecting_singletons() {
        let mut pending = PendingRpcs::default();
        pending.insert("run".into(), PendingRpc::RunStart);
        assert!(!pending.has_run_steers());
        for (request, client) in [("one", "client1"), ("two", "client2"), ("three", "client3")] {
            pending.insert(
                request.into(),
                PendingRpc::RunSteer {
                    client_steer_id: client.into(),
                },
            );
        }
        assert!(pending.has_run_steers());
        assert!(!pending.has_auto_start_blockers());
        for (request, client) in [("two", "client2"), ("one", "client1")] {
            assert!(
                matches!(pending.take(request), Some(PendingRpc::RunSteer { client_steer_id }) if client_steer_id == client)
            );
            assert!(pending.take(request).is_none());
            assert!(pending.has_run_steers());
        }
        pending.clear_run_steers();
        assert!(!pending.has_run_steers());
        assert!(pending.take("three").is_none());
        assert!(matches!(pending.take("run"), Some(PendingRpc::RunStart)));
    }

    #[test]
    fn auto_start_blocker_policy_covers_every_slot() {
        use PendingRpcSlot::*;

        for (slot, expected) in [
            (Initialize, false),
            (AutoReview, true),
            (ShellRules, true),
            (ImageModelGet, true),
            (ImageModelConfigure, true),
            (ImageArtifact, true),
            (SessionList, true),
            (SessionHistory, true),
            (SessionOpen, true),
            (SessionUpdate, true),
            (ModelList, true),
            (ModelSet, true),
            (McpList, true),
            (LaneList, true),
            (LaneStatus, true),
            (LaneClose, true),
            (LaneCreate, true),
            (SkillsList, true),
            (ContextInspect, true),
            (Logout, true),
            (ShellExec, true),
            (ShellStart, true),
            (ShellWait, true),
            (ShellDetach, true),
            (TaskList, true),
            (TaskStatus, true),
            (TaskCancel, true),
            (ThemeSet, true),
            (RunStart, false),
            (RunCancel, false),
            (Upload, false),
        ] {
            assert_eq!(slot.blocks_auto_start(), expected, "{slot:?}");
        }
    }

    #[test]
    fn only_shell_rule_run_counts_as_a_pending_shell_rule_run() {
        let mut pending = PendingRpcs::default();
        assert!(!pending.has_shell_rule_run());
        pending.insert(
            "rule".into(),
            PendingRpc::ShellRules(ShellRuleRpc::Run { session_id: None }),
        );
        assert!(pending.has_shell_rule_run());

        for action in [
            ShellRuleRpc::InspectTrust {
                trusted: false,
                session_id: None,
            },
            ShellRuleRpc::SetTrust {
                trusted: true,
                workspace: "workspace".into(),
                session_id: None,
            },
            ShellRuleRpc::List {
                choose_removal: false,
                session_id: None,
            },
            ShellRuleRpc::Remove {
                rule_id: "rule".into(),
                scope: ShellRuleScope::Session,
            },
            ShellRuleRpc::RemoveTool {
                tool: "shell".into(),
            },
        ] {
            pending.insert("rule".into(), PendingRpc::ShellRules(action));
            assert!(!pending.has_shell_rule_run());
        }
    }
}
