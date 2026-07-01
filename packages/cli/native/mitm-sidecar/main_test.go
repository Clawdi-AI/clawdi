package main

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadProfilesValidatesAndSorts(t *testing.T) {
	path := writeTestJSON(t, `{
		"schemaVersion": "clawdi.mitmProfiles.v1",
		"generatedAt": "2026-06-05T00:00:00Z",
		"generation": 7,
		"instanceId": "iid_test",
		"profiles": [
			{
				"id": "disabled",
				"enabled": false,
				"kind": "http",
				"match": { "scheme": "https", "host": "discord.com", "pathPrefix": "/api/" },
				"rewrite": { "upstreamBaseUrl": "https://router.test/discord" },
				"priority": 1
			},
			{
				"id": "later",
				"enabled": true,
				"kind": "http",
				"match": { "scheme": "https", "host": "api.telegram.org", "pathPrefix": "/" },
				"rewrite": { "upstreamBaseUrl": "https://router.test/telegram" },
				"priority": 50
			},
			{
				"id": "default-priority",
				"enabled": true,
				"kind": "http",
				"match": { "scheme": "https", "host": "discord.com", "pathPrefix": "/api/" },
				"rewrite": { "upstreamBaseUrl": "https://router.test/discord" }
			}
		]
	}`)

	profiles, err := loadProfiles(path)
	if err != nil {
		t.Fatalf("loadProfiles failed: %v", err)
	}
	if len(profiles) != 2 {
		t.Fatalf("expected 2 enabled profiles, got %d", len(profiles))
	}
	if profiles[0].ID != "later" || profiles[1].ID != "default-priority" {
		t.Fatalf("profiles not sorted by priority: %#v", []string{profiles[0].ID, profiles[1].ID})
	}
	if profiles[1].Priority != 100 {
		t.Fatalf("expected default priority 100, got %d", profiles[1].Priority)
	}
}

func TestLoadProfilesRejectsTrailingDataAndUnknownFields(t *testing.T) {
	valid := `{
		"schemaVersion": "clawdi.mitmProfiles.v1",
		"generatedAt": "2026-06-05T00:00:00Z",
		"generation": 1,
		"instanceId": "iid_test",
		"profiles": []
	}`
	if _, err := loadProfiles(writeTestJSON(t, valid+`{}`)); err == nil {
		t.Fatal("expected trailing data rejection")
	}
	if _, err := loadProfiles(writeTestJSON(t, `{
		"schemaVersion": "clawdi.mitmProfiles.v1",
		"generatedAt": "2026-06-05T00:00:00Z",
		"generation": 1,
		"instanceId": "iid_test",
		"profiles": [],
		"extra": true
	}`)); err == nil {
		t.Fatal("expected unknown field rejection")
	}
}

func TestValidateProfileRejectsUnsafeRewrite(t *testing.T) {
	err := validateProfile(profile{
		ID:   "bad-upstream",
		Kind: "http",
		Match: profileMatch{
			Scheme:     "https",
			Host:       "discord.com",
			PathPrefix: "/api/",
		},
		Rewrite: rewriteRule{UpstreamBaseURL: "secret://router/url"},
	})
	if err == nil {
		t.Fatal("expected non-http upstream rejection")
	}

	err = validateProfile(profile{
		ID:   "credentialed-upstream",
		Kind: "http",
		Match: profileMatch{
			Scheme:     "https",
			Host:       "discord.com",
			PathPrefix: "/api/",
		},
		Rewrite: rewriteRule{UpstreamBaseURL: "https://user:pass@router.test/discord"},
	})
	if err == nil || !strings.Contains(err.Error(), "must not include credentials") {
		t.Fatalf("expected credentialed upstream rejection, got %v", err)
	}

	err = validateProfile(profile{
		ID:   "unsafe-upstream-host",
		Kind: "http",
		Match: profileMatch{
			Scheme:     "https",
			Host:       "discord.com",
			PathPrefix: "/api/",
		},
		Rewrite: rewriteRule{UpstreamBaseURL: "https://.router.test/discord"},
	})
	if err == nil || !strings.Contains(err.Error(), "invalid host") {
		t.Fatalf("expected unsafe upstream host rejection, got %v", err)
	}

	err = validateProfile(profile{
		ID:   "deny-with-upstream",
		Kind: "deny",
		Match: profileMatch{
			Scheme: "https",
			Host:   "169.254.169.254",
		},
		Rewrite: rewriteRule{UpstreamBaseURL: "https://router.test/"},
	})
	if err == nil {
		t.Fatal("expected deny rewrite rejection")
	}

	preserve := true
	err = validateProfile(profile{
		ID:   "deny-with-rewrite-rules",
		Kind: "deny",
		Match: profileMatch{
			Scheme: "https",
			Host:   "169.254.169.254",
		},
		Rewrite: rewriteRule{PreservePath: &preserve},
	})
	if err == nil {
		t.Fatal("expected deny rewrite rule rejection")
	}
}

