pub(crate) mod command;
pub(crate) use command::{handle_queue_steer_picker_key, open_queue_steer_picker};
pub(crate) mod confirm;
pub(crate) mod image_preview;
pub(crate) mod panels;
pub(crate) mod runtime_response;
pub(crate) mod shell_rules;
pub(crate) mod theme;

use crate::app::runtime::RuntimeTx;
use crate::app::state::InputState;
use crate::app::{AppState, SkillsListItemState};

pub(crate) fn complete_slash_command(input: &mut InputState) -> bool {
    command::complete_slash_command(input)
}

pub(crate) fn complete_skill_mention(
    input: &mut InputState,
    skills: &[SkillsListItemState],
) -> bool {
    command::complete_skill_mention(input, skills)
}

pub(crate) fn handle_enter(app: &mut AppState, tx: &mut dyn RuntimeTx) -> bool {
    command::handle_enter(app, tx)
}

pub(crate) fn can_dispatch_prompt_now(app: &AppState) -> bool {
    command::can_dispatch_prompt_now(app)
}
