"""Collect licenses of modules actually linked into the bundled GitHub CLI."""
import pathlib
import re
import subprocess
import sys

source, output = map(pathlib.Path, sys.argv[1:])
modules = subprocess.check_output(['go', 'list', '-deps', '-f', '{{if .Module}}{{.Module.Dir}}{{end}}', './cmd/gh'], cwd=source, text=True)
goroot = pathlib.Path(subprocess.check_output(['go', 'env', 'GOROOT'], cwd=source, text=True).strip())
chunks = ['Bundled GitHub CLI dependency licenses\n', (goroot / 'LICENSE').read_text()]
for directory in sorted(set(modules.splitlines()) - {''}):
    root = pathlib.Path(directory)
    chunks.append('\nModule: ' + root.name + '\n')
    for file in sorted(root.iterdir()):
        if file.is_file() and re.match(r'^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)', file.name, re.I):
            chunks.append(file.name + '\n' + file.read_text(errors='replace'))
output.write_text('\n\n'.join(chunks))