func TestResponseHeaderStrippingMatchesCredentialSidecarPolicy(t *testing.T) {
	if !shouldStripResponseHeader("Connection") {
		t.Fatalf("expected Connection to be stripped through hop-by-hop check")
	}
	if !shouldStripResponseHeader("Transfer-Encoding") {
		t.Fatalf("expected Transfer-Encoding to be stripped")
	}
	if !shouldStripResponseHeader("Set-Cookie") {
		t.Fatalf("expected Set-Cookie to be stripped")
	}
	if shouldStripResponseHeader("X-Request-Id") {
		t.Fatalf("expected end-to-end response headers to be preserved")
	}
}

func TestCopyForwardHeadersStripsProxyScopedAndHopByHopHeaders(t *testing.T) {
	src := http.Header{}
	src.Set("Authorization", "Bot managed-token")
	src.Set("Cookie", "session=abc")
	src.Set("Connection", "X-Custom-Hop, close")
	src.Set("X-Custom-Hop", "must-not-forward")
	src.Set("Proxy-Authorization", "Basic scoped-token")
	src.Set("Proxy-Connection", "keep-alive")
	src.Set("Transfer-Encoding", "chunked")
	src.Set("X-Trace-Id", "trace-1")

	dst := http.Header{}
	copyForwardHeaders(src, dst)

	if dst.Get("Authorization") != "Bot managed-token" {
		t.Fatalf("Authorization should pass through for profile matching, got %q", dst.Get("Authorization"))
	}
	if dst.Get("Cookie") != "session=abc" {
		t.Fatalf("Cookie should pass through to the upstream request, got %q", dst.Get("Cookie"))
	}
	for _, header := range []string{
		"Connection",
		"X-Custom-Hop",
		"Proxy-Authorization",
		"Proxy-Connection",
		"Transfer-Encoding",
	} {
		if got := dst.Get(header); got != "" {
			t.Fatalf("%s should be stripped, got %q", header, got)
		}
	}
	if dst.Get("X-Trace-Id") != "trace-1" {
		t.Fatalf("X-Trace-Id should pass through, got %q", dst.Get("X-Trace-Id"))
	}
}

