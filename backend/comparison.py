"""Reconcile proven file moves and unique exact symbol moves across snapshots."""
from collections import defaultdict
import difflib
import hashlib
import re


def reconcile_moves(result, renames=None):
    renames = renames or {}
    nodes = result['nodes']
    removed = [n for n in nodes if n['status'] == 'removed']
    added = [n for n in nodes if n['status'] == 'added']
    pairs, used = [], set()
    for old in removed:
        candidates = [new for new in added if new['id'] not in used
            and renames.get(old['path']) == new['path'] and old['qualname'] == new['qualname']
            and old.get('language') == new.get('language')]
        if len(candidates) == 1:
            new = candidates[0]
            if '<callback:' in old['qualname'] and old['_baseFingerprint'] != new['_headFingerprint']:
                continue
            pairs.append((old, new))
            used.update((old['id'], new['id']))
    # Cross-file moves need an exact structural match and uniqueness on BOTH
    # sides. Equal names or a fuzzy resemblance are not proof of identity.
    before, after = defaultdict(list), defaultdict(list)
    for table, candidates, side in ((before, removed, 'base'), (after, added, 'head')):
        for node in candidates:
            if node['id'] not in used and '<callback:' not in node['qualname']:
                table[(node.get('language'), node['qualname'], node[f'_{side}Fingerprint'])].append(node)
    for key in before.keys() & after.keys():
        if len(before[key]) == len(after[key]) == 1:
            old, new = before[key][0], after[key][0]
            pairs.append((old, new))
            used.update((old['id'], new['id']))
    mapping = {}
    for old, new in pairs:
        mapping[old['id']] = new['id']
        new['baseId'] = old['id']
        new['base'] = old['base']
        new['basePath'] = old['path']
        new['status'] = 'moved' if old['_baseFingerprint'] == new['_headFingerprint'] else 'moved_modified'
        new['diff'] = '\n'.join(difflib.unified_diff(old['base']['code'].splitlines(), new['head']['code'].splitlines(),
            fromfile=f"base/{old['path']}:{old['qualname']}", tofile=f"head/{new['path']}:{new['qualname']}", lineterm='')) if new['status'] == 'moved_modified' else ''
    nodes = result['nodes'] = [n for n in nodes if n['id'] not in mapping]
    for node in nodes:
        node.setdefault('basePath', node['path'] if node['base'] else None)
        node['headPath'] = node['path'] if node['head'] else None
        node.pop('_baseFingerprint', None)
        node.pop('_headFingerprint', None)
    by_id = {n['id']: n for n in nodes}
    if mapping:
        groups = defaultdict(lambda: {'base': [], 'head': []})
        for edge in result['edges']:
            source, target = mapping.get(edge['source'], edge['source']), mapping.get(edge['target'], edge['target'])
            relation = edge.get('relation', 'call')
            for side, present in (('base', 'inBase'), ('head', 'inHead')):
                if edge[present]:
                    expression = edge.get(f'{side}Expression') or edge['expression']
                    callee = '' if relation == 'callback' else re.split(r'\(|\s|>', expression.strip(), 1)[0]
                    key = (source, target, relation, callee)
                    groups[key][side].append((edge[f'{side}Line'], expression))
        result['edges'] = []
        for key, versions in sorted(groups.items()):
            a, b = sorted(versions['base']), sorted(versions['head'])
            source, target, relation, _ = key
            for i in range(max(len(a), len(b))):
                old, new = a[i] if i < len(a) else None, b[i] if i < len(b) else None
                line, expression = new or old
                side = 'head' if new else 'base'
                path = by_id[source][side + 'Path']
                result['edges'].append({'id': 'call:' + hashlib.sha256(repr((key, i)).encode()).hexdigest()[:20],
                    'source': source, 'target': target, 'relation': relation, 'expression': expression, 'line': line,
                    'baseExpression': old[1] if old else None, 'headExpression': new[1] if new else None,
                    'baseLine': old[0] if old else None, 'headLine': new[0] if new else None,
                    'inBase': bool(old), 'inHead': bool(new), 'status': 'unchanged' if old and new else 'added' if new else 'removed',
                    'evidence': {'path': path, 'line': line, 'side': side, 'expression': expression}})
    for edge in result['edges']:
        edge['basePath'] = by_id[edge['source']]['basePath'] if edge['inBase'] else None
        edge['headPath'] = by_id[edge['source']]['headPath'] if edge['inHead'] else None
    return result
