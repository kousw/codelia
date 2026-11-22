# Protocol codegen rules

- Output must be deterministic: definitions sorted by id, methods sorted by
  name, fields in declaration order, no timestamps or absolute paths.
- Encode compatibility rules in the generator, not in hand-written adapters:
  open string enums, `Unknown` only for new string tag values (a missing or
  mistyped tag is an error), ignored unknown fields, strict decoding of known
  variants and boolean literals, declared null presence.
- Stop generation with the definition id and JSON path for anything outside
  the wire subset instead of guessing a Rust shape.
- Do not add generator options per method. If a method needs special handling,
  change its schema or the subset rules in the spec first.
- Keep this tool dependency-free beyond `@codelia/protocol` and the pinned Zod.
