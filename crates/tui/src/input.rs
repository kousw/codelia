#[derive(Default)]
pub struct InputState {
    pub buffer: Vec<char>,
    pub cursor: usize,
    pub history: Vec<String>,
    pub history_index: Option<usize>,
    pub history_saved: Option<String>,
    preferred_column: Option<usize>,
}

impl InputState {
    pub fn current(&self) -> String {
        self.buffer.iter().collect()
    }

    pub fn masked_clone(&self, mask: char) -> Self {
        let mut clone = Self::default();
        clone.buffer = self
            .buffer
            .iter()
            .map(|ch| if *ch == '\n' { '\n' } else { mask })
            .collect();
        clone.cursor = self.cursor.min(clone.buffer.len());
        clone
    }

    pub fn set_from(&mut self, value: &str) {
        self.buffer = value.chars().collect();
        self.cursor = self.buffer.len();
        self.preferred_column = None;
    }

    pub fn clear(&mut self) {
        self.buffer.clear();
        self.cursor = 0;
        self.history_index = None;
        self.history_saved = None;
        self.preferred_column = None;
    }

    pub fn insert_char(&mut self, ch: char) {
        self.buffer.insert(self.cursor, ch);
        self.cursor += 1;
        self.preferred_column = None;
        self.reset_history_nav();
    }

    pub fn insert_str(&mut self, value: &str) {
        for ch in value.chars() {
            self.buffer.insert(self.cursor, ch);
            self.cursor += 1;
        }
        self.preferred_column = None;
        self.reset_history_nav();
    }

    pub fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }
        self.cursor -= 1;
        self.buffer.remove(self.cursor);
        self.preferred_column = None;
        self.reset_history_nav();
    }

    pub fn delete(&mut self) {
        if self.cursor >= self.buffer.len() {
            return;
        }
        self.buffer.remove(self.cursor);
        self.preferred_column = None;
        self.reset_history_nav();
    }

    pub fn move_left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
        self.preferred_column = None;
    }

    pub fn move_right(&mut self) {
        if self.cursor < self.buffer.len() {
            self.cursor += 1;
        }
        self.preferred_column = None;
    }

    pub fn move_home(&mut self) {
        self.cursor = 0;
        self.preferred_column = None;
    }

    pub fn move_end(&mut self) {
        self.cursor = self.buffer.len();
        self.preferred_column = None;
    }

    pub fn move_up(&mut self) -> bool {
        let cursor = self.cursor.min(self.buffer.len());
        let current_start = self.line_start(cursor);
        if current_start == 0 {
            self.preferred_column = None;
            return false;
        }

        let column = self
            .preferred_column
            .unwrap_or(cursor.saturating_sub(current_start));
        let prev_end = current_start - 1;
        let prev_start = self.line_start(prev_end);
        let prev_len = prev_end.saturating_sub(prev_start);
        self.cursor = prev_start + column.min(prev_len);
        self.preferred_column = Some(column);
        true
    }

    pub fn move_down(&mut self) -> bool {
        let len = self.buffer.len();
        let cursor = self.cursor.min(len);
        let current_start = self.line_start(cursor);
        let Some(current_end) = self.find_next_newline(current_start) else {
            self.preferred_column = None;
            return false;
        };

        let column = self
            .preferred_column
            .unwrap_or(cursor.saturating_sub(current_start));
        let next_start = current_end + 1;
        let next_end = self.find_next_newline(next_start).unwrap_or(len);
        let next_len = next_end.saturating_sub(next_start);
        self.cursor = next_start + column.min(next_len);
        self.preferred_column = Some(column);
        true
    }

    pub fn kill_line(&mut self) {
        self.clear();
    }

    pub fn kill_to_end(&mut self) {
        if self.cursor < self.buffer.len() {
            self.buffer.truncate(self.cursor);
        }
        self.preferred_column = None;
        self.reset_history_nav();
    }

    pub fn delete_word_back(&mut self) {
        if self.cursor == 0 {
            return;
        }
        while self.cursor > 0 && self.buffer[self.cursor - 1].is_whitespace() {
            self.cursor -= 1;
            self.buffer.remove(self.cursor);
        }
        while self.cursor > 0 && !self.buffer[self.cursor - 1].is_whitespace() {
            self.cursor -= 1;
            self.buffer.remove(self.cursor);
        }
        self.preferred_column = None;
        self.reset_history_nav();
    }

    fn reset_history_nav(&mut self) {
        if self.history_index.is_some() {
            self.history_index = None;
            self.history_saved = None;
        }
    }

    pub fn history_up(&mut self) {
        if self.history.is_empty() {
            return;
        }
        let next_index = match self.history_index {
            None => {
                self.history_saved = Some(self.current());
                self.history.len().saturating_sub(1)
            }
            Some(index) => index.saturating_sub(1),
        };
        self.history_index = Some(next_index);
        let value = self.history[next_index].clone();
        self.set_from(&value);
    }

    pub fn history_down(&mut self) {
        let Some(index) = self.history_index else {
            return;
        };
        if index + 1 < self.history.len() {
            let next = index + 1;
            self.history_index = Some(next);
            let value = self.history[next].clone();
            self.set_from(&value);
            return;
        }
        self.history_index = None;
        if let Some(saved) = self.history_saved.take() {
            self.set_from(&saved);
        }
    }

    pub fn record_history(&mut self, value: &str) {
        if value.is_empty() {
            return;
        }
        if self.history.last().is_some_and(|last| last == value) {
            return;
        }
        self.history.push(value.to_string());
    }

    fn line_start(&self, pos: usize) -> usize {
        self.buffer[..pos]
            .iter()
            .rposition(|ch| *ch == '\n')
            .map(|idx| idx + 1)
            .unwrap_or(0)
    }

    fn find_next_newline(&self, start: usize) -> Option<usize> {
        self.buffer[start..]
            .iter()
            .position(|ch| *ch == '\n')
            .map(|offset| start + offset)
    }
}

#[cfg(test)]
mod tests {
    use super::InputState;

    #[test]
    fn move_up_down_preserves_desired_column() {
        let mut input = InputState::default();
        input.set_from("12345\n12\n1234");
        input.cursor = input.buffer.len();

        assert!(input.move_up());
        assert_eq!(input.cursor, 8);
        assert!(input.move_up());
        assert_eq!(input.cursor, 4);

        assert!(input.move_down());
        assert_eq!(input.cursor, 8);
        assert!(input.move_down());
        assert_eq!(input.cursor, 13);
    }

    #[test]
    fn move_up_down_returns_false_at_boundaries() {
        let mut input = InputState::default();
        input.set_from("line1\nline2");
        input.cursor = 0;
        assert!(!input.move_up());

        input.cursor = input.buffer.len();
        assert!(!input.move_down());
    }

    #[test]
    fn horizontal_move_resets_desired_column() {
        let mut input = InputState::default();
        input.set_from("12345\n12\n1234");
        input.cursor = input.buffer.len();

        assert!(input.move_up());
        assert_eq!(input.cursor, 8);
        input.move_left();

        assert!(input.move_down());
        assert_eq!(input.cursor, 10);
    }

    #[test]
    fn masked_clone_preserves_newlines_and_cursor() {
        let mut input = InputState::default();
        input.set_from("ab\ncd");
        input.cursor = 4;

        let masked = input.masked_clone('*');

        assert_eq!(masked.current(), "**\n**");
        assert_eq!(masked.cursor, 4);
    }
}
