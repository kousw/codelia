# codelia-protocol rules

- Keep the crate independent of UI state, runtime processes and transports.
- Change wire structures in the TypeScript catalog and regenerate the Rust
  types. Keep handwritten code focused on JSON-RPC envelopes and shared serde
  semantics.
- Run the fixture suite on the declared Rust version before raising it.
