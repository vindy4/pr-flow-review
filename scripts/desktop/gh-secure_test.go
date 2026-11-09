// Copied into the pinned CLI source only during the bundled-tool build.
package config

import (
    "errors"
    "testing"
    "time"
    "github.com/cli/cli/v2/internal/gh"
    "github.com/cli/cli/v2/internal/keyring"
    "github.com/stretchr/testify/require"
)

func TestDesktopSecureStorageFailsClosed(t *testing.T) {
    auth := newTestAuthConfig(t)
    keyring.MockInitWithError(errors.New("keychain unavailable"))
    insecure, err := auth.Login("github.com", "desktop-user", "new-secret", "https", true)
    require.Error(t, err)
    require.False(t, insecure)
    requireNoKey(t, auth.cfg, []string{hostsKey, "github.com", oauthTokenKey})
    requireNoKey(t, auth.cfg, []string{hostsKey, "github.com", usersKey, "desktop-user", oauthTokenKey})
}

func TestDesktopInsecureStorageIsDisabled(t *testing.T) {
    auth := newTestAuthConfig(t)
    insecure, err := auth.Login("github.com", "desktop-user", "new-secret", "https", false)
    require.Error(t, err)
    require.False(t, insecure)
    requireNoKey(t, auth.cfg, []string{hostsKey, "github.com", usersKey, "desktop-user", oauthTokenKey})
}

func TestDesktopRefreshableStorageFailsClosed(t *testing.T) {
    auth := newTestAuthConfig(t)
    keyring.MockInitWithError(errors.New("keychain unavailable"))
    expiry := time.Date(2030, 1, 2, 3, 4, 5, 0, time.UTC)
    credential := gh.Credential{Token: "new-access", RefreshToken: "new-refresh",
        ExpiresIn: 3600, ExpiresAt: &expiry, RefreshTokenExpiresIn: 86400, RefreshTokenExpiresAt: &expiry}
    insecure, err := auth.LoginRefreshable("github.com", "desktop-user", credential, "https", true)
    require.Error(t, err)
    require.False(t, insecure)
    _, _, lookupErr := auth.refreshableForUser("github.com", "desktop-user")
    require.Error(t, lookupErr)
}
