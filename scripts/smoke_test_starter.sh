#!/usr/bin/env bash
set -euo pipefail

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
release_tag=$(uv run --no-sync python -c 'import tomllib; print("v" + tomllib.load(open("pyproject.toml", "rb"))["project"]["version"])')
uv build --out-dir "$scratch/dist"
wheel=("$scratch"/dist/*.whl)

cd "$scratch"
uv run --no-project --isolated --python 3.13 --with "${wheel[0]}" machinewright project init indexing-table --starter basic
cd indexing-table
test -f .gitignore
if uv run --no-project --isolated --python 3.13 --with "${wheel[0]}" machinewright project init indexing-table --output-dir ..; then
    echo "project init unexpectedly accepted an existing destination" >&2
    exit 1
fi
# Verify the release pin, then exercise the wheel under test in the new project.
uv run --no-project --python 3.13 python - "$release_tag" "${wheel[0]}" <<'PY'
import json
from pathlib import Path
import sys
import tomllib

tag, wheel_path = sys.argv[1:]
project = Path("pyproject.toml")
source = project.read_text()
release = f"machinewright @ git+https://github.com/ambientlabscomputing/machinewright.git@{tag}"
assert tomllib.loads(source)["project"]["dependencies"] == [release]
local_build = f"machinewright @ {Path(wheel_path).resolve().as_uri()}"
project.write_text(source.replace(json.dumps(release), json.dumps(local_build)), encoding="utf-8")
PY
uv sync --python 3.13
uv run --no-sync machinewright project validate
uv run --no-sync machinewright project evaluate indexing-table.main 0.1.0 inputs.json artifacts/ > before.json
uv run --no-sync python - <<'PY'
import json
from pathlib import Path

inputs = Path("inputs.json")
data = json.loads(inputs.read_text())
data["requirements"]["plate_width_mm"] = 60
inputs.write_text(json.dumps(data), encoding="utf-8")
PY
uv run --no-sync machinewright project evaluate indexing-table.main 0.1.0 inputs.json updated/ > after.json
uv run --no-sync python - <<'PY'
import json
from pathlib import Path


def check_evaluation(path: str, expected_width: int) -> None:
    outcome = json.loads(Path(path).read_text())
    artifacts = {item["kind"]: Path(item["path"]) for item in outcome["artifacts"]}
    assert artifacts["step"].is_file()
    assert artifacts["bom_csv"].is_file()
    meshes = outcome["snapshot"]["meshes"]
    assert len(meshes) == 2
    for mesh in meshes:
        bounds = mesh["bounds"]
        assert float(bounds[3]) - float(bounds[0]) == expected_width


check_evaluation("before.json", 40)
check_evaluation("after.json", 60)
PY
