# Permission implementation rules

- Keep requested resources, hard ceilings and existing grants independent. Apply host-supplied ceilings as declared.
- Perform deterministic checks before constructing previews or evidence. Leave read and status free of reviewer, history and model setup.
- Decide on each complete shell program before launch. Run the original source once for a one-shot approval. Offer a reusable rule only for a single external command whose original invocation, resolved executable, arguments and execution authority can be bound and rechecked. Preserve the original Bash source or direct argv on reuse. Show the exact scope before saving it. Shell syntax and toolchain names confer no permission.
- Preserve the scope of human-authored words, globs, and saved rules during migration. Load repository allow entries only under user-selected project trust, including a matching legacy trusted policy. A user revocation takes priority.
- Keep configuration and launch rules outside a worker's writable scope. Treat capability, ownership, path, version and cancellation failures as admission failures.
- Keep native launcher selection independent of capability checks. Validate the resolved invocation before consuming a launch. Built-in shell support requires real-host tests for filesystem scope, handles, communication and descendant cleanup.
- Run the default Bun fixtures for policy changes. Use the opt-in Seatbelt tests for native capabilities and record fixture and real-host results separately.