func TestValidateProfileRejectsSchemaMismatches(t *testing.T) {
	base := profile{
		ID:   "discord-rest",
		Kind: "http",
		Match: profileMatch{
			Scheme:     "https",
			Host:       "discord.com",
			PathPrefix: "/api/",
		},
		Rewrite: rewriteRule{UpstreamBaseURL: "https://router.test/discord"},
	}
	tests := []struct {
		name    string
		mutate  func(*profile)
		wantErr string
	}{
		{
			name: "invalid profile id",
			mutate: func(p *profile) {
				p.ID = "Discord REST"
			},
			wantErr: "must match",
		},
		{
			name: "invalid header matcher name",
			mutate: func(p *profile) {
				p.Match.Headers = map[string]headerMatcher{
					"bad header": {Type: "exists"},
				}
			},
			wantErr: "invalid header matcher name",
		},
		{
			name: "invalid rewrite header name",
			mutate: func(p *profile) {
				p.Rewrite.SetHeaders = map[string]headerSetter{
					"bad header": {Type: "literal", Value: "value"},
				}
			},
			wantErr: "invalid rewrite.setHeaders name",
		},
		{
			name: "invalid rewrite header secret ref",
			mutate: func(p *profile) {
				p.Rewrite.SetHeaders = map[string]headerSetter{
					"authorization": {Type: "secretRef", SecretRef: "provider.default.apiKey"},
				}
			},
			wantErr: "must use a secret:// ref",
		},
		{
			name: "exists matcher with extra fields",
			mutate: func(p *profile) {
				p.Match.Headers = map[string]headerMatcher{
					"authorization": {Type: "exists", Value: "unexpected"},
				}
			},
			wantErr: "exists must not set",
		},
		{
			name: "equals matcher with secret ref",
			mutate: func(p *profile) {
				p.Match.Headers = map[string]headerMatcher{
					"authorization": {
						Type:      "equals",
						Value:     "public",
						SecretRef: "secret://discord/token",
					},
				}
			},
			wantErr: "equals must not set secretRef",
		},
		{
			name: "secret matcher with public value",
			mutate: func(p *profile) {
				p.Match.Headers = map[string]headerMatcher{
					"authorization": {
						Type:      "secretRefEquals",
						SecretRef: "secret://discord/token",
						Value:     "public",
					},
				}
			},
			wantErr: "secretRefEquals must not set value",
		},
		{
			name: "path prefix matcher with secret ref",
			mutate: func(p *profile) {
				p.Match.Path = pathMatcher{
					Type:      "prefix",
					Value:     "/api/",
					SecretRef: "secret://path/token",
				}
			},
			wantErr: "must not set secretRef",
		},
		{
			name: "secret path matcher with public value",
			mutate: func(p *profile) {
				p.Match.Path = pathMatcher{
					Type:      "secretRefPrefix",
					SecretRef: "secret://path/token",
					Value:     "/api/",
				}
			},
			wantErr: "must not set value",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := base
			tt.mutate(&p)
			err := validateProfile(p)
			if err == nil {
				t.Fatal("expected validation error")
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("expected error containing %q, got %q", tt.wantErr, err.Error())
			}
		})
	}
}

