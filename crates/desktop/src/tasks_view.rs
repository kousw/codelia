use crate::{app::Desktop, application::Command};
use gpui_kit::component::{ActiveTheme, Disableable, Sizable, button::*, text::TextView};
use gpui_kit::*;

impl Desktop {
    pub(crate) fn render_tasks(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let detail = self.ws().state.task_detail.clone();
        let mut panel = div()
            .w(px(340.))
            .h_full()
            .flex_shrink_0()
            .border_l_1()
            .border_color(cx.theme().border)
            .p_3()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child("Agent result")
                    .child(
                        Button::new("close-agent")
                            .ghost()
                            .small()
                            .label("Close")
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Err(error) = this.ws().command(Command::CloseInspector) {
                                    this.ws().state.error = Some(error);
                                }
                                cx.notify();
                            })),
                    ),
            );
        let Some(detail) = detail else {
            return panel.child("Loading task…").into_any_element();
        };
        let id = detail["task_id"].as_str().unwrap_or("").to_owned();
        let refresh_id = id.clone();
        let state = detail["state"].as_str().unwrap_or("unknown");
        let running = state == "running" || state == "queued";
        let name = detail["name"]
            .as_str()
            .or(detail["title"].as_str())
            .unwrap_or(&id);
        let parent = detail["subagent"]["owner_session_id"]
            .as_str()
            .unwrap_or("");
        let parent_title = self
            .ws()
            .state
            .conversations
            .get(parent)
            .map(|c| c.title.clone())
            .unwrap_or_else(|| "Parent session".into());
        let body = detail["summary"]
            .as_str()
            .or(detail["failure_message"].as_str())
            .or(detail["stdout"].as_str())
            .unwrap_or("Result not available yet")
            .to_owned();
        panel = panel
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(name.to_owned()),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(format!("{state} · {parent_title}")),
            )
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        Button::new("refresh-agent")
                            .ghost()
                            .small()
                            .label("Refresh")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if let Err(error) =
                                    this.ws().command(Command::TaskStatus(refresh_id.clone()))
                                {
                                    this.ws().state.error = Some(error);
                                }
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("stop-child")
                            .small()
                            .label("Cancel this child")
                            .disabled(!running)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if let Err(error) =
                                    this.ws().command(Command::CancelTask(id.clone()))
                                {
                                    this.ws().state.error = Some(error);
                                }
                                cx.notify();
                            })),
                    ),
            )
            .child(
                div()
                    .id("agent-result")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(TextView::markdown("task-result", body).selectable(true)),
            );
        panel.into_any_element()
    }
}
