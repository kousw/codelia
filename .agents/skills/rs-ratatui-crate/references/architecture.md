# Architecture Patterns Reference

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [TEA (The Elm Architecture)](#tea-the-elm-architecture)
- [Component Architecture](#component-architecture)
- [Monolithic Architecture](#monolithic-architecture)
- [Terminal Setup and Teardown](#terminal-setup-and-teardown)
- [Event Handling](#event-handling)
- [Layout System](#layout-system)
- [Popup and Overlay Pattern](#popup-and-overlay-pattern)
- [State Management](#state-management)
- [Testing](#testing)

## Architecture Overview

Three main patterns for structuring Ratatui applications:

| Pattern | Complexity | Key Trait | Example Projects |
|---|---|---|---|
| TEA | Medium | Free functions (update/view) | ratatui examples |
| Component | High | `Component` trait with `Action` enum | openapi-tui, yozefu |
| Monolithic | Low | Single `App` struct | csvlens, binsider |

All patterns share the same core loop: **poll events -> update state -> render UI**.

## TEA (The Elm Architecture)

Separates concerns into Model (state), Message (events), Update (logic), and View (rendering).

### Full Pattern

```rust
use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use ratatui::{Frame, widgets::Paragraph};

// --- Model ---
struct Model {
    counter: i32,
    running: bool,
}

// --- Message ---
enum Message {
    Increment,
    Decrement,
    Reset,
    Quit,
}

// --- Update ---
fn update(model: &mut Model, msg: Message) {
    match msg {
        Message::Increment => model.counter += 1,
        Message::Decrement => model.counter = model.counter.saturating_sub(1),
        Message::Reset => model.counter = 0,
        Message::Quit => model.running = false,
    }
}

// --- View ---
fn view(model: &Model, frame: &mut Frame) {
    let text = format!("Counter: {} (q=quit, +/-=change, r=reset)", model.counter);
    frame.render_widget(
        Paragraph::new(text).block(Block::bordered().title("TEA Counter")),
        frame.area(),
    );
}

// --- Event -> Message mapping ---
fn handle_event(model: &Model) -> Option<Message> {
    if let Event::Key(key) = event::read().ok()? {
        if key.kind == KeyEventKind::Press {
            return match key.code {
                KeyCode::Char('q') => Some(Message::Quit),
                KeyCode::Char('+') => Some(Message::Increment),
                KeyCode::Char('-') => Some(Message::Decrement),
                KeyCode::Char('r') => Some(Message::Reset),
                _ => None,
            };
        }
    }
    None
}

// --- Main loop ---
fn main() -> Result<(), Box<dyn std::error::Error>> {
    ratatui::run(|terminal| {
        let mut model = Model { counter: 0, running: true };
        while model.running {
            terminal.draw(|frame| view(&model, frame))?;
            if let Some(msg) = handle_event(&model) {
                update(&mut model, msg);
            }
        }
        Ok(())
    })
}
```

### When to use TEA

- Apps with clearly defined state transitions
- Form-like interactions with multiple modes
- When testability of update logic matters (pure functions)

## Component Architecture

Each UI panel is an independent component with its own state, event handling, and rendering. An orchestrator (`App`) manages focus and routes events.

### Component Trait

```rust
use crossterm::event::KeyEvent;
use ratatui::Frame;

pub enum Action {
    None,
    Quit,
    FocusNext,
    FocusPrevious,
    Update(Box<dyn std::any::Any>),
}

pub trait Component {
    fn handle_key_event(&mut self, key: KeyEvent) -> Action;
    fn render(&mut self, frame: &mut Frame, area: Rect);

    // Optional hooks
    fn init(&mut self) -> Action { Action::None }
    fn focus(&mut self) {}
    fn blur(&mut self) {}
}
```

### App Orchestrator

```rust
struct App {
    components: Vec<Box<dyn Component>>,
    focused: usize,
    running: bool,
}

impl App {
    fn handle_key_event(&mut self, key: KeyEvent) {
        let action = self.components[self.focused].handle_key_event(key);
        match action {
            Action::Quit => self.running = false,
            Action::FocusNext => {
                self.components[self.focused].blur();
                self.focused = (self.focused + 1) % self.components.len();
                self.components[self.focused].focus();
            }
            Action::FocusPrevious => {
                self.components[self.focused].blur();
                self.focused = self.focused.checked_sub(1)
                    .unwrap_or(self.components.len() - 1);
                self.components[self.focused].focus();
            }
            _ => {}
        }
    }

    fn render(&mut self, frame: &mut Frame) {
        let areas = Layout::horizontal([
            Constraint::Percentage(30),
            Constraint::Percentage(70),
        ]).areas(frame.area());

        for (i, component) in self.components.iter_mut().enumerate() {
            component.render(frame, areas[i]);
        }
    }
}
```

### Example Component

```rust
struct SidebarComponent {
    items: Vec<String>,
    state: ListState,
    focused: bool,
}

impl Component for SidebarComponent {
    fn handle_key_event(&mut self, key: KeyEvent) -> Action {
        match key.code {
            KeyCode::Up => { self.state.select_previous(); Action::None }
            KeyCode::Down => { self.state.select_next(); Action::None }
            KeyCode::Tab => Action::FocusNext,
            KeyCode::Char('q') => Action::Quit,
            _ => Action::None,
        }
    }

    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let border_style = if self.focused {
            Style::new().cyan()
        } else {
            Style::default()
        };
        let list = List::new(self.items.clone())
            .block(Block::bordered().title("Sidebar").border_style(border_style))
            .highlight_style(Style::new().reversed());
        frame.render_stateful_widget(list, area, &mut self.state);
    }

    fn focus(&mut self) { self.focused = true; }
    fn blur(&mut self) { self.focused = false; }
}
```

### When to use Component Architecture

- Multi-panel applications (file browser + editor + preview)
- When components need independent state and event handling
- Plugin-like extensibility
- Large teams working on different sections

## Monolithic Architecture

Single `App` struct owns all state. Simple loop: poll -> step -> draw.

### Pattern (csvlens-style)

```rust
struct App {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
    state: TableState,
    input_handler: InputHandler,
    should_quit: bool,
}

impl App {
    pub fn main_loop(&mut self, terminal: &mut DefaultTerminal) -> Result<()> {
        loop {
            let control = self.input_handler.next(); // blocking poll
            if matches!(control, Control::Quit) { return Ok(()); }
            self.step(&control)?;
            self.draw(terminal)?;
        }
    }

    fn step(&mut self, control: &Control) -> Result<()> {
        match control {
            Control::ScrollDown => self.state.select_next(),
            Control::ScrollUp => self.state.select_previous(),
            _ => {}
        }
        Ok(())
    }

    fn draw(&mut self, terminal: &mut DefaultTerminal) -> Result<()> {
        terminal.draw(|frame| self.render_frame(frame))?;
        Ok(())
    }

    fn render_frame(&mut self, frame: &mut Frame) {
        let table = Table::new(&self.rows, &self.headers);
        frame.render_stateful_widget(table, frame.area(), &mut self.state);
    }
}
```

### When to use Monolithic

- Single-screen utilities
- Few keybindings, simple state
- No async requirements
- Quick prototyping

## Terminal Setup and Teardown

### `ratatui::run()` (v0.30+ — simplest)

Handles init, restore, and panic safety automatically:

```rust
fn main() -> Result<(), Box<dyn std::error::Error>> {
    ratatui::run(|terminal| {
        // terminal is ready to use
        loop {
            terminal.draw(|frame| { /* render */ })?;
            if crossterm::event::read()?.is_key_press() {
                break Ok(());
            }
        }
    })
}
```

### `ratatui::init()` / `ratatui::restore()` (manual)

```rust
fn main() -> Result<()> {
    let mut terminal = ratatui::init();
    let result = run(&mut terminal);
    ratatui::restore();
    result
}
```

### Manual setup (full control)

```rust
use crossterm::{
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, enable_raw_mode, disable_raw_mode},
    event::{EnableMouseCapture, DisableMouseCapture},
};

fn setup_terminal() -> Result<Terminal<CrosstermBackend<Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    Terminal::new(backend)
}

fn restore_terminal(terminal: &mut Terminal<CrosstermBackend<Stdout>>) -> Result<()> {
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen, DisableMouseCapture)?;
    terminal.show_cursor()?;
    Ok(())
}
```

### Panic hook with `color-eyre`

```rust
fn install_hooks() -> Result<()> {
    let (panic_hook, eyre_hook) = color_eyre::config::HookBuilder::default().into_hooks();
    let panic_hook = panic_hook.into_panic_hook();
    std::panic::set_hook(Box::new(move |info| {
        ratatui::restore();
        panic_hook(info);
    }));
    eyre_hook.install()?;
    Ok(())
}
```

### Manual panic hook (without color-eyre)

```rust
fn install_panic_hook() {
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        disable_raw_mode().ok();
        execute!(io::stdout(), LeaveAlternateScreen).ok();
        original_hook(info);
    }));
}
```

## Event Handling

### Synchronous polling (simple apps)

```rust
use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use std::time::Duration;

fn handle_events(model: &mut Model) -> Result<()> {
    if event::poll(Duration::from_millis(50))? {
        if let Event::Key(key) = event::read()? {
            if key.kind == KeyEventKind::Press {
                match key.code {
                    KeyCode::Char('q') => model.running = false,
                    KeyCode::Up => model.scroll_up(),
                    KeyCode::Char('j') => model.scroll_down(),
                    _ => {}
                }
            }
        }
    }
    Ok(())
}
```

**Important:** Always check `key.kind == KeyEventKind::Press` to avoid handling key release/repeat events on some platforms.

### Async event loop with tokio

```rust
use crossterm::event::EventStream;
use futures::StreamExt;
use tokio::sync::mpsc;

pub enum Event {
    Tick,
    Render,
    Key(KeyEvent),
    Mouse(MouseEvent),
    Resize(u16, u16),
}

pub struct Tui {
    terminal: DefaultTerminal,
    event_rx: mpsc::UnboundedReceiver<Event>,
    event_tx: mpsc::UnboundedSender<Event>,
    cancellation_token: CancellationToken,
}

impl Tui {
    pub fn start(&mut self) {
        let tx = self.event_tx.clone();
        let token = self.cancellation_token.clone();

        tokio::spawn(async move {
            let mut reader = EventStream::new();
            let mut tick_interval = tokio::time::interval(Duration::from_millis(250));
            let mut render_interval = tokio::time::interval(Duration::from_millis(16));

            loop {
                tokio::select! {
                    _ = token.cancelled() => break,
                    _ = tick_interval.tick() => { tx.send(Event::Tick).ok(); }
                    _ = render_interval.tick() => { tx.send(Event::Render).ok(); }
                    Some(Ok(evt)) = reader.next() => {
                        match evt {
                            CrosstermEvent::Key(key) if key.kind == KeyEventKind::Press => {
                                tx.send(Event::Key(key)).ok();
                            }
                            CrosstermEvent::Mouse(mouse) => {
                                tx.send(Event::Mouse(mouse)).ok();
                            }
                            CrosstermEvent::Resize(w, h) => {
                                tx.send(Event::Resize(w, h)).ok();
                            }
                            _ => {}
                        }
                    }
                }
            }
        });
    }

    pub async fn next(&mut self) -> Option<Event> {
        self.event_rx.recv().await
    }
}
```

### Input handler with Control enum (semantic mapping)

Map raw key events to semantic actions:

```rust
pub enum Control {
    ScrollUp, ScrollDown, ScrollLeft, ScrollRight,
    ScrollPageUp, ScrollPageDown,
    Find(String), Filter(String),
    Quit, Help, Nothing,
}

pub struct InputHandler {
    mode: InputMode,
    buffer: Option<Input>, // tui-input for text fields
}

impl InputHandler {
    pub fn handle_key(&mut self, key: KeyEvent) -> Control {
        match self.mode {
            InputMode::Normal => match key.code {
                KeyCode::Char('q') => Control::Quit,
                KeyCode::Up | KeyCode::Char('k') => Control::ScrollUp,
                KeyCode::Down | KeyCode::Char('j') => Control::ScrollDown,
                KeyCode::Char('/') => {
                    self.mode = InputMode::Search;
                    Control::Nothing
                }
                _ => Control::Nothing,
            },
            InputMode::Search => match key.code {
                KeyCode::Enter => {
                    let query = self.buffer.take().map(|b| b.value().to_string());
                    self.mode = InputMode::Normal;
                    Control::Find(query.unwrap_or_default())
                }
                KeyCode::Esc => { self.mode = InputMode::Normal; Control::Nothing }
                _ => {
                    if let Some(buf) = &mut self.buffer {
                        buf.handle_event(&crossterm::event::Event::Key(key));
                    }
                    Control::Nothing
                }
            },
        }
    }
}
```

## Layout System

### Constraint-based layout

```rust
use ratatui::layout::{Layout, Constraint, Rect};

let [header, body, footer] = Layout::vertical([
    Constraint::Length(3),    // fixed 3 rows
    Constraint::Min(1),      // takes remaining space
    Constraint::Length(1),    // fixed 1 row
]).areas(frame.area());
```

### Nested layouts

```rust
let [top, bottom] = Layout::vertical([
    Constraint::Length(3),
    Constraint::Min(0),
]).areas(frame.area());

let [sidebar, main] = Layout::horizontal([
    Constraint::Percentage(30),
    Constraint::Percentage(70),
]).areas(bottom);
```

### Constraint types

| Constraint | Behavior |
|---|---|
| `Length(n)` | Exactly n cells |
| `Min(n)` | At least n cells, can grow |
| `Max(n)` | At most n cells |
| `Percentage(n)` | n% of available space |
| `Ratio(a, b)` | a/b of available space |
| `Fill(weight)` | Fill remaining, weighted |

### Centering with `Rect::centered()` (v0.30+)

```rust
// Center both axes
let area = frame.area()
    .centered(Constraint::Percentage(60), Constraint::Percentage(40));

// Center one axis
let area = frame.area().centered_horizontally(Constraint::Length(40));
let area = frame.area().centered_vertically(Constraint::Length(10));
```

### Centering with Flex (pre-v0.30 or custom)

```rust
use ratatui::layout::Flex;

let [area] = Layout::horizontal([Constraint::Length(40)])
    .flex(Flex::Center)
    .areas(frame.area());
let [area] = Layout::vertical([Constraint::Length(10)])
    .flex(Flex::Center)
    .areas(area);
```

### Flex variants

| Variant | Behavior |
|---|---|
| `Flex::Start` | Items at start, excess at end |
| `Flex::End` | Items at end, excess at start |
| `Flex::Center` | Centered with equal space on sides |
| `Flex::SpaceBetween` | Even space between items, none at edges |
| `Flex::SpaceAround` | Space around items (2x between vs edges) |
| `Flex::SpaceEvenly` | Equal space between items and edges |
| `Flex::Legacy` | Legacy behavior, excess at end |

### `Rect::layout()` (v0.30+)

```rust
let layout = Layout::vertical([Constraint::Fill(1); 2]);
let [top, bottom] = frame.area().layout(&layout);
```

## Popup and Overlay Pattern

```rust
fn render_popup(frame: &mut Frame, title: &str, content: &str) {
    let area = frame.area()
        .centered(Constraint::Percentage(60), Constraint::Percentage(40));

    // Clear the area behind the popup
    frame.render_widget(Clear, area);

    // Render the popup
    let popup = Paragraph::new(content)
        .block(Block::bordered().title(title).border_type(BorderType::Rounded))
        .alignment(HorizontalAlignment::Center)
        .wrap(Wrap { trim: true });
    frame.render_widget(popup, area);
}
```

## State Management

### Shared state with `Arc<Mutex<T>>`

For multi-threaded async apps (e.g., with tokio):

```rust
let app_data = Arc::new(Mutex::new(AppData::new()));
let gui_state = Arc::new(Mutex::new(GuiState::new()));

// Clone for different tasks
let data_clone = Arc::clone(&app_data);
tokio::spawn(async move {
    data_clone.lock().unwrap().update(new_data);
});
```

### FrameData pattern (snapshot for rendering)

Collect all data needed for rendering into a snapshot struct to minimize lock contention:

```rust
pub struct FrameData {
    pub chart_data: Option<ChartData>,
    pub container_title: String,
    pub has_error: Option<AppError>,
    pub is_loading: bool,
    pub selected_panel: SelectablePanel,
}

impl From<&Ui> for FrameData {
    fn from(ui: &Ui) -> Self {
        let app_data = ui.app_data.lock();
        let gui_state = ui.gui_state.lock();
        Self {
            chart_data: app_data.get_chart_data(),
            container_title: app_data.get_container_title(),
            has_error: app_data.get_error(),
            is_loading: gui_state.is_loading,
            selected_panel: gui_state.selected_panel,
        }
    }
}
```

### StatefulList helper

Reusable wrapper for list navigation:

```rust
pub struct StatefulList<T> {
    pub state: ListState,
    pub items: Vec<T>,
}

impl<T> StatefulList<T> {
    pub fn new(items: Vec<T>) -> Self {
        Self { state: ListState::default(), items }
    }

    pub fn next(&mut self) {
        self.state.select_next();
    }

    pub fn previous(&mut self) {
        self.state.select_previous();
    }

    pub fn selected(&self) -> Option<&T> {
        self.state.selected().and_then(|i| self.items.get(i))
    }
}
```

## Testing

### Using TestBackend

```rust
#[cfg(test)]
mod tests {
    use ratatui::{Terminal, backend::TestBackend, buffer::Buffer, widgets::Paragraph};

    #[test]
    fn test_renders_correctly() {
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();

        terminal.draw(|frame| {
            let widget = Paragraph::new("Hello").block(Block::bordered());
            frame.render_widget(widget, frame.area());
        }).unwrap();

        let buffer = terminal.backend().buffer().clone();
        assert_eq!(buffer[(1, 1)].symbol(), "H");
    }
}
```

Note: In v0.30, `TestBackend` uses `core::convert::Infallible` for error handling instead of `std::io::Error`.

### Snapshot testing with insta

```rust
use insta::assert_snapshot;

#[test]
fn test_ui_snapshot() {
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend).unwrap();

    terminal.draw(|frame| render_app(frame)).unwrap();

    let view = terminal.backend().buffer().clone();
    assert_snapshot!(format!("{:?}", view));
}
```

### Widget unit tests

Test custom widgets directly by rendering to a Buffer:

```rust
#[test]
fn test_custom_widget() {
    let mut buf = Buffer::empty(Rect::new(0, 0, 20, 3));
    let widget = MyWidget::new("test");
    widget.render(buf.area, &mut buf);
    assert_eq!(buf[(0, 0)].symbol(), "t");
}
```

### Testing update logic (TEA pattern)

```rust
#[test]
fn test_increment() {
    let mut model = Model { counter: 0, running: true };
    update(&mut model, Message::Increment);
    assert_eq!(model.counter, 1);
}

#[test]
fn test_quit() {
    let mut model = Model { counter: 0, running: true };
    update(&mut model, Message::Quit);
    assert!(!model.running);
}
```
