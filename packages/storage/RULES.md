# Storage lifecycle rules

- Original messages are append-only. Never replace them with compacted/trimmed views.
- Migrate the active view to contexts before switching the index archive version.
  Serialize migration/appends with the SQLite guard; flush originals before admission.
- Byte-offset message IDs must preserve physical UTF-8/CRLF boundaries and session
  scope. Read/search outputs are bounded and omit opaque provider payloads.
- Preserve conversation/lifecycle event bytes and canonical usage during archival;
  discard full diagnostic records and header prompts/tools. Verify the retained
  projection's decoded hash/length and recheck source identity/lifecycle before commit.
- Plain-to-gzip publication is exclusive. Replace legacy gzip atomically after
  verification and mark its archive version so it is not rewritten repeatedly.
- Keep final writer/pin/source checks and publication synchronous within one index
  guard; compression and usage I/O run before it. Module extraction must not insert
  an asynchronous boundary between these final checks and source removal.
- Pinning and live writers prevent automatic conversion and diagnostic removal.
  A live PID alone cannot prove marker ownership: remove a reused-PID marker only
  when saved/current process identities differ and the marker has not changed.
  Legacy or unknown identities must not grant permission to remove a live marker.
  Preserve independent compact usage before removing embedded diagnostics or dumps.
- Never collect originals, active checkpoints, index, references, usage or task data.
- Full diagnostic serialization remains opt-in; live metrics/model input are independent.
- Compact usage must retain the matching request's provider/model identity, including
  named endpoints, even when header.model is absent. Correlate by sequence and keep
  only accounting fields; do not retain request bodies to support usage.
- Legacy archival must extract request identity before deleting the request,
  including when metadata follows a large input. Keep existing canonical identity
  authoritative and fill missing values before using header fallback.
