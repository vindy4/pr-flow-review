"""Apply a checked, minimal fail-closed patch to the pinned upstream CLI source."""
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
replacements = {
    'internal/config/config.go': (
        '\tif !secureStorage || setErr != nil {\n\t\t// And set the oauth token under the user for later switching\n\t\tc.cfg.Set([]string{hostsKey, hostname, usersKey, username, oauthTokenKey}, token)\n\t\tinsecureStorageUsed = true\n\t}',
        '\tif !secureStorage || setErr != nil {\n\t\treturn false, fmt.Errorf("PR Flow Review requires secure credential storage; plaintext fallback is disabled")\n\t}',
    ),
    'internal/config/refreshable.go': (
        '\tif !secureStorage || setErr != nil {\n\t\tc.setRefreshableInConfig(hostname, username, credential)\n\t\t_ = keyring.Delete(refreshableServiceName(hostname), username)\n\t\tinsecureStorageUsed = true\n\t}',
        '\tif !secureStorage || setErr != nil {\n\t\treturn false, errors.New("PR Flow Review requires secure credential storage; plaintext fallback is disabled")\n\t}',
    ),
}
for name, (before, after) in replacements.items():
    file = source / name
    text = file.read_text()
    if after in text:
        continue
    if text.count(before) != 1:
        raise SystemExit(f'Pinned CLI source differs at {name}; refusing an unchecked patch')
    file.write_text(text.replace(before, after))
