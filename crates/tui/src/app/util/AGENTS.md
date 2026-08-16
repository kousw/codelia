# app utilities

`src/app/util/` owns shared helpers that do not mutate `AppState`.

## Clipboard rules

- Text and image clipboard adapters live under `clipboard/`.
- WSL text copy sends UTF-8 bytes through child stdin to a fixed PowerShell
  script. Set `Console.InputEncoding` to UTF-8 before `ReadToEnd()` and never
  interpolate selected text into arguments or source.
- Clipboard subprocess waits must be bounded, including stdin pipe delivery;
  diagnostics must not include copied text.
