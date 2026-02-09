# Widgets Reference

## Table of Contents

- [Widget Traits](#widget-traits)
- [Built-in Widgets](#built-in-widgets)
- [Styling](#styling)
- [Custom Widgets](#custom-widgets)
- [Third-Party Widget Crates](#third-party-widget-crates)

## Widget Traits

### Widget

The core rendering trait. Consumes `self` on render:

```rust
pub trait Widget {
    fn render(self, area: Rect, buf: &mut Buffer);
}
```

Render via `frame.render_widget(widget, area)` or call `widget.render(area, buf)` directly in custom widget code.

### StatefulWidget

For widgets that need mutable external state during rendering:

```rust
pub trait StatefulWidget {
    type State: ?Sized;  // ?Sized as of v0.30
    fn render(self, area: Rect, buf: &mut Buffer, state: &mut Self::State);
}
```

Render via `frame.render_stateful_widget(widget, area, &mut state)`.

### Widget for &T (non-consuming render)

In v0.30, implement `Widget for &MyType` instead of the deprecated `WidgetRef` approach:

```rust
impl Widget for &MyWidget {
    fn render(self, area: Rect, buf: &mut Buffer) {
        // render without consuming self
    }
}
```

This enables rendering a widget multiple times or storing it across frames. Use `frame.render_widget(&my_widget, area)`.

## Built-in Widgets

### Block

Container with optional borders, titles, and padding. Used as wrapper for most other widgets.

```rust
// Simple bordered block
Block::bordered().title("Header")

// Full customization
Block::default()
    .borders(Borders::ALL)
    .border_type(BorderType::Rounded)
    .border_style(Style::new().cyan())
    .title("Title")              // accepts Into<Line>
    .title_bottom("Footer")
    .padding(Padding::horizontal(1))
```

Border types: `Plain`, `Rounded`, `Double`, `Thick`, `QuadrantInside`, `QuadrantOutside`.

In v0.30, `Block::title()` accepts `Into<Line>` (the `Title` struct was removed). Borders can auto-merge when overlapping via `MergeStrategy`.

### Text Primitives

**Span** — styled text fragment:

```rust
Span::raw("plain text")
Span::styled("styled", Style::new().bold().red())
"shorthand".red().bold()  // via Stylize trait
```

**Line** — horizontal sequence of spans:

```rust
Line::from("simple text")
Line::from(vec![Span::raw("hello "), Span::styled("world", Style::new().bold())])
Line::from("centered").centered()
```

**Text** — vertical sequence of lines:

```rust
Text::from("single line")
Text::from(vec![Line::from("line 1"), Line::from("line 2")])
Text::from("line1\nline2\nline3")
```

`Text` supports `+=` for appending:

```rust
let mut text = Text::from("line 1");
text += Text::from("line 2");
```

### Paragraph

Multi-line text display with wrapping, alignment, and scrolling:

```rust
Paragraph::new("Hello, world!")
    .block(Block::bordered().title("Greeting"))
    .style(Style::new().white())
    .alignment(HorizontalAlignment::Center)  // renamed from Alignment in v0.30
    .wrap(Wrap { trim: true })
    .scroll((vertical_offset, 0))
```

Use `.centered()` shorthand for center-aligned paragraphs.

### List

Scrollable list with selection highlighting:

```rust
let items = vec!["Item 1", "Item 2", "Item 3"];
let list = List::new(items)
    .block(Block::bordered().title("List"))
    .highlight_style(Style::new().reversed())
    .highlight_symbol(Line::from(">> ").bold())  // accepts Into<Line> in v0.30
    .highlight_spacing(HighlightSpacing::Always);

let mut state = ListState::default().with_selected(Some(0));
frame.render_stateful_widget(list, area, &mut state);
```

Navigation: `state.select_next()`, `state.select_previous()`, `state.select_first()`, `state.select_last()`.

### Table

Grid with headers, rows, column widths, and selection:

```rust
let header = Row::new(vec!["Name", "Age", "City"])
    .style(Style::new().bold())
    .bottom_margin(1);

let rows = vec![
    Row::new(vec!["Alice", "30", "NYC"]),
    Row::new(vec!["Bob", "25", "LA"]),
];

let widths = [Constraint::Length(10), Constraint::Length(5), Constraint::Min(10)];

let table = Table::new(rows, widths)
    .header(header)
    .block(Block::bordered().title("Users"))
    .highlight_style(Style::new().reversed())
    .highlight_symbol(">> ");

let mut state = TableState::default().with_selected(Some(0));
frame.render_stateful_widget(table, area, &mut state);
```

### Tabs

Tab bar for switching views:

```rust
let tabs = Tabs::new(vec!["Tab 1", "Tab 2", "Tab 3"])
    .block(Block::bordered())
    .select(active_tab)
    .highlight_style(Style::new().bold().yellow())
    .divider("|");
frame.render_widget(tabs, area);
```

### Gauge

Progress bar with percentage or ratio:

```rust
// Percentage
Gauge::default()
    .block(Block::bordered().title("Progress"))
    .gauge_style(Style::new().cyan().on_black())
    .percent(75);

// Ratio (0.0..=1.0)
Gauge::default()
    .ratio(0.75)
    .label("75%");
```

### LineGauge

Compact single-line progress indicator:

```rust
LineGauge::default()
    .block(Block::bordered().title("Download"))
    .filled_style(Style::new().green())
    .unfilled_style(Style::new().dark_gray())
    .filled_symbol("█")    // v0.30+
    .unfilled_symbol("░")  // v0.30+
    .ratio(0.6);
```

### BarChart

Vertical or horizontal bar charts with optional grouping:

```rust
// Simple
BarChart::default()
    .block(Block::bordered().title("Stats"))
    .bar_width(5)
    .bar_gap(2)
    .data(&[("Mon", 10), ("Tue", 20), ("Wed", 15)]);

// Grouped (v0.30+ constructors)
BarChart::grouped(vec![
    BarGroup::with_label("Q1", vec![
        Bar::with_label("A", 10),
        Bar::with_label("B", 20),
    ]),
    BarGroup::with_label("Q2", vec![
        Bar::with_label("C", 30),
        Bar::with_label("D", 40),
    ]),
]);
```

### Chart

Line or scatter chart with multiple datasets:

```rust
let data = vec![(0.0, 1.0), (1.0, 3.0), (2.0, 2.0), (3.0, 5.0)];
let dataset = Dataset::default()
    .name("Series 1")
    .marker(Marker::Braille)
    .graph_type(GraphType::Line)
    .style(Style::new().cyan())
    .data(&data);

Chart::new(vec![dataset])
    .block(Block::bordered().title("Chart"))
    .x_axis(Axis::default().bounds([0.0, 3.0]).title("X"))
    .y_axis(Axis::default().bounds([0.0, 5.0]).title("Y"));
```

### Canvas

Freeform drawing with shapes and markers:

```rust
Canvas::default()
    .block(Block::bordered().title("Canvas"))
    .x_bounds([0.0, 100.0])
    .y_bounds([0.0, 100.0])
    .marker(Marker::Braille)  // also: Dot, Block, Bar, HalfBlock, Quadrant, Sextant, Octant
    .paint(|ctx| {
        ctx.draw(&canvas::Rectangle {
            x: 10.0, y: 10.0,
            width: 50.0, height: 30.0,
            color: Color::Yellow,
        });
        ctx.draw(&canvas::Line {
            x1: 0.0, y1: 0.0,
            x2: 100.0, y2: 100.0,
            color: Color::Red,
        });
    });
```

v0.30 added markers: `Marker::Quadrant` (2x2), `Marker::Sextant` (2x3), `Marker::Octant` (2x4, same resolution as Braille with denser pixels).

### Scrollbar

Visual scrollbar indicator, rendered over other content:

```rust
let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
    .begin_symbol(Some("↑"))
    .end_symbol(Some("↓"));

let mut scrollbar_state = ScrollbarState::new(total_items)
    .position(current_position);

frame.render_stateful_widget(scrollbar, area, &mut scrollbar_state);
```

### Sparkline

Inline mini chart:

```rust
Sparkline::default()
    .block(Block::bordered().title("Sparkline"))
    .data(&[1, 4, 2, 8, 5, 7, 3])
    .max(10)
    .style(Style::new().red());
```

### Clear

Clears the area — use before rendering popups/overlays:

```rust
frame.render_widget(Clear, popup_area);
```

## Styling

### Style struct

```rust
Style::default()
    .fg(Color::White)
    .bg(Color::Black)
    .add_modifier(Modifier::BOLD | Modifier::ITALIC)

// Constant-friendly (v0.30+):
const MY_STYLE: Style = Style::new().blue().on_black().bold();
```

### Colors

Named: `Color::Red`, `Color::Green`, `Color::Blue`, `Color::Cyan`, `Color::Yellow`, `Color::Magenta`, `Color::White`, `Color::Black`, `Color::Gray`, `Color::DarkGray`, `Color::LightRed`, etc.

Indexed: `Color::Indexed(n)` — 256-color palette.

RGB: `Color::Rgb(r, g, b)`.

Conversion from tuples (v0.30+): `Color::from((255, 0, 0))`, `Color::from([255, 0, 0])`.

### Stylize trait (shorthand)

```rust
"text".red().bold().on_black()
Span::raw("hello").italic().fg(Color::Cyan)
Block::bordered().blue().on_white()
```

## Custom Widgets

Implement `Widget` for stateless or `StatefulWidget` for stateful custom widgets.

```rust
struct MyWidget {
    label: String,
    color: Color,
}

impl Widget for MyWidget {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let text = Line::from(self.label).style(Style::default().fg(self.color));
        text.render(area, buf);
    }
}

// Render by reference (v0.30 pattern — replaces WidgetRef):
impl Widget for &MyWidget {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let text = Line::from(self.label.as_str()).style(Style::default().fg(self.color));
        text.render(area, buf);
    }
}
```

For stateful custom widgets:

```rust
struct MyList { items: Vec<String> }
struct MyListState { selected: usize }

impl StatefulWidget for MyList {
    type State = MyListState;
    fn render(self, area: Rect, buf: &mut Buffer, state: &mut Self::State) {
        // Render items, highlighting state.selected
    }
}
```

## Third-Party Widget Crates

Notable ecosystem crates:

- `tui-input` — text input field with cursor
- `tui-textarea` — multi-line text editor
- `tui-tree-widget` — tree view
- `tui-scrollview` — scrollable view container
- `throbber-widgets-tui` — loading spinners/throbbers
- `ratatui-image` — image rendering in terminal
- `tui-big-text` — large ASCII art text

For widget library authors: consider depending on `ratatui-core` instead of `ratatui` for better API stability and faster compilation.
