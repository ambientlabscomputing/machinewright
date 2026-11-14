---
title: Machinewright documentation
description: Learn to design machines as code with Machinewright.
---

Machinewright is a graph-native hardware-as-code framework. A design declares part and assembly instances, typed ports, containment, transforms and connections. Machinewright resolves that declaration once and projects **CAD, BOMs, print layouts, documentation graphs and artifact manifests** from the same canonical `ResolvedHardwareGraph`.

CadQuery remains the leaf-geometry engine. It is not the assembly model.

## Where to start

| If you want to… | Go to |
| --- | --- |
| Get Machinewright running | [Install](/docs/install/) |
| Make your first design | [Create a starter project](/docs/starter-project/) |
| See what the app can do | [Tour of the macOS app](/docs/app-tour/) |
| Learn by building | [Tutorials](/docs/tutorials/first-assembly/) |
| Look up an API | [Python API reference](/docs/reference/api/parts/) |
| Look up a command | [CLI reference](/docs/reference/cli/) |
| Grab a release | [Downloads](/downloads/) |

## The pieces

- **The Python package** (`machinewright`) provides `PartDefinition`, `AssemblyDefinition`, the resolver, exporters and the `machinewright` CLI.
- **Projects** are ordinary Python folders with a `pyproject.toml` and a `machinewright.toml` that describes the design's templates and input configurations.
- **The macOS app** opens a project folder, edits the source with a language server, and previews the evaluated design in 3D.

The *ironless-actuator* project, a 154-part planetary-geared actuator, is used throughout these docs for screenshots and examples.
