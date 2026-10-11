use crate::app::Desktop;
use crate::state::Row;
use gpui_kit::component::{
    ActiveTheme, Sizable,
    button::*,
    text::{TextView, TextViewStyle},
};
use gpui_kit::*;
impl Desktop {
    pub(crate) fn row(&mut self, row: Row, cx: &mut Context<Self>) -> AnyElement {
        let muted = cx.theme().muted_foreground;
        let user = row.kind == "user";
        let text_style = TextViewStyle::default().paragraph_gap(rems(0.5));
        let fold = row.kind == "tool" || row.kind == "reasoning";
        let open =
            self.expanded.contains(&row.id) || (row.error && !self.collapsed.contains(&row.id));
        let id = row.id.clone();
        let body = row.body.clone();
        let detail = row.detail.clone();
        let copy = if detail.is_empty() {
            body.clone()
        } else {
            format!("{detail}\n{body}")
        };
        let title = if fold {
            format!("{}  {}", if open { "▾" } else { "▸" }, row.title)
        } else {
            row.title
        };
        let mut card = div()
            .id(SharedString::from(row.id.clone()))
            .group("message-row")
            .mx_3()
            .px_2()
            .py_1()
            .rounded_md()
            .bg(if user {
                rgb(0xf4f4f5).into()
            } else {
                transparent_black()
            })
            .flex()
            .flex_col()
            .gap_1();
        let label = if fold {
            Button::new(SharedString::from(format!("title-{id}")))
                .ghost()
                .small()
                .justify_start()
                .label(title)
                .on_click(cx.listener(move |this, _, _, cx| {
                    if open {
                        this.expanded.remove(&id);
                        this.collapsed.insert(id.clone());
                    } else {
                        this.expanded.insert(id.clone());
                        this.collapsed.remove(&id);
                    }
                    let key = (this.selected, this.ws().state.key());
                    let count = this.ws().state.rows().len();
                    if let Some(scroll) = this.scrolls.get(&key) {
                        scroll.update(cx, |state, cx| state.remeasure_items(0..count, cx));
                    }
                    cx.notify();
                }))
                .into_any_element()
        } else {
            div()
                .text_color(muted)
                .font_weight(FontWeight::MEDIUM)
                .child(title)
                .into_any_element()
        };
        card = card.child(
            div()
                .flex()
                .justify_between()
                .items_center()
                .child(label)
                .child(
                    Button::new(SharedString::from(format!("copy-{}", row.id)))
                        .ghost()
                        .small()
                        .invisible()
                        .group_hover("message-row", |button| button.visible())
                        .label("Copy")
                        .on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()))
                        }),
                ),
        );
        if !fold || open {
            if !detail.is_empty() {
                card = card.child(
                    TextView::markdown(
                        SharedString::from(format!("detail-{}", row.id)),
                        format!("```\n{detail}\n```"),
                    )
                    .style(text_style.clone()),
                );
            }
            if !body.is_empty() {
                card = card.child(
                    TextView::markdown(SharedString::from(format!("body-{}", row.id)), body)
                        .style(text_style)
                        .selectable(true),
                );
            }
        }
        card.text_color(if row.error {
            cx.theme().danger
        } else if fold {
            muted
        } else {
            cx.theme().foreground
        })
        .into_any_element()
    }
}
