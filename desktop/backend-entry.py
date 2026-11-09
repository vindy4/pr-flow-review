"""PyInstaller executable entry point; never imports or runs a target repository."""
import json
import sys

from backend.server import main

if __name__ == '__main__':
    if '--self-test' in sys.argv:
        from backend.analyzer import analyze_sources
        from backend.javascript import analyze_javascript
        python = analyze_sources({'a.py': 'def a():\n return 1\n'}, {'a.py': 'def a():\n return 2\n'}, ['a.py'])
        javascript = analyze_javascript({'a.tsx': 'export const App = () => <div/>;'}, {'a.tsx': 'export const App = () => <span/>;'})
        assert python['nodes'] and javascript['nodes']
        print(json.dumps({'ok': True, 'python': len(python['nodes']), 'typescript': len(javascript['nodes'])}))
    else:
        main()