func TestMatchRouteUsesSecretRefGates(t *testing.T) {
	proxy := proxyServer{
		secrets: map[string]string{
			"secret://discord/token":  "discord-token",
			"secret://telegram/token": "telegram-token",
			"secret://imessage/token": "imessage-token",
		},
		profiles: []profile{
			{
				ID:   "discord-rest",
				Kind: "http",
				Match: profileMatch{
					Scheme: "https",
					Host:   "discord.com",
					Headers: map[string]headerMatcher{
						"authorization": {
							Type:      "secretRefEquals",
							SecretRef: "secret://discord/token",
							Prefix:    "Bot ",
						},
					},
				},
				Rewrite: rewriteRule{UpstreamBaseURL: "https://router.test/discord"},
			},
			{
				ID:   "telegram-bot-api",
				Kind: "http",
				Match: profileMatch{
					Scheme: "https",
					Host:   "api.telegram.org",
					Path: pathMatcher{
						Type:      "secretRefPrefix",
						SecretRef: "secret://telegram/token",
						Prefix:    "/bot",
						Suffix:    "/",
					},
				},
				Rewrite: rewriteRule{UpstreamBaseURL: "https://router.test/telegram"},
			},
			{
				ID:   "bluebubbles-rest",
				Kind: "http",
				Match: profileMatch{
					Scheme: "https",
					Host:   "bluebubbles.invalid",
					Query: map[string]headerMatcher{
						"password": {
							Type:      "secretRefEquals",
							SecretRef: "secret://imessage/token",
						},
					},
				},
				Rewrite: rewriteRule{UpstreamBaseURL: "https://router.test/imessage"},
			},
		},
	}

	headers := http.Header{}
	headers.Set("Authorization", "Bot discord-token")
	if route := proxy.matchRoute("discord.com", "https", "/api/v10/users/@me", "", headers); route == nil || route.profile.ID != "discord-rest" {
		t.Fatalf("expected discord route, got %#v", route)
	}
	headers.Set("Authorization", "Bot wrong")
	if route := proxy.matchRoute("discord.com", "https", "/api/v10/users/@me", "", headers); route != nil {
		t.Fatalf("expected discord route denial, got %#v", route.profile.ID)
	}
	if route := proxy.matchRoute("api.telegram.org", "https", "/bottelegram-token/getMe", "", http.Header{}); route == nil || route.profile.ID != "telegram-bot-api" {
		t.Fatalf("expected telegram route, got %#v", route)
	}
	if route := proxy.matchRoute("api.telegram.org", "https", "/botwrong/getMe", "", http.Header{}); route != nil {
		t.Fatalf("expected telegram route denial, got %#v", route.profile.ID)
	}
	if route := proxy.matchRoute("bluebubbles.invalid", "https", "/api/v1/ping", "password=imessage-token", http.Header{}); route == nil || route.profile.ID != "bluebubbles-rest" {
		t.Fatalf("expected bluebubbles route, got %#v", route)
	}
	if route := proxy.matchRoute("bluebubbles.invalid", "https", "/api/v1/ping", "password=wrong", http.Header{}); route != nil {
		t.Fatalf("expected bluebubbles route denial, got %#v", route.profile.ID)
	}
}

func TestRewritePathPreservesBaseAndQueries(t *testing.T) {
	upstream := mustParseURL(t, "https://router.test/base?tenant=abc")
	path, query := rewritePath(upstream, "/api/v1/ping?password=secret", true)
	if path != "/base/api/v1/ping" {
		t.Fatalf("unexpected path %q", path)
	}
	if query != "tenant=abc&password=secret" {
		t.Fatalf("unexpected query %q", query)
	}

	path, query = rewritePath(mustParseURL(t, "https://router.test/fixed?tenant=abc"), "/ignored?x=1", false)
	if path != "/fixed" || query != "tenant=abc" {
		t.Fatalf("unexpected non-preserve rewrite path=%q query=%q", path, query)
	}
}

func TestValidateProfileAcceptsPassthroughWithoutRewrite(t *testing.T) {
	err := validateProfile(profile{
		ID:   "local-passthrough",
		Kind: "passthrough",
		Match: profileMatch{
			Scheme:     "http",
			Host:       "example.com",
			PathPrefix: "/",
		},
	})
	if err != nil {
		t.Fatalf("expected passthrough profile to be accepted, got %v", err)
	}

	err = validateProfile(profile{
		ID:   "bad-passthrough",
		Kind: "passthrough",
		Match: profileMatch{
			Scheme:     "http",
			Host:       "example.com",
			PathPrefix: "/",
		},
		Rewrite: rewriteRule{UpstreamBaseURL: "https://router.test"},
	})
	if err == nil || !strings.Contains(err.Error(), "passthrough profiles must not set") {
		t.Fatalf("expected passthrough rewrite rejection, got %v", err)
	}
}

