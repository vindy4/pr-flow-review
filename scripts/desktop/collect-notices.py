"""Collect notices for the frozen Python runtime; no application/user data."""
import importlib.metadata
import pathlib
import sys

chunks = ['Python runtime and native parser dependency notices\n']
python_license = pathlib.Path(sys.base_prefix) / 'lib' / f'python{sys.version_info.major}.{sys.version_info.minor}' / 'LICENSE.txt'
chunks.append(python_license.read_text())
for name in ['tree-sitter', 'tree-sitter-javascript', 'tree-sitter-typescript', 'pyinstaller', 'altgraph', 'macholib']:
    distribution = importlib.metadata.distribution(name)
    chunks.append(f'\n{name} {distribution.version}\n')
    for file in distribution.files or []:
        if 'license' in str(file).lower() or 'copying' in str(file).lower():
            chunks.append(distribution.locate_file(file).read_text())
pathlib.Path(sys.argv[1]).write_text('\n\n'.join(chunks))
