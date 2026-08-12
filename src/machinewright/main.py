import typer

import machinewright.builtins  # noqa: F401
from machinewright.commands.assemblies import assemblies
from machinewright.commands.export import export
from machinewright.commands.objects import objects
from machinewright.discovery import load_modules

app = typer.Typer()
app.add_typer(export, name="export", help="Export commands")
app.add_typer(objects, name="objects", help="Object commands")
app.add_typer(assemblies, name="assemblies", help="Assembly commands")


@app.callback()
def _main(
    module: list[str] = typer.Option(  # noqa: B008 -- idiomatic typer usage
        [],
        "--module",
        "-m",
        help="Additional dotted module path(s) to import for registration, "
        "on top of [tool.machinewright] modules in ./pyproject.toml",
    ),
):
    load_modules(extra=module)


if __name__ == "__main__":
    app()
