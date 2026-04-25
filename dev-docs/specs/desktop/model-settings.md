# Desktop Model Settings

This document defines how model, reasoning, and fast-mode controls should appear in the desktop product.

## 1. Goals

- Keep model controls visible enough to build trust without dominating the chat surface.
- Preserve the same model selection semantics as TUI/runtime.
- Make model state easy to understand at workspace scope.

## 2. Core controls

Desktop should expose:

- current provider
- current model
- current reasoning effort when supported
- current fast-mode state when supported
- model availability/loading error state

These controls may live in the top bar, composer area, or a lightweight settings sheet, but they must stay close to the active workspace/session flow.

## 3. Scope rules

The baseline desktop product should treat model selection as:

- runtime-backed
- workspace-scoped in practice for user understanding
- immediately reflected in subsequent sends

If desktop later adds per-session overrides, that must be explicit and visually obvious.

## 4. Interaction rules

- changing the model should not silently rewrite transcript history
- changes should apply to future runs only
- disabled/unavailable states should explain why selection is unavailable
- long model names should remain readable without breaking layout

## 5. Reasoning controls

When the provider/runtime exposes reasoning levels, desktop should surface them as first-class controls rather than burying them in opaque advanced settings.

Baseline reasoning states:

- low
- medium
- high
- xhigh when available

The UI may compact these controls, but should avoid making them feel like obscure debug flags.

## 6. Fast-mode controls

When runtime exposes `model.fast`, desktop should surface it as a compact model-adjacent toggle rather than an inspect/debug setting.

Fast mode is capability-gated by runtime:

- unsupported provider/model combinations remain effectively off
- toggling fast mode applies to future runs only
- the UI should reflect the effective state returned from `model.list`

## 7. Visibility in transcript

Desktop should not spam the transcript with routine model-change logs.

However, the product should make it possible to answer:

- which model is currently active
- which model a run used when that matters

That can be achieved through status chrome, diagnostics, or run metadata rather than chat clutter.

## 8. Persistence direction

Desktop may later persist a preferred default model per workspace.

If that is added:

- it should be clearly distinguished from the currently active runtime selection
- restore behavior should remain predictable after relaunch

## 9. TUI parity baseline

Desktop should remain aligned with:

- `model.list`
- `model.set`
- provider/model capability limits
- reasoning availability semantics
- `/fast [on|off|toggle]` command semantics

Desktop may change presentation, but not command meaning.

## 10. Non-goals

- desktop-specific shadow model registries
- prompt-level hidden model overrides without visible affordance
