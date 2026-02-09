# packages/model-metadata

## Notes

- models.dev responses are validated at runtime with zod; `models` is accepted as either an array or a record and extra fields are ignored.
- models.dev smoke test is integration-gated (`INTEGRATION=1`) and makes a real network call.
- ModelDevSource caches parsed metadata at `cache/models.dev.json` (TTL 24h) using `@codelia/storage`.
- `ModelMetadataServiceImpl` is the concrete implementation of the core `ModelMetadataService` DI interface.
- `ModelDevSource` accepts a `StoragePathService` override for resolving cache paths.
