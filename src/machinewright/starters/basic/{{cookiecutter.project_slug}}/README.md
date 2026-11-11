# {{ cookiecutter.project_slug }}

This Machinewright design has two printed plates. Both use the width from
`inputs.json`. The cover sits 12 mm above the base.

From this directory, run:

```bash
uv sync
uv run machinewright project validate
uv run machinewright project evaluate {{ cookiecutter.project_slug }}.main 0.1.0 inputs.json artifacts/
```

Open the STEP file in `artifacts/` or open this folder in the Machinewright
macOS app and select `design.py`. Try changing `plate_width_mm` from 40 to 60
and evaluating again into a new output directory. Both plates should widen.
