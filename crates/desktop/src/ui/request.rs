use crate::app::Desktop;
use crate::application::Command;
use gpui_kit::component::{
    ActiveTheme, Sizable,
    button::*,
    input::{Input, Textarea},
    text::TextView,
};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use serde_json::json;
impl Desktop {
    pub(crate) fn render_request(
        &mut self,
        request: crate::state::Request,
        root: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let params = &request.params;
        let title = params["title"]
            .as_str()
            .unwrap_or("Codelia needs your input")
            .to_owned();
        let raw_message = params["message"].as_str().unwrap_or("");
        // Permission operation text remains verbatim, including runtime previews.
        // The response is explicitly once; runtime optional remember prose is not
        // an action exposed by this client.
        let message = raw_message.to_owned();
        let task = params["task_id"].as_str().and_then(|id| {
            self.ws()
                .state
                .tasks
                .iter()
                .find(|task| task["task_id"].as_str() == Some(id))
                .cloned()
        });
        let owner = task
            .as_ref()
            .and_then(|task| task["subagent"]["owner_session_id"].as_str())
            .map(str::to_owned)
            .or_else(|| self.ws().state.run_owner.clone());
        let parent = owner
            .as_ref()
            .and_then(|id| {
                self.ws()
                    .state
                    .conversations
                    .get(id)
                    .map(|conversation| conversation.title.clone())
            })
            .unwrap_or_else(|| "Parent session".into());
        let origin = if params["worktree"].is_object() {
            format!(
                "{} worktree request · thread: {}",
                if params["worktree"]["actor"] == "parent_agent" {
                    "Agent"
                } else {
                    "User"
                },
                params["worktree"]["thread_id"]
                    .as_str()
                    .unwrap_or("unknown")
            )
        } else if params["task_id"].is_string() {
            format!("Child request · parent: {parent}")
        } else {
            format!("Parent request · {parent}")
        };
        let mut panel = div()
            .mx_3()
            .mb_2()
            .p_3()
            .flex_shrink_0()
            .rounded_md()
            .border_1()
            .border_color(cx.theme().warning.opacity(0.6))
            .bg(cx.theme().warning.opacity(0.025))
            .flex()
            .flex_col()
            .gap_2()
            .child(div().font_weight(FontWeight::SEMIBOLD).child(title))
            .child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .text_ellipsis()
                    .child(origin),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .text_ellipsis()
                    .child(format!("Workspace: {root}")),
            )
            .child(
                div()
                    .id("approval-description")
                    .max_h(px(
                        (f32::from(window.viewport_size().height) * 0.22).clamp(64., 140.)
                    ))
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(if params["worktree"].is_object() {
                        // Literal text preserves paths/branches containing Markdown characters.
                        div().text_sm().child(message).into_any_element()
                    } else {
                        TextView::markdown("approval-message", message)
                            .selectable(true)
                            .into_any_element()
                    }),
            );
        if request.method == "ui.confirm.request" {
            if let Some(task_id) = params["task_id"].as_str() {
                let task_id = task_id.to_owned();
                let name = self
                    .ws()
                    .state
                    .tasks
                    .iter()
                    .find(|task| task["task_id"].as_str() == Some(&task_id))
                    .and_then(|task| task["name"].as_str())
                    .unwrap_or("child task")
                    .to_owned();
                panel = panel.child(
                    Button::new("approval-child")
                        .ghost()
                        .small()
                        .label(format!("Child approval · inspect {name}"))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Err(error) =
                                this.ws().command(Command::TaskStatus(task_id.clone()))
                            {
                                this.ws().state.error = Some(error);
                            }
                            cx.notify();
                        })),
                );
            }
            panel = panel.child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child("Allow once applies to this operation only. No permission rule will be saved."),
            );
            panel = panel.child(
                div()
                    .flex()
                    .justify_end()
                    .gap_2()
                    .child(
                        Button::new("reject")
                            .small()
                            .label(
                                params["cancel_label"]
                                    .as_str()
                                    .unwrap_or("Reject")
                                    .to_owned(),
                            )
                            .on_click(
                                cx.listener(|this, _, _, cx| this.reply(json!({"ok":false}), cx)),
                            ),
                    )
                    .child(
                        Button::new("approve")
                            .primary()
                            .small()
                            .label(format!(
                                "{} once",
                                params["confirm_label"].as_str().unwrap_or("Allow")
                            ))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.reply(json!({"ok":true,"remember":false}), cx)
                            })),
                    ),
            );
        } else if request.method == "ui.prompt.request" {
            let multiline = params["multiline"] == true && params["secret"] != true;
            if multiline {
                panel = panel.child(Textarea::new(&self.answer_multiline).h(px(100.)));
            } else {
                panel = panel.child(Input::new(&self.answer).aria_label("Runtime answer"));
            }
            panel = panel.child(
                div()
                    .flex()
                    .gap_2()
                    .child(Button::new("prompt-cancel").label("Cancel").on_click(
                        cx.listener(|this, _, _, cx| this.reply(json!({"value":null}), cx)),
                    ))
                    .child(
                        Button::new("prompt-submit")
                            .primary()
                            .label("Submit")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                let text = if multiline {
                                    this.answer_multiline.read(cx).value().to_string()
                                } else {
                                    this.answer.read(cx).value().to_string()
                                };
                                this.reply(json!({"value":text}), cx);
                            })),
                    ),
            );
        } else if request.method == "ui.pick.request" {
            let multi = params["multi"] == true;
            let mut items = div()
                .id("pick-items")
                .max_h(px(160.))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap_1();
            for (index, item) in params["items"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .enumerate()
            {
                let id = item["id"].as_str().unwrap_or("").to_owned();
                let label = item["label"].as_str().unwrap_or(&id);
                let detail = item["detail"].as_str().unwrap_or("");
                let chosen = request.selected.contains(&id);
                items = items.child(
                    Button::new(("pick", index))
                        .ghost()
                        .label(format!(
                            "{} {label} {detail}",
                            if chosen { "☑" } else { "☐" }
                        ))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if multi {
                                if let Some(request) = &mut this.ws().state.request
                                    && !request.selected.remove(&id)
                                {
                                    request.selected.insert(id.clone());
                                }
                                cx.notify();
                            } else {
                                this.reply(json!({"ids":[id]}), cx);
                            }
                        })),
                );
            }
            panel =
                panel.child(items).child(
                    div()
                        .flex()
                        .gap_2()
                        .child(Button::new("pick-cancel").label("Cancel").on_click(
                            cx.listener(|this, _, _, cx| this.reply(json!({"ids":[]}), cx)),
                        ))
                        .when(multi, |row| {
                            row.child(
                                Button::new("pick-submit")
                                    .primary()
                                    .label("Confirm selection")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        let ids = this
                                            .ws()
                                            .state
                                            .request
                                            .as_ref()
                                            .map(|r| r.selected.iter().cloned().collect::<Vec<_>>())
                                            .unwrap_or_default();
                                        this.reply(json!({"ids":ids}), cx);
                                    })),
                            )
                        }),
                );
        }
        panel.into_any_element()
    }
}
