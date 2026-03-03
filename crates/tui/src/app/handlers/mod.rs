pub(crate) mod command;
pub(crate) mod confirm;
pub(crate) mod panels;
pub(crate) mod runtime_response;
pub(crate) mod theme;

use crate::app::state::InputState;
use crate::app::{AppState, SkillsListItemState};
use std::io::BufWriter;
use std::process::ChildStdin;

type RuntimeStdin = BufWriter<ChildStdin>;

pub(crate) fn complete_slash_command(input: &mut InputState) -> bool {
    command::complete_slash_command(input)
}

pub(crate) fn complete_skill_mention(
    input: &mut InputState,
    skills: &[SkillsListItemState],
) -> bool {
    command::complete_skill_mention(input, skills)
}

pub(crate) fn handle_enter(
    app: &mut AppState,
    child_stdin: &mut RuntimeStdin,
    next_id: &mut impl FnMut() -> String,
) -> bool {
    command::handle_enter(app, child_stdin, next_id)
}

pub(crate) fn can_dispatch_prompt_now(app: &AppState) -> bool {
    command::can_dispatch_prompt_now(app)
}
