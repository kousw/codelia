# Desktop Visual Design

This document defines the target visual direction for the desktop app.
It is intentionally product-level and implementation-agnostic.

## Status

- Current implementation:
  - `packages/desktop/src/mainview/index.css` is a provisional MVP styling pass
  - the current UI proves layout and runtime wiring, but it is not the target visual language
- Planned target:
  - the desktop app should move to a denser, calmer, more editorial workbench style
  - this document defines that target look and feel

## 1. Goals

- Make the desktop app feel like a serious coding workbench, not a decorative demo shell.
- Preserve chat as the primary workflow while making the rest of the app feel precise and trustworthy.
- Use Codelia's existing amber brand cue as the identity anchor without over-saturating the interface.
- Improve perceived quality through typography, spacing, contrast, and restraint rather than ornament.

## 2. Core visual direction

The target theme is a **quiet, high-density, light-first workbench**.

It should feel:

- focused rather than playful
- crisp rather than glassy
- structured rather than card-heavy
- editorial rather than marketing-like
- warm in identity, but mostly neutral in the working surface

The desktop app should avoid:

- large gradients as the main background treatment
- oversized border radii on routine UI
- translucent/glassmorphism-heavy panels
- decorative serif display headings in product UI chrome
- frequent accent-color fills across large surface areas

## 3. Color system

### 3.1 Brand basis

The primary color should be based on the existing `codelia` theme family.

Current reusable Codelia accent cues already exist in the TUI theme system:

- primary amber reference: `rgb(232, 178, 92)` / `#E8B25C`
- bright emphasis amber: `rgb(248, 208, 120)` / `#F8D078`
- muted warm support tone: `rgb(215, 188, 155)` / `#D7BC9B`

Desktop should reinterpret those values into a more product-neutral token set.

### 3.2 Theme principle

Neutrals should carry most of the UI.
Amber should appear as a precision accent, not as a paint bucket.

Use accent color primarily for:

- selected navigation state
- active session/workspace indicators
- primary action buttons
- focus rings
- status emphasis where "active" or "ready" matters
- small progress or context markers

Do not use accent color for:

- full-screen backgrounds
- large panel fills
- long transcript areas
- repeated decorative gradients

### 3.3 Light theme token direction

Suggested baseline token family:

- app background: soft neutral paper gray
- panel background: near-white
- elevated background: white
- subtle hover tint: warm-gray or cool-gray, not amber
- border/default divider: low-contrast gray
- primary text: near-black neutral
- secondary text: medium gray
- tertiary text: subdued gray
- accent primary: Codelia amber
- accent hover: slightly deeper amber
- accent subtle bg: very low-opacity amber tint
- success: neutral green
- warning: muted amber-orange
- danger: restrained red

Suggested desktop token examples:

- `--bg-app: #F6F7F9`
- `--bg-panel: #FFFFFF`
- `--bg-panel-muted: #FBFBFC`
- `--border-default: #D8DEE4`
- `--border-strong: #C7D0D9`
- `--text-primary: #1F2328`
- `--text-secondary: #59636E`
- `--text-tertiary: #7A8591`
- `--accent-500: #E8B25C`
- `--accent-600: #D49A3C`
- `--accent-soft: rgba(232, 178, 92, 0.14)`
- `--focus-ring: rgba(212, 154, 60, 0.34)`

These token values are a direction, not a frozen implementation contract.

### 3.4 Future dark theme direction

Dark mode is not required for the next pass, but if added later it should:

- stay low-glow and low-saturation
- preserve amber as an accent, not a neon
- avoid pure black backgrounds
- preserve the same information hierarchy as the light theme

## 4. Typography

### 4.1 Product UI typography

The visual language should use a modern, neutral sans serif for almost all product chrome.

Preferred direction:

- UI font:
  - `Geist`
  - `SF Pro Text`
  - `Segoe UI Variable`
  - fallback sans serif stack
- code font:
  - `JetBrains Mono`
  - `Berkeley Mono`
  - `SF Mono`
  - fallback monospace stack

### 4.2 Typography rules

- Use one UI sans family for navigation, controls, labels, and transcript metadata.
- Use monospace only where code, paths, commands, or structured execution output need it.
- Avoid serif headings in persistent app chrome.
- Prefer weight, spacing, and alignment over size inflation.
- Keep heading scale restrained so the interface feels compact and work-focused.

### 4.3 Density guidance

- sidebar labels: compact
- session titles: compact but readable
- transcript body: slightly roomier than navigation text
- metadata and helper text: smaller but high-contrast enough to remain legible

## 5. Layout and surface styling

### 5.1 Overall shell

The shell should read as a single integrated workspace, not four unrelated cards.

Target layout behavior:

