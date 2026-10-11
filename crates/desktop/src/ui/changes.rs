use crate::{app::Desktop, application::Command};
use gpui_kit::component::{ActiveTheme, Disableable, Sizable, button::*, text::TextView};
use gpui_kit::*;
impl Desktop {
    pub(crate) fn render_changes(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let muted = cx.theme().muted_foreground;
        let border = cx.theme().border;
        let ws = self.ws();
        let git_loading = ws.git_loading;
        let git_error = ws.git.error.clone();
        let branch = ws.git.branch.clone();
        let git_status = ws.git.status.clone();
        let diff = ws.git.diff.clone();
        let worktrees = ws.git.worktrees.clone();
        let mut changes = div()
            .w(px(340.))
            .flex_shrink_0()
            .h_full()
            .border_l_1()
            .border_color(border)
            .p_3()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child("Changes")
                    .child(
                        div()
                            .flex()
                            .gap_1()
                            .child(
                                Button::new("refresh-git")
                                    .ghost()
                                    .small()
                                    .label("Refresh")
                                    .disabled(git_loading)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.ws().refresh_git();
                                        cx.notify();
                                    })),
                            )
                            .child(
                                Button::new("close-changes")
                                    .ghost()
                                    .small()
                                    .icon(gpui_kit::assets::IconName::X)
                                    .accessibility_label("Close changes")
                                    .tooltip("Close changes")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        let _ = this.ws().command(Command::CloseInspector);
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(muted)
                    .child(if branch.is_empty() {
                        "Read-only changes".into()
                    } else {
                        format!("{branch} · tracked diff and untracked files")
                    }),
            );
        if let Some(error) = git_error {
            return changes
                .child(
                    div()
                        .id("git-error")
                        .role(Role::Alert)
                        .aria_label(error.clone())
                        .text_color(muted)
                        .child(error)
                        .test_support(),
                )
                .into_any_element();
        }
        if git_loading && git_status.is_empty() && diff.is_empty() {
            return changes.child("Reading changes…").into_any_element();
        }
        let git_view = div()
            .id("git-view")
            .overflow_y_scroll()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .gap_2()
            .child(TextView::markdown(
                "git-status",
                format!(
                    "```\n{}\n```",
                    if git_status.is_empty() {
                        "Working tree clean".into()
                    } else {
                        git_status
                    }
                ),
            ))
            .child(
                TextView::markdown(
                    "git-diff",
                    format!(
                        "```diff\n{}\n```",
                        if diff.is_empty() {
                            "No tracked changes".into()
                        } else {
                            diff
                        }
                    ),
                )
                .selectable(true),
            );
        changes = changes
            .child(git_view.test_support())
            .child(div().text_xs().text_color(muted).child("WORKTREES"));
        let mut tree = div()
            .id("worktrees")
            .max_h(px(150.))
            .overflow_y_scroll()
            .flex()
            .flex_col();
        for (index, path) in worktrees.iter().enumerate() {
            let path = path.clone();
            let label = format!(
                "{} / {}",
                path.parent()
                    .and_then(|p| p.file_name())
                    .unwrap_or_default()
                    .to_string_lossy(),
                path.file_name().unwrap_or_default().to_string_lossy()
            );
            tree = tree.child(
                Button::new(("worktree", index))
                    .ghost()
                    .small()
                    .label(format!("Open {label}"))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_workspace(path.clone(), window, cx)
                    })),
            );
        }
        changes.child(tree).into_any_element()
    }
}
