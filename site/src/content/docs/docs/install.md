---
title: Install
description: Install the Machinewright macOS app and the Python package.
---

Machinewright has two parts you can install independently: the **Python package and CLI**, which run anywhere Python 3.13 runs, and the **macOS app**, an editor and 3D viewer for Apple silicon Macs.

## Requirements

- [uv](https://docs.astral.sh/uv/) for Python environments (`brew install uv`)
- Python 3.13 or newer (uv can install it for you)
- For the app: a Mac with Apple silicon

## Python package and CLI

The recommended route is to let `machinewright project init` create a project that already pins the right release. See [Create a starter project](/docs/starter-project/).

To add Machinewright to an existing project, pin it to a release tag in `pyproject.toml`. Tags are listed on the [downloads page](/downloads/):

```toml
[project]
dependencies = [
  "machinewright @ git+https://github.com/ambientlabscomputing/machinewright.git@v0.2.0",
]
```

Then run `uv sync`. Register the modules that define your parts and assemblies so the CLI can discover them:

```toml
[tool.machinewright]
modules = ["your_package.parts", "your_package.assemblies"]
```

To run the CLI once without a project, use uv's isolated runner:

```bash
uv run --no-project --with "machinewright @ git+https://github.com/ambientlabscomputing/machinewright.git@v0.2.0" machinewright --help
```

## macOS app

1. Open the [downloads page](/downloads/) and download `Machinewright-<version>-macOS-arm64.dmg` for the version you want.
2. Optionally verify it. Download the matching `.sha256` file into the same folder and run:

   ```bash
   shasum -a 256 -c Machinewright-0.2.0-macOS-arm64.dmg.sha256
   ```

3. Open the disk image and drag the app to **Applications**.
4. Control-click the app, choose **Open**, and confirm.

:::note[Why the extra click?]
Release builds are currently ad-hoc signed and not notarized, so Gatekeeper asks you to confirm the first launch. If macOS still refuses to open it, clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/MachinewrightApp.app
```
:::

The app uses your project's own `.venv` for evaluation and for the Python language server, so every project must have run `uv sync` before you open it.

## Build from source

Requires Xcode, CocoaPods, Node.js 24+ and uv.

```bash
git clone git@github.com:ambientlabscomputing/machinewright.git
cd machinewright
make sync
make app-install
make run
```

## Verify the install

```bash
uv run machinewright --help
uv run machinewright objects list
```
