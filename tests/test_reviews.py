import json
import hashlib
from pathlib import Path
import tempfile
import unittest

from backend.reviews import ReviewService, ReviewError, patch_lines

BASE='a'*40
HEAD='b'*40
PATCH='@@ -10,3 +10,3 @@\n keep\n-old\n+new\n tail'


class ReviewsTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.calls=[]
        self.head=HEAD
        self.base=BASE
        self.failure=None
        self.files=[{'filename':'new.ts','previous_filename':'old.ts','status':'renamed','patch':PATCH},
                    {'filename':'gone.ts','status':'removed','patch':'@@ -1,2 +0,0 @@\n-one\n-two'}]
        def request(method,path,payload=None):
            self.calls.append((method,path,payload))
            if method=='POST':
                if self.failure:raise self.failure
                return {'id':123,'html_url':'https://github.com/a/b/pull/1#pullrequestreview-123'}
            if '/compare/' in path:return {'merge_base_commit':{'sha':self.base}}
            if '/files?' in path:return self.files
            return {'head':{'sha':self.head},'base':{'sha':'c'*40},'state':'open'}
        self.service=ReviewService(request=request,cache_dir=Path(self.temp.name))
        self.context={'prUrl':'https://github.com/a/b/pull/1','baseSha':BASE,'headSha':HEAD}

    def tearDown(self):self.temp.cleanup()

    def comment(self,**values):return {'path':'old.ts','side':'base','line':11,'body':'Please clarify.',**values}

    def test_patch_context_and_changed_lines_map_to_both_sides(self):
        self.assertEqual(patch_lines(PATCH),([10,11,12],[10,11,12]))
        self.assertEqual(patch_lines('@@ -0,0 +1,2 @@\n+a\n+b'),([],[1,2]))
        self.assertEqual(patch_lines('@@ -2 +2 @@\n-a\n+b\n\\ No newline at end of file'),([2],[2]))

    def test_context_exposes_renamed_and_removed_source_paths(self):
        context=self.service.context(self.context)
        self.assertEqual(context['files'][0],{'path':'new.ts','previousPath':'old.ts','baseLines':[10,11,12],'headLines':[10,11,12]})
        self.assertEqual(context['files'][1]['headLines'],[])

    def test_submit_maps_left_rename_to_canonical_path_and_posts_once(self):
        payload={**self.context,'body':'Review notes','comments':[self.comment()]}
        result=self.service.submit(payload)
        self.assertEqual(result,{'id':123,'url':'https://github.com/a/b/pull/1#pullrequestreview-123'})
        self.assertEqual([c for c in self.calls if c[0]=='POST'],[('POST','repos/a/b/pulls/1/reviews',{'commit_id':HEAD,'event':'COMMENT','body':'Review notes','comments':[{'path':'new.ts','side':'LEFT','line':11,'body':'Please clarify.'}]})])
        self.assertEqual(self.service.submit(payload),result)
        another=ReviewService(request=self.service.request,cache_dir=Path(self.temp.name))
        self.assertEqual(another.submit(payload),result)
        self.assertEqual(sum(c[0]=='POST' for c in self.calls),1)

    def test_removed_file_can_receive_left_comment(self):
        self.service.submit({**self.context,'comments':[self.comment(path='gone.ts',line=2)]})
        self.assertEqual(self.calls[-1][2]['comments'][0]['side'],'LEFT')

    def test_unknown_diff_lines_and_invalid_inputs_never_post(self):
        for changes in [{'line':99},{'line':True},{'side':'wrong'},{'path':'outside.ts'},{'body':' '},{'line':0},{'path':'gone.ts','side':'head','line':1}]:
            with self.subTest(changes=changes),self.assertRaises(ReviewError):
                self.service.submit({**self.context,'comments':[self.comment(**changes)]})
        self.assertFalse(any(c[0]=='POST' for c in self.calls))

    def test_non_string_side_is_a_validation_error_before_github_access(self):
        for side in ([], {}):
            with self.subTest(side=side):
                with self.assertRaises(ReviewError) as error:
                    self.service.submit({**self.context, 'comments':[self.comment(side=side)]})
                self.assertEqual(error.exception.status, 400)
        self.assertEqual(self.calls, [])

    def test_changed_head_rejects_submission_without_writing(self):
        self.head='d'*40
        with self.assertRaises(ReviewError) as error:self.service.submit({**self.context,'comments':[self.comment()]})
        self.assertEqual(error.exception.status,409)
        self.assertIn('Refresh drafts and submit again', str(error.exception))
        self.assertFalse(any(c[0]=='POST' for c in self.calls))

    def test_changed_base_rejects_submission_with_refresh_guidance_without_writing(self):
        self.base='d'*40
        with self.assertRaises(ReviewError) as error:
            self.service.submit({**self.context,'comments':[self.comment()]})
        self.assertEqual(error.exception.status,409)
        self.assertIn('Refresh drafts and submit again', str(error.exception))
        self.assertFalse(any(c[0]=='POST' for c in self.calls))

    def test_permission_error_keeps_submission_retryable(self):
        self.failure=ReviewError('GitHub permission required',403)
        payload={**self.context,'comments':[self.comment()]}
        with self.assertRaises(ReviewError):self.service.submit(payload)
        self.failure=None
        self.assertEqual(self.service.submit(payload)['id'],123)

    def test_ambiguous_write_cannot_be_retried_automatically(self):
        self.failure=ReviewError('Timed out',502,ambiguous=True)
        payload={**self.context,'comments':[self.comment()]}
        with self.assertRaises(ReviewError):self.service.submit(payload)
        self.failure=None
        with self.assertRaises(ReviewError) as error:self.service.submit(payload)
        self.assertEqual(error.exception.status,409)
        self.assertTrue(error.exception.ambiguous)
        self.assertEqual(sum(c[0]=='POST' for c in self.calls),1)


