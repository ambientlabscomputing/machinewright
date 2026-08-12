import sys
import types

import pytest
import typer

from machinewright.discovery import _configured_modules, load_modules


def _install_fake_module(name: str):
    module = types.ModuleType(name)
    sys.modules[name] = module
    return module


@pytest.fixture(autouse=True)
def _cleanup_fake_modules():
    before = set(sys.modules)
    try:
        yield
    finally:
        for name in set(sys.modules) - before:
            del sys.modules[name]


def test_configured_modules_empty_when_no_pyproject(tmp_path):
    assert _configured_modules(tmp_path) == []


def test_configured_modules_empty_when_no_tool_section(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'foo'\n")
    assert _configured_modules(tmp_path) == []


def test_configured_modules_reads_tool_machinewright_modules(tmp_path):
    (tmp_path / "pyproject.toml").write_text(
        "[tool.machinewright]\nmodules = ['pkg.a', 'pkg.b']\n"
    )
    assert _configured_modules(tmp_path) == ["pkg.a", "pkg.b"]


def test_load_modules_imports_configured_and_extra(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "pyproject.toml").write_text(
        "[tool.machinewright]\nmodules = ['fake_configured_mod']\n"
    )
    _install_fake_module("fake_configured_mod")
    _install_fake_module("fake_extra_mod")

    imported = []

    import importlib

    def fake_import_module(name):
        imported.append(name)
        return sys.modules[name]

    monkeypatch.setattr(importlib, "import_module", fake_import_module)

    load_modules(extra=["fake_extra_mod"])

    assert imported == ["fake_configured_mod", "fake_extra_mod"]


def test_load_modules_dedupes_extra_already_in_config(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "pyproject.toml").write_text(
        "[tool.machinewright]\nmodules = ['fake_dupe_mod']\n"
    )
    _install_fake_module("fake_dupe_mod")

    load_modules(extra=["fake_dupe_mod"])  # should not raise or double-import


def test_load_modules_exits_nonzero_on_import_failure(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'foo'\n")

    with pytest.raises(typer.Exit) as exc_info:
        load_modules(extra=["this_module_does_not_exist_anywhere"])

    assert exc_info.value.exit_code == 1
