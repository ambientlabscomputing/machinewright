import typer

from machinewright.commands.assemblies import assemblies
from machinewright.commands.export import export
from machinewright.commands.objects import objects

app = typer.Typer()
app.add_typer(export, name="export", help="Export commands")
app.add_typer(objects, name="objects", help="Object commands")
app.add_typer(assemblies, name="assemblies", help="Assembly commands")

if __name__ == "__main__":
    app()
