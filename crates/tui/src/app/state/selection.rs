use super::render::WrappedLogRow;
use ratatui::layout::Rect;
use std::cmp::Ordering;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectionProjectionId {
    pub log_version: u64,
    pub wrap_width: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct SelectionPoint {
    pub wrapped_row: usize,
    pub cell: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectionRange {
    pub start: SelectionPoint,
    pub end: SelectionPoint,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectionHitTest {
    Start,
    ExtendFrom(SelectionPoint),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TextSelectionPhase {
    #[default]
    Idle,
    Dragging {
        anchor: SelectionPoint,
        focus: SelectionPoint,
        projection: SelectionProjectionId,
    },
    Selected {
        anchor: SelectionPoint,
        focus: SelectionPoint,
        projection: SelectionProjectionId,
    },
}

impl TextSelectionPhase {
    pub fn start(&mut self, point: SelectionPoint, projection: SelectionProjectionId) {
        *self = Self::Dragging {
            anchor: point,
            focus: point,
            projection,
        };
    }

    pub fn update_drag(
        &mut self,
        point: SelectionPoint,
        projection: SelectionProjectionId,
    ) -> bool {
        let Self::Dragging {
            focus,
            projection: active_projection,
            ..
        } = self
        else {
            return false;
        };
        if *active_projection != projection {
            *self = Self::Idle;
            return true;
        }
        if *focus == point {
            return false;
        }
        *focus = point;
        true
    }

    pub fn finish_drag(
        &mut self,
        point: SelectionPoint,
        projection: SelectionProjectionId,
    ) -> Option<SelectionRange> {
        let Self::Dragging {
            anchor,
            projection: active_projection,
            ..
        } = *self
        else {
            return None;
        };
        if active_projection != projection || anchor == point {
            *self = Self::Idle;
            return None;
        }
        *self = Self::Selected {
            anchor,
            focus: point,
            projection,
        };
        self.normalized_range()
    }

    pub fn normalized_range(&self) -> Option<SelectionRange> {
        let (anchor, focus) = match *self {
            Self::Dragging { anchor, focus, .. } | Self::Selected { anchor, focus, .. } => {
                (anchor, focus)
            }
            Self::Idle => return None,
        };
        if anchor == focus {
            return None;
        }
        let (start, end) = if anchor <= focus {
            (anchor, focus)
        } else {
            (focus, anchor)
        };
        Some(SelectionRange { start, end })
    }

    pub fn projection(&self) -> Option<SelectionProjectionId> {
        match *self {
            Self::Idle => None,
            Self::Dragging { projection, .. } | Self::Selected { projection, .. } => {
                Some(projection)
            }
        }
    }

    pub fn is_dragging(&self) -> bool {
        matches!(self, Self::Dragging { .. })
    }

    pub fn drag_anchor(&self) -> Option<SelectionPoint> {
        match *self {
            Self::Dragging { anchor, .. } => Some(anchor),
            Self::Idle | Self::Selected { .. } => None,
        }
    }

    pub fn clear(&mut self) -> bool {
        if matches!(self, Self::Idle) {
            return false;
        }
        *self = Self::Idle;
        true
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TranscriptHitMap {
    pub frame_revision: u64,
    pub projection: SelectionProjectionId,
    pub log_area: Rect,
    pub visible_start: usize,
    pub visible_end: usize,
}

impl TranscriptHitMap {
    pub fn point_at(
        &self,
        wrapped_rows: &[WrappedLogRow],
        column: u16,
        row: u16,
        hit_test: SelectionHitTest,
    ) -> Option<SelectionPoint> {
        let visible_end = self.visible_end.min(wrapped_rows.len());
        if self.log_area.is_empty() || self.visible_start >= visible_end {
            return None;
        }
        let bottom = self.log_area.bottom().saturating_sub(1);
        if matches!(hit_test, SelectionHitTest::Start)
            && (column < self.log_area.x
                || column >= self.log_area.right()
                || row < self.log_area.y
                || row > bottom)
        {
            return None;
        }
        let clamped_column = column.clamp(self.log_area.x, self.log_area.right().saturating_sub(1));
        let clamped_row = row.clamp(self.log_area.y, bottom);
        let wrapped_row = self
            .visible_start
            .saturating_add((clamped_row - self.log_area.y) as usize)
            .min(visible_end.saturating_sub(1));
        let wrapped_row = self.resolve_selectable_row(wrapped_rows, wrapped_row, hit_test)?;
        let cell = nearest_selectable_cell(
            wrapped_rows.get(wrapped_row)?,
            (clamped_column - self.log_area.x) as usize,
        )?;
        Some(SelectionPoint { wrapped_row, cell })
    }

    fn resolve_selectable_row(
        &self,
        wrapped_rows: &[WrappedLogRow],
        wrapped_row: usize,
        hit_test: SelectionHitTest,
    ) -> Option<usize> {
        let visible_end = self.visible_end.min(wrapped_rows.len());
        let selectable = |index: &usize| {
            wrapped_rows
                .get(*index)
                .is_some_and(|row| !row.selectable_fragments.is_empty())
        };
        if selectable(&wrapped_row) {
            return Some(wrapped_row);
        }

        let SelectionHitTest::ExtendFrom(anchor) = hit_test else {
            return None;
        };
        match wrapped_row.cmp(&anchor.wrapped_row) {
            Ordering::Greater => (wrapped_row + 1..visible_end)
                .find(selectable)
                .or_else(|| (self.visible_start..wrapped_row).rev().find(selectable)),
            Ordering::Less => (self.visible_start..wrapped_row)
                .rev()
                .find(selectable)
                .or_else(|| (wrapped_row + 1..visible_end).find(selectable)),
            Ordering::Equal => None,
        }
    }
}

fn nearest_selectable_cell(row: &WrappedLogRow, cell: usize) -> Option<usize> {
    let first = row.selectable_fragments.first()?;
    if cell < first.cell_start {
        return Some(first.cell_start);
    }

    let mut previous = first;
    for fragment in &row.selectable_fragments {
        if cell < fragment.cell_start {
            let previous_cell = previous.cell_end.saturating_sub(1);
            let previous_distance = cell.saturating_sub(previous_cell);
            let next_distance = fragment.cell_start.saturating_sub(cell);
            return Some(if previous_distance <= next_distance {
                previous_cell
            } else {
                fragment.cell_start
            });
        }
        if cell < fragment.cell_end {
            return Some(cell.max(fragment.cell_start));
        }
        previous = fragment;
    }
    Some(previous.cell_end.saturating_sub(1))
}

#[cfg(test)]
mod tests {
    use super::{
        SelectionHitTest, SelectionPoint, SelectionProjectionId, TextSelectionPhase,
        TranscriptHitMap,
    };
    use crate::app::state::{LogKind, LogLine, SelectableFragment, WrappedLogRow};
    use ratatui::layout::Rect;

    fn projection(log_version: u64) -> SelectionProjectionId {
        SelectionProjectionId {
            log_version,
            wrap_width: 20,
        }
    }

    fn row(fragment: Option<(usize, usize)>) -> WrappedLogRow {
        WrappedLogRow {
            line: LogLine::new(LogKind::Assistant, "row"),
            selectable_fragments: fragment
                .map(|(cell_start, cell_end)| SelectableFragment {
                    cell_start,
                    cell_end,
                    text: "row".to_string(),
                })
                .into_iter()
                .collect(),
            soft_wrap_after: false,
        }
    }

    fn selectable_rows(count: usize) -> Vec<WrappedLogRow> {
        (0..count).map(|_| row(Some((0, 20)))).collect()
    }

    #[test]
    fn reverse_drag_normalizes_and_copies_once_on_release() {
        let mut state = TextSelectionPhase::default();
        let projection = projection(1);
        state.start(
            SelectionPoint {
                wrapped_row: 4,
                cell: 8,
            },
            projection,
        );
        assert!(state.update_drag(
            SelectionPoint {
                wrapped_row: 2,
                cell: 3,
            },
            projection,
        ));
        let range = state
            .finish_drag(
                SelectionPoint {
                    wrapped_row: 2,
                    cell: 3,
                },
                projection,
            )
            .expect("non-empty selection");
        assert_eq!(range.start.wrapped_row, 2);
        assert_eq!(range.end.wrapped_row, 4);
        assert!(state
            .finish_drag(
                SelectionPoint {
                    wrapped_row: 2,
                    cell: 3,
                },
                projection,
            )
            .is_none());
    }

    #[test]
    fn zero_width_release_clears_without_copy() {
        let mut state = TextSelectionPhase::default();
        let point = SelectionPoint {
            wrapped_row: 1,
            cell: 2,
        };
        state.start(point, projection(1));
        assert!(state.finish_drag(point, projection(1)).is_none());
        assert_eq!(state, TextSelectionPhase::Idle);
    }

    #[test]
    fn per_draw_revision_does_not_change_projection_identity() {
        let rows = selectable_rows(14);
        let projection = projection(7);
        let first = TranscriptHitMap {
            frame_revision: 1,
            projection,
            log_area: Rect::new(0, 0, 20, 4),
            visible_start: 10,
            visible_end: 14,
        };
        let second = TranscriptHitMap {
            frame_revision: 2,
            ..first
        };
        let mut state = TextSelectionPhase::default();
        state.start(
            first
                .point_at(&rows, 1, 1, SelectionHitTest::Start)
                .unwrap(),
            first.projection,
        );
        let anchor = state.drag_anchor().unwrap();
        let point = second
            .point_at(&rows, 5, 2, SelectionHitTest::ExtendFrom(anchor))
            .unwrap();
        assert!(state.update_drag(point, second.projection));
        assert!(state.is_dragging());
    }

    #[test]
    fn content_projection_mismatch_cancels_drag() {
        let mut state = TextSelectionPhase::default();
        state.start(
            SelectionPoint {
                wrapped_row: 1,
                cell: 1,
            },
            projection(1),
        );
        assert!(state.update_drag(
            SelectionPoint {
                wrapped_row: 2,
                cell: 2,
            },
            projection(2),
        ));
        assert_eq!(state, TextSelectionPhase::Idle);
    }

    #[test]
    fn hit_map_clamps_active_drag_to_visible_log() {
        let rows = selectable_rows(23);
        let hit_map = TranscriptHitMap {
            frame_revision: 1,
            projection: projection(1),
            log_area: Rect::new(3, 5, 10, 3),
            visible_start: 20,
            visible_end: 23,
        };
        assert!(hit_map
            .point_at(&rows, 0, 0, SelectionHitTest::Start)
            .is_none());
        assert_eq!(
            hit_map.point_at(
                &rows,
                99,
                99,
                SelectionHitTest::ExtendFrom(SelectionPoint {
                    wrapped_row: 20,
                    cell: 0,
                }),
            ),
            Some(SelectionPoint {
                wrapped_row: 22,
                cell: 9,
            })
        );
    }

    #[test]
    fn start_rejects_rows_without_selectable_fragments() {
        let rows = vec![row(None)];
        let hit_map = TranscriptHitMap {
            frame_revision: 1,
            projection: projection(1),
            log_area: Rect::new(0, 0, 10, 1),
            visible_start: 0,
            visible_end: 1,
        };

        assert!(hit_map
            .point_at(&rows, 3, 0, SelectionHitTest::Start)
            .is_none());
    }

    #[test]
    fn horizontal_padding_clamps_to_nearest_selectable_cell() {
        let rows = vec![row(Some((2, 6)))];
        let hit_map = TranscriptHitMap {
            frame_revision: 1,
            projection: projection(1),
            log_area: Rect::new(0, 0, 10, 1),
            visible_start: 0,
            visible_end: 1,
        };

        assert_eq!(
            hit_map.point_at(&rows, 0, 0, SelectionHitTest::Start),
            Some(SelectionPoint {
                wrapped_row: 0,
                cell: 2,
            })
        );
        assert_eq!(
            hit_map.point_at(&rows, 9, 0, SelectionHitTest::Start),
            Some(SelectionPoint {
                wrapped_row: 0,
                cell: 5,
            })
        );
    }

    #[test]
    fn blank_row_extension_resolves_in_drag_direction() {
        let rows = vec![row(Some((1, 4))), row(None), row(Some((2, 5)))];
        let hit_map = TranscriptHitMap {
            frame_revision: 1,
            projection: projection(1),
            log_area: Rect::new(0, 0, 10, 3),
            visible_start: 0,
            visible_end: 3,
        };

        assert_eq!(
            hit_map.point_at(
                &rows,
                3,
                1,
                SelectionHitTest::ExtendFrom(SelectionPoint {
                    wrapped_row: 0,
                    cell: 1,
                }),
            ),
            Some(SelectionPoint {
                wrapped_row: 2,
                cell: 3,
            })
        );
        assert_eq!(
            hit_map.point_at(
                &rows,
                3,
                1,
                SelectionHitTest::ExtendFrom(SelectionPoint {
                    wrapped_row: 2,
                    cell: 2,
                }),
            ),
            Some(SelectionPoint {
                wrapped_row: 0,
                cell: 3,
            })
        );
    }
}
