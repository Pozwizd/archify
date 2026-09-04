# Java/Spring endpoint extraction

`archify extract endpoints` creates a directory of validated, controller-grouped class diagrams from local Java source. It is intentionally conservative: it recognizes Spring MVC annotations and follows only project types and field-receiver calls visible in source. It does not claim runtime tracing, framework wiring verification, or a complete Java compiler model.

Each endpoint is rendered as an isolated horizontal scenario lane. Lanes use the same semantic stage order—request DTO, controller, service, implementation/helper, data, response—and intentionally duplicate shared project types. A duplicated card shows only members used by that endpoint, so following one route never requires crossing into another route. Guided Views focus the matching lane. The source manifest maps every scenario-scoped card `id` back to its stable `sourceId` and source location.

```bash
node bin/archify.mjs extract endpoints \
  --repo-root /path/to/project \
  --output /tmp/endpoint-diagrams \
  --mode onboarding \
  --locale ru \
  --ai
```

The output directory must not already exist. A successful run writes:

- `index.html` — links grouped by controller;
- `manifest.json` — options, warnings, controller routes, validation results, and source evidence;
- `diagrams/*.html` — standalone Archify diagrams;
- `sources/*.class-diagram.json` — reproducible typed IR.

## Options

- `--mode onboarding|reference` selects progressive onboarding output or denser reference output; default `onboarding`. Onboarding creates one diagram per endpoint, uses numbered semantic stages, adds an entry-point card, and groups scenario cards by controller in the index. Reference mode defaults to three endpoint lanes per diagram.
- `--controller Name` selects one simple or fully qualified controller name.
- `--package prefix` limits controllers to a Java package prefix.
- `--exclude fragment` skips matching repository-relative paths; repeat as needed.
- `--relation-depth 1..5` bounds proven field-call traversal; default `2`.
- `--max-types 1..40` bounds duplicated types in each endpoint lane; default `7` in onboarding mode and `8` in reference mode.
- `--scenarios-per-diagram 1..5` overrides the number of isolated endpoint lanes and Guided Views per diagram; default `1` in onboarding mode and `3` in reference mode.
- `--locale en|ru` localizes the generated index and authored onboarding content; default `en`. Java identifiers and routes are never translated. The generic Viewer controls currently fall back to English for Russian output.
- `--ai` asks an installed and authenticated Codex CLI to inspect the selected Java code in a read-only sandbox. It replaces the generic entry-point card with a purpose summary, ordered implementation steps, notable code-proven behavior, and source evidence. AI mode is opt-in, non-deterministic, and limited to onboarding output with one endpoint per diagram. It does not require a separate Archify API key, but source content may be processed according to the active Codex account and configuration.
- `--ai-model model` optionally selects the Codex model and requires `--ai`; otherwise the configured Codex default is used.
- `--ai-batch-size 1..5` controls how many endpoints share one model request; default `1`, so every endpoint is analyzed independently.
- `--ai-concurrency 1..4` bounds simultaneous Codex processes; default `2`.
- `--ai-reasoning none|low|medium|high|xhigh|max` optionally overrides the configured model reasoning effort.
- `--ai-retries 0..3` repeats only a failed endpoint batch after invalid JSON, incomplete prose, bad evidence, or a process failure; default `2`.
- `--ai-resume` reuses validated endpoint analyses from `<output>.ai-cache`. The cache key includes the selected model, locale, endpoint identity, reasoning effort, and a SHA-256 fingerprint of all repository Java source. A failed run keeps the cache; a successful run removes it after embedding every analysis in `manifest.json`.
- `--json` prints a machine-readable receipt.

AI output is accepted only as structured JSON. Archify verifies that every requested diagram has exactly one analysis and that every cited repository-relative file and line exists. Invalid or incomplete evidence fails the extraction instead of silently producing an ungrounded explanation.

For a large repository, prefer one endpoint per request with bounded concurrency and resumability:

```bash
node bin/archify.mjs extract endpoints \
  --repo-root /path/to/project \
  --output /tmp/endpoint-diagrams \
  --locale ru \
  --ai --ai-model gpt-5.6-luna \
  --ai-batch-size 1 --ai-concurrency 4 --ai-reasoning low \
  --ai-retries 2 --ai-resume
```

Directories named `.git`, `.idea`, `.gradle`, `build`, `target`, `node_modules`, and `out`, plus symbolic links, are skipped. When the type cap omits secondary types, the manifest and index retain an explicit warning.