func TestMatchRoutePrefersManagedRewriteBeforePassthrough(t *testing.T) {
	proxy := proxyServer{
		profiles: []profile{
			{
				ID:       "managed",
				Kind:     "provider",
				Priority: 100,
				Match: profileMatch{
					Scheme:     "https",
					Host:       "api.openai.com",
					PathPrefix: "/v1/",
					Headers: map[string]headerMatcher{
						"authorization": {
							Type:   "equals",
							Value:  "clawdi-mitm-placeholder",
							Prefix: "Bearer ",
						},
					},
				},
				Rewrite: rewriteRule{UpstreamBaseURL: "https://router.test/responses"},
			},
			{
				ID:       "byo",
				Kind:     "passthrough",
				Priority: 200,
				Match: profileMatch{
					Scheme:     "https",
					Host:       "api.openai.com",
					PathPrefix: "/",
				},
			},
		},
	}

	headers := http.Header{}
	headers.Set("Authorization", "Bearer clawdi-mitm-placeholder")
	if route := proxy.matchRoute("api.openai.com", "https", "/v1/responses", "", headers); route == nil || route.profile.ID != "managed" {
		t.Fatalf("expected managed route, got %#v", route)
	}
	headers.Set("Authorization", "Bearer sk-user-byo")
	if route := proxy.matchRoute("api.openai.com", "https", "/v1/responses", "", headers); route == nil || route.profile.ID != "byo" {
		t.Fatalf("expected BYO passthrough route, got %#v", route)
	}
}

func TestTargetNormalizationPreservesNonDefaultPorts(t *testing.T) {
	target, matchHost, tlsHost, err := targetFromConnect("example.com:8443")
	if err != nil {
		t.Fatalf("targetFromConnect failed: %v", err)
	}
	if target != "example.com:8443" || matchHost != "example.com:8443" || tlsHost != "example.com" {
		t.Fatalf("unexpected non-default target=%q matchHost=%q tlsHost=%q", target, matchHost, tlsHost)
	}

	target, matchHost, tlsHost, err = targetFromConnect("example.com:443")
	if err != nil {
		t.Fatalf("targetFromConnect default port failed: %v", err)
	}
	if target != "example.com:443" || matchHost != "example.com" || tlsHost != "example.com" {
		t.Fatalf("unexpected default target=%q matchHost=%q tlsHost=%q", target, matchHost, tlsHost)
	}

	absolute := mustParseURL(t, "http://127.0.0.1:18080/path")
	target, matchHost, err = targetFromURL(absolute)
	if err != nil {
		t.Fatalf("targetFromURL failed: %v", err)
	}
	if target != "127.0.0.1:18080" || matchHost != "127.0.0.1:18080" {
		t.Fatalf("unexpected absolute target=%q matchHost=%q", target, matchHost)
	}
}

func TestListenProxyLoopbackPolicy(t *testing.T) {
	if _, _, err := listenProxy("http://0.0.0.0:0", false); err == nil {
		t.Fatal("expected non-loopback listener rejection")
	}
	listener, actual, err := listenProxy("http://127.0.0.1:0", false)
	if err != nil {
		t.Fatalf("loopback listener failed: %v", err)
	}
	defer listener.Close()
	if actual == "" {
		t.Fatal("expected actual proxy URL")
	}
}

func TestCertificateAuthorityPersistsAcrossSidecarRestarts(t *testing.T) {
	caFile := filepath.Join(t.TempDir(), "ca.pem")
	first, err := loadOrCreateCertificateAuthority(caFile)
	if err != nil {
		t.Fatalf("create CA: %v", err)
	}
	second, err := loadOrCreateCertificateAuthority(caFile)
	if err != nil {
		t.Fatalf("load CA: %v", err)
	}
	if string(first.rootPEM) != string(second.rootPEM) {
		t.Fatal("expected CA certificate to be reused")
	}
	keyInfo, err := os.Stat(caFile + ".key")
	if err != nil {
		t.Fatalf("stat CA key: %v", err)
	}
	if keyInfo.Mode().Perm() != 0o600 {
		t.Fatalf("expected CA key mode 0600, got %o", keyInfo.Mode().Perm())
	}
	certInfo, err := os.Stat(caFile)
	if err != nil {
		t.Fatalf("stat CA cert: %v", err)
	}
	if certInfo.Mode().Perm() != 0o644 {
		t.Fatalf("expected CA cert mode 0644, got %o", certInfo.Mode().Perm())
	}
}

func writeTestJSON(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "profiles.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write test JSON: %v", err)
	}
	return path
}

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse URL %q: %v", raw, err)
	}
	return u
}
