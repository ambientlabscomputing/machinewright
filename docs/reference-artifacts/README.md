# Reference artifacts

These files are the graph-native projections of
`machinewright.examples.reference_hardware.SimpleAssembly`. The fixture includes
nested containment plus mechanical, electrical-power, signal, and thermal
connections.

Regenerate from the repository root with:

```bash
uv run machinewright export bundle \
  "assemblies.machinewright.examples.reference_hardware.SimpleAssembly" \
  --module machinewright.examples.reference_hardware \
  --location docs/reference-artifacts
```

Artifact filenames include the canonical hardware-graph digest prefix. A digest
change must be reviewed as a semantic fixture change.