- app background provides separation from the system window
- left navigation regions feel attached to the same frame
- main chat pane feels primary but not oversized
- supporting inspect/context panels read as secondary work surfaces

### 5.2 Surface treatment

Default surfaces should use:

- small or medium radii
- thin dividers
- clear hover/selected states
- minimal shadows
- no backdrop blur by default

Guidance:

- outer app shell radius may be moderate
- routine inner controls should be tighter
- lists should use separators more than floating cards
- selected rows should be driven by tint + border + text contrast, not elevation alone

### 5.3 Spacing system

Adopt a tight 4px-based rhythm.

Suggested scale:

- `4`, `8`, `12`, `16`, `20`, `24`, `32`

Use:

- `8-12` for dense list rows and inline controls
- `16-20` for panel padding
- `24-32` only for major page or empty-state spacing

## 6. Component direction

### 6.1 Sidebar

The sidebar should feel navigational and durable.

Behavioral styling:

- workspace rows and session rows should look like list items first, cards second
- active item gets subtle accent tint and stronger left edge or inset indicator
- archived/secondary items should reduce emphasis through text tone, not opacity collapse

### 6.2 Top bar

The top bar should be a utility strip, not a hero banner.

It should contain:

- workspace identity
- run status
- lightweight utility actions

Style guidance:

- flat or nearly flat background
- single divider
- compact height
- pills/chips only where information benefits from enclosure

### 6.3 Transcript

The transcript should prioritize readability over stylization.

Guidance:

- user and assistant turns should be distinguishable without chat-bubble theatrics
- user turns may keep a restrained bubble treatment
- user bubbles should not repeat redundant author chrome like `You` when the alignment already makes authorship obvious
- assistant output should resemble an editor/log surface more than a consumer messaging app
- the main transcript work surface should stay white or near-white for maximum legibility
- tool events and reasoning traces should be inspectable with clear secondary styling
- long operational output should use bordered blocks, not fully decorated cards
- expandable reasoning/tool rows should read as flat disclosure rows first, with a clear expand indicator even when outer framing is minimal
- tool/reasoning disclosure rows should keep labels and summaries visually subordinate to primary assistant prose; use lighter text treatment instead of heavy chips or boxed chrome
- nested disclosure items may be used when repeated tool activity benefits from grouping
- plan for future markdown rendering and syntax highlighting so rich technical responses can stay readable without reverting to decorative chat bubbles

### 6.4 Composer

The composer should feel like the strongest interaction point in the app.

Guidance:

- cleaner border treatment than the rest of the shell
- visible focus ring
- compact control row
- primary action clearly tied to accent color
- attached context chips should be calm and token-like, not colorful badges
- branch hint and model selection should sit with the composer context area rather than in the global top bar when they are primarily relevant to the active chat draft
- branch/model context should prefer a secondary row below the send/stop controls rather than sitting between the draft field and the primary action row

### 6.5 Inspect and utility panels

Supporting panels should resemble inspector panes:

- denser than chat
- sectioned by headers and dividers
- optimized for scanning
- not styled as marketing cards

## 7. Motion and interaction feel

Motion should be subtle and utility-oriented.

Use motion for:

- panel state transitions
- hover and selection feedback
- modal appearance
- run state changes

Avoid:

- large-scale parallax
- ambient floating animation
- delayed or springy motion on routine controls

Timing direction:

- hover/focus transitions: fast
- panel open/close: short and direct
- disclosure rows should reuse the same short timing and easing as other utility motion
- no animation should block work

Specific disclosure guidance:

- disclosure motion should be subtle fade/slide plus chevron rotation, not springy accordion theatrics
- parent and nested disclosure rows should use the same timing family
- expanded content may animate in, but collapsed state should not leave layout ghosts or heavy residual separators

## 8. Accessibility and legibility

- AA-level contrast should be the baseline for primary text and actionable controls.
- Selected and focused states must remain legible without relying on color alone.
- Dense layout must not reduce tappable/clickable affordances below practical desktop use.
- Run state, error state, and approval state should remain distinguishable in grayscale.

## 9. MVP application guidance

The next UI pass does not need to redesign the product structure.
It should keep the existing MVP layout but restyle it according to this document.

Priority order for the next visual pass:

1. replace the current decorative background and glassy cards with a workbench shell
2. switch to the new neutral-plus-amber token system
3. tighten typography and spacing
4. restyle sidebar/session list to be list-driven rather than card-driven
5. reduce chat bubble stylization and improve transcript readability
6. make composer and top bar feel more precise and utility-oriented
7. make the empty state feel composed and editorial, with a hero surface plus structured supporting panels instead of a single dashed placeholder

## 10. Non-goals

- introducing a visually loud brand-first layout
- using accent color as a dominant page background
- mimicking a social chat app
- turning the desktop app into a browser-like tab product in this phase
