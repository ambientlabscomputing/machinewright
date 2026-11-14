"""Discovery and validation for portable Machinewright Python projects."""

from __future__ import annotations

from pathlib import Path
import tomllib

from pydantic import model_validator

from machinewright.contracts import Contract


class TemplateEntry(Contract):
    id: str
    version: str
    callable: str
    cacheable: bool = False


class GoldenEvaluation(Contract):
    name: str
    template_id: str
    template_version: str
    inputs: str
    expected_graph_digest: str | None = None
    expected_manifest_digest: str | None = None


class ProjectConfig(Contract):
    project_id: str
    environment_lock: str
    templates: tuple[TemplateEntry, ...] = ()
    assets: tuple[str, ...] = ()
    input_configurations: tuple[str, ...] = ()
    golden_evaluations: tuple[GoldenEvaluation, ...] = ()

    @model_validator(mode="after")
    def unique_templates(self) -> "ProjectConfig":
        keys = [(item.id, item.version) for item in self.templates]
        if len(keys) != len(set(keys)):
            raise ValueError("template id/version pairs must be unique")
        return self


def find_project_root(start: Path | None = None) -> Path:
    current = (start or Path.cwd()).resolve()
    for candidate in (current, *current.parents):
        if (candidate / "machinewright.toml").is_file():
            return candidate
    raise FileNotFoundError(
        "no machinewright.toml found in this directory or its parents"
    )


def load_project(root: Path | None = None) -> tuple[Path, ProjectConfig]:
    project_root = find_project_root(root)
    config = ProjectConfig.model_validate(
        tomllib.loads(
            (project_root / "machinewright.toml").read_text(encoding="utf-8")
        ),
        strict=False,
    )
    validate_project_paths(project_root, config)
    return project_root, config


def validate_project_paths(root: Path, config: ProjectConfig) -> None:
    declared = (config.environment_lock, *config.assets, *config.input_configurations)
    for value in declared:
        path = (root / value).resolve()
        if not path.is_relative_to(root.resolve()):
            raise ValueError(f"declared path escapes project root: {value}")
        if not path.exists():
            raise FileNotFoundError(f"declared project path does not exist: {value}")
    for golden in config.golden_evaluations:
        if not (root / golden.inputs).is_file():
            raise FileNotFoundError(
                f"golden input file does not exist: {golden.inputs}"
            )
