# Desktop packaging rules

- Use native Mach-O as the macOS bundle main; shell scripts are build-time entry points only.
- Keep validation configuration bounded, synthetic and loopback-only; never copy user credentials or protected runtime source.
- Give each validation build its own app identity and preserve previous validation instances.
- Treat local ad-hoc signing as development integrity, not distribution notarization or permission authorization.