class RefreshReviewsTests(unittest.TestCase):
    """Exercise refresh against immutable Git trees, with no GitHub writes."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.latest_base, self.latest_head, self.base_tip = 'e'*40, 'd'*40, 'c'*40
        self.calls = []
        self.metadata_reads = 0
        self.race = None
        self.state = 'open'
        self.metadata_payload = None
        self.unavailable = set()
        self.base_blob, self.head_blob = '1'*40, '2'*40
        self.snapshots = {
            BASE: {'source.ts': self.base_blob}, HEAD: {'source.ts': self.head_blob},
            self.latest_base: {'source.ts': self.base_blob},
            self.latest_head: {'source.ts': self.head_blob},
        }
        self.files = [{'filename': 'source.ts', 'status': 'modified', 'patch': PATCH}]
        self.original_files = list(self.files)
        self.context = {'prUrl': 'https://github.com/a/b/pull/1', 'baseSha': BASE, 'headSha': HEAD}
        self.service = ReviewService(request=self.request, cache_dir=Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def request(self, method, path, payload=None):
        self.calls.append((method, path, payload))
        if method != 'GET':
            self.fail('Refresh must never write to GitHub')
        if path == 'repos/a/b/pulls/1':
            self.metadata_reads += 1
            if self.metadata_payload is not None:
                return self.metadata_payload
            head, base = self.latest_head, self.base_tip
            if self.metadata_reads > 1 and self.race:
                head, base = self.race
            return {'head': {'sha': head}, 'base': {'sha': base}, 'state': self.state}
        if '/compare/' in path:
            original = path.endswith(f'{BASE}...{HEAD}')
            return {'merge_base_commit': {'sha': BASE if original else self.latest_base},
                'files': self.original_files if original else self.files}
        if '/files?' in path:
            return self.files
        if '/git/commits/' in path:
            ref = path.rsplit('/', 1)[1]
            if ref in self.unavailable:
                raise ReviewError('Commit unavailable', 404)
            if ref not in self.snapshots:
                self.fail(f'Unexpected immutable commit: {ref}')
            return {'tree': {'sha': hashlib.sha1(f'{ref}:'.encode()).hexdigest()}}
        if '/git/trees/' in path:
            tree_id = path.rsplit('/', 1)[1]
            for ref, files in self.snapshots.items():
                prefixes = {''} | {name.rsplit('/', 1)[0] for name in files if '/' in name}
                for prefix in prefixes:
                    if tree_id != hashlib.sha1(f'{ref}:{prefix}'.encode()).hexdigest():
                        continue
                    entries = {}
                    for name, blob in files.items():
                        relative = name.removeprefix(prefix + '/') if prefix else name
                        if prefix and not name.startswith(prefix + '/'):
                            continue
                        part, _, tail = relative.partition('/')
                        mode, sha = ('100644', blob) if isinstance(blob, str) else blob
                        entries[part] = {'path': part, 'type': 'tree' if tail else 'blob',
                            'mode': '040000' if tail else mode,
                            'sha': hashlib.sha1(f'{ref}:{prefix + "/" if prefix else ""}{part}'.encode()).hexdigest() if tail else sha}
                    return {'tree': list(entries.values()), 'truncated': False}
            self.fail(f'Unexpected Git tree: {tree_id}')
        self.fail(f'Unexpected GitHub request: {path}')

    def comment(self, id='draft', **values):
        return {'id': id, 'path': 'source.ts', 'side': 'head', 'line': 11,
            'baseSha': BASE, 'headSha': HEAD, **values}

    def viewed(self, id='viewed', **values):
        return {'id': id, 'path': 'source.ts', 'baseSha': BASE, 'headSha': HEAD, **values}

    def test_refresh_carries_unchanged_whole_file_from_stale_analysis(self):
        result = self.service.refresh({**self.context,
            'comments': [self.comment(), self.comment('before', side='base')], 'reviewed': [self.viewed()]})
        self.assertEqual((result['baseSha'], result['headSha']), (self.latest_base, self.latest_head))
        self.assertEqual(result['files'], [{'path': 'source.ts', 'previousPath': None,
            'baseLines': [10, 11, 12], 'headLines': [10, 11, 12]}])
        self.assertEqual([(item['id'], item['status'], item['path'], item['side'], item['line']) for item in result['comments']],
            [('draft', 'ready', 'source.ts', 'head', 11), ('before', 'ready', 'source.ts', 'base', 11)])
        self.assertEqual([(item['id'], item['status']) for item in result['reviewed']], [('viewed', 'ready')])
        self.assertGreaterEqual(self.metadata_reads, 2)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_changed_content_outside_diff_requires_attention_only_on_that_side(self):
        self.snapshots[self.latest_head]['source.ts'] = '3'*40
        result = self.service.refresh({**self.context, 'comments': [self.comment(), self.comment('before', side='base')],
            'reviewed': [self.viewed()]})
        self.assertEqual([item['status'] for item in result['comments']], ['needs_attention', 'ready'])
        self.assertEqual(result['reviewed'][0]['status'], 'needs_attention')
        self.assertTrue(result['comments'][0]['reason'])

    def test_unchanged_source_without_current_diff_anchor_needs_attention(self):
        self.files[0]['patch'] = '@@ -1 +1 @@\n-old\n+new'
        result = self.service.refresh({**self.context, 'comments': [self.comment()]})
        self.assertEqual(result['comments'][0]['status'], 'needs_attention')

    def test_explicit_rename_returns_side_paths_accepted_by_submit(self):
        for ref in (self.latest_base,):
            self.snapshots[ref] = {'source.ts': self.base_blob}
        self.snapshots[self.latest_head] = {'renamed.ts': self.head_blob}
        self.files = [{'filename': 'renamed.ts', 'previous_filename': 'source.ts', 'status': 'renamed', 'patch': PATCH}]
        result = self.service.refresh({**self.context, 'comments': [self.comment(), self.comment('before', side='base')],
            'reviewed': [self.viewed()]})
        self.assertEqual([(item['status'], item['path']) for item in result['comments']],
            [('ready', 'renamed.ts'), ('ready', 'source.ts')])
        self.assertEqual((result['reviewed'][0]['status'], result['reviewed'][0]['path']), ('ready', 'renamed.ts'))

    def test_viewed_marker_checks_original_rename_on_both_sides(self):
        self.snapshots[BASE] = {'old.ts': self.base_blob}
        self.snapshots[HEAD] = {'source.ts': self.head_blob}
        self.snapshots[self.latest_base] = {'old.ts': self.base_blob}
        self.files = self.original_files = [{'filename': 'source.ts', 'previous_filename': 'old.ts', 'status': 'renamed', 'patch': PATCH}]
        result = self.service.refresh({**self.context, 'reviewed': [self.viewed()]})
        self.assertEqual(result['reviewed'][0]['status'], 'ready')
        self.snapshots[self.latest_base]['old.ts'] = '3'*40
        result = self.service.refresh({**self.context, 'reviewed': [self.viewed()]})
        self.assertEqual(result['reviewed'][0]['status'], 'needs_attention')

    def test_prior_rename_links_to_latest_explicit_rename_without_guessing(self):
        self.snapshots[BASE] = self.snapshots[self.latest_base] = {'old.ts': self.base_blob}
        self.snapshots[HEAD] = {'middle.ts': self.head_blob}
        self.snapshots[self.latest_head] = {'final.ts': self.head_blob}
        self.original_files = [{'filename': 'middle.ts', 'previous_filename': 'old.ts', 'status': 'renamed', 'patch': PATCH}]
        self.files = [{'filename': 'final.ts', 'previous_filename': 'old.ts', 'status': 'renamed', 'patch': PATCH}]
        payload = {**self.context, 'comments': [self.comment(path='middle.ts')], 'reviewed': [self.viewed(path='middle.ts')]}
        result = self.service.refresh(payload)
        self.assertEqual((result['comments'][0]['status'], result['comments'][0]['path']), ('ready', 'final.ts'))
        self.assertEqual((result['reviewed'][0]['status'], result['reviewed'][0]['path']), ('ready', 'final.ts'))
        self.files.append({'filename': 'middle.ts', 'status': 'added', 'patch': PATCH})
        self.snapshots[self.latest_head]['middle.ts'] = self.head_blob
        result = self.service.refresh(payload)
        self.assertEqual(result['comments'][0]['status'], 'needs_attention')
        self.assertEqual(result['reviewed'][0]['status'], 'needs_attention')

    def test_ambiguous_rename_and_reused_path_are_not_guessed(self):
        self.files = [
            {'filename': 'a.ts', 'previous_filename': 'source.ts', 'status': 'renamed', 'patch': PATCH},
            {'filename': 'source.ts', 'status': 'added', 'patch': PATCH},
        ]
        self.snapshots[self.latest_head] = {'a.ts': self.head_blob, 'source.ts': self.head_blob}
        result = self.service.refresh({**self.context, 'comments': [self.comment()], 'reviewed': [self.viewed()]})
        self.assertEqual(result['comments'][0]['status'], 'needs_attention')
        self.assertEqual(result['reviewed'][0]['status'], 'needs_attention')

    def test_unavailable_source_is_per_item_and_does_not_block_other_snapshots(self):
        self.unavailable.add(HEAD)
        result = self.service.refresh({**self.context, 'comments': [self.comment(),
            self.comment('current', baseSha=self.latest_base, headSha=self.latest_head)], 'reviewed': [self.viewed()]})
        self.assertEqual([item['status'] for item in result['comments']], ['needs_attention', 'ready'])
        self.assertEqual(result['reviewed'][0]['status'], 'needs_attention')

    def test_added_and_removed_viewed_files_require_matching_absence(self):
        self.snapshots[BASE] = self.snapshots[self.latest_base] = {'gone.ts': self.base_blob}
        self.snapshots[HEAD] = self.snapshots[self.latest_head] = {'added.ts': self.head_blob}
        self.files = self.original_files = [
            {'filename': 'gone.ts', 'status': 'removed', 'patch': '@@ -1 +0,0 @@\n-old'},
            {'filename': 'added.ts', 'status': 'added', 'patch': '@@ -0,0 +1 @@\n+new'},
        ]
        result = self.service.refresh({**self.context, 'reviewed': [self.viewed('gone', path='gone.ts'), self.viewed('added', path='added.ts')],
            'comments': [self.comment(path='gone.ts', side='base', line=1)]})
        self.assertEqual([item['status'] for item in result['reviewed']], ['ready', 'ready'])
        self.assertEqual(result['comments'][0]['status'], 'ready')

    def test_nonregular_sources_cannot_be_verified_as_file_content(self):
        self.snapshots[self.latest_head]['source.ts'] = ('120000', self.head_blob)
        result = self.service.refresh({**self.context, 'comments': [self.comment()]})
        self.assertEqual(result['comments'][0]['status'], 'needs_attention')

    def test_tip_races_reject_entire_refresh(self):
        for race in (('f'*40, self.base_tip), (self.latest_head, 'f'*40)):
            with self.subTest(race=race):
                self.metadata_reads = 0
                self.race = race
                with self.assertRaises(ReviewError) as error:
                    self.service.refresh({**self.context, 'comments': [self.comment()]})
                self.assertEqual(error.exception.status, 409)

    def test_empty_refresh_loads_latest_context_and_closed_pr_is_rejected(self):
        result = self.service.refresh(self.context)
        self.assertEqual((result['comments'], result['reviewed']), ([], []))
        self.state = 'closed'
        with self.assertRaises(ReviewError) as error:
            self.service.refresh(self.context)
        self.assertEqual(error.exception.status, 409)

    def test_malformed_github_metadata_is_a_gateway_error(self):
        for metadata in ([], {'state': []}, {'state': 'open', 'head': None},
                {'state': 'open', 'head': {'sha': 'main'}, 'base': {'sha': self.base_tip}}):
            with self.subTest(metadata=metadata):
                self.metadata_payload = metadata
                with self.assertRaises(ReviewError) as error:
                    self.service.refresh(self.context)
                self.assertEqual(error.exception.status, 502)

    def test_invalid_items_fail_before_any_github_access(self):
        invalid = [
            {'comments': {}}, {'reviewed': None},
            {'comments': [self.comment(path='../secret')]},
            {'comments': [self.comment(path='/absolute')]},
            {'comments': [self.comment(path='dir\\source.ts')]},
            {'comments': [self.comment(path='dir//source.ts')]},
            {'comments': [self.comment(line=True)]}, {'comments': [self.comment(side=[])]},
            {'comments': [self.comment(baseSha='main')]}, {'comments': [self.comment(id='')]},
            {'comments': [self.comment(), self.comment()]},
            {'reviewed': [self.viewed(headSha='HEAD')]},
        ]
        for changes in invalid:
            with self.subTest(changes=changes):
                with self.assertRaises(ReviewError) as error:
                    self.service.refresh({**self.context, **changes})
                self.assertEqual(error.exception.status, 400)
        self.assertEqual(self.calls, [])
