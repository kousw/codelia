# Clipboard adapters

Typed paste reads native copied-file data ahead of a bitmap. macOS and Windows
use native file lists through arboard. Linux reads bounded X11 and Wayland
`text/uri-list` or GNOME copied-file selections. WSL maps Windows drive paths
through `wslpath`; UNC and unmapped paths stay unsupported in that bridge.
Clipboard acquisition runs on the import workers in `../attachments`. The
encoded bitmap value is defined here and shared with composer state.
