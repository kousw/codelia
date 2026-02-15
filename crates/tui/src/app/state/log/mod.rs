use crate::app::util::text::sanitize_for_tui;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogKind {
    System,
    User,
    Assistant,
    AssistantCode,
    Reasoning,
    ToolCall,
    ToolResult,
    DiffMeta,
    DiffContext,
    DiffAdded,
    DiffRemoved,
    Status,
    Rpc,
    Runtime,
    Space,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogTone {
    Summary,
    Detail,
}

#[derive(Clone, Debug)]
pub struct LogSpan {
    pub kind: LogKind,
    pub tone: LogTone,
    pub text: String,
}

impl LogSpan {
    pub fn new(kind: LogKind, tone: LogTone, text: impl Into<String>) -> Self {
        let raw = text.into();
        Self {
            kind,
            tone,
            text: sanitize_for_tui(&raw),
        }
    }
}

#[derive(Clone, Debug)]
pub struct LogLine {
    pub spans: Vec<LogSpan>,
}

impl LogLine {
    pub fn new(kind: LogKind, text: impl Into<String>) -> Self {
        Self::new_with_tone(kind, LogTone::Summary, text)
    }

    pub fn new_with_tone(kind: LogKind, tone: LogTone, text: impl Into<String>) -> Self {
        Self {
            spans: vec![LogSpan::new(kind, tone, text)],
        }
    }

    pub fn new_with_spans(spans: Vec<LogSpan>) -> Self {
        Self { spans }
    }

    pub fn spans(&self) -> &[LogSpan] {
        &self.spans
    }

    pub fn first_style(&self) -> (LogKind, LogTone) {
        self.spans
            .first()
            .map(|span| (span.kind, span.tone))
            .unwrap_or((LogKind::System, LogTone::Summary))
    }

    pub fn kind(&self) -> LogKind {
        self.first_style().0
    }

    pub fn tone(&self) -> LogTone {
        self.first_style().1
    }

    pub fn plain_text(&self) -> String {
        self.spans.iter().map(|span| span.text.as_str()).collect()
    }

    pub fn is_single_span(&self) -> bool {
        self.spans.len() == 1
    }

    pub fn with_text(&self, text: impl Into<String>) -> Self {
        let (kind, tone) = self.first_style();
        Self::new_with_tone(kind, tone, text)
    }
}
