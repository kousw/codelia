"""Check native application/state boundaries without resolving user data or config."""
from pathlib import Path
import re

source = Path(__file__).resolve().parents[1] / "src"
pure = [*sorted(source.glob("application*.rs")), source / "state.rs", source / "drafts.rs", source / "client_tool.rs", *sorted((source / "state").glob("*.rs"))]
for path in pure:
    text = path.read_text()
    forbidden = r"(?:use|::)\s*(?:gpui|gpui_kit|crate::(?:app|runtime_adapter|transport|git|ui))\b|std::(?:fs|process|net)\b"
    assert not re.search(forbidden, text), f"I/O/view dependency in pure layer: {path.name}"
for name in ["runtime_adapter.rs", "transport.rs", "git.rs", "draft_store.rs", "draft_controller.rs"]:
    assert not re.search(r"\bgpui(?:_kit)?\b", (source / name).read_text()), f"GPUI dependency in adapter: {name}"
assert 'std::process' not in (source / "application.rs").read_text()
print("PASS: application/state/client-tool have no GPUI or I/O dependencies; runtime/git/transport have no GPUI dependencies")
