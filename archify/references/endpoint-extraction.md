# Java/Spring endpoint extraction

`archify extract endpoints` creates a directory of validated, controller-grouped class diagrams from local Java source. It is intentionally conservative: it recognizes Spring MVC annotations and follows only project types and field-receiver calls visible in source. It does not claim runtime tracing, framework wiring verification, or a complete Java compiler model.

Each endpoint is rendered as an isolated horizontal scenario lane. Lanes use the same semantic stage order—request DTO, controller, service, implementation/helper, data, response—and intentionally duplicate shared project types. A duplicated card shows only members used by that endpoint, so following one route never requires crossing into another route. Guided Views focus the matching lane. The source manifest maps every scenario-scoped card `id` back to its stable `sourceId` and source location.

```bash
node bin/archify.mjs extract endpoints \
  --repo-root /path/to/project \
  --output /tmp/endpoint-diagrams \
  --scenarios-per-diagram 3 \
  --locale en
```

The output directory must not already exist. A successful run writes:

- `index.html` — links grouped by controller;
- `manifest.json` — options, warnings, controller routes, validation results, and source evidence;
- `diagrams/*.html` — standalone Archify diagrams;
- `sources/*.class-diagram.json` — reproducible typed IR.

## Options

- `--controller Name` selects one simple or fully qualified controller name.
- `--package prefix` limits controllers to a Java package prefix.
- `--exclude fragment` skips matching repository-relative paths; repeat as needed.
- `--relation-depth 1..5` bounds proven field-call traversal; default `2`.
- `--max-types 1..40` bounds duplicated types in each endpoint lane; default `8`.
- `--scenarios-per-diagram 1..5` bounds isolated endpoint lanes and Guided Views per diagram; default `3`.
- `--locale en|ru` localizes the generated index; default `en`. Java identifiers and routes are never translated.
- `--json` prints a machine-readable receipt.

Directories named `.git`, `.idea`, `.gradle`, `build`, `target`, `node_modules`, and `out`, plus symbolic links, are skipped. When the type cap omits secondary types, the manifest and index retain an explicit warning.
