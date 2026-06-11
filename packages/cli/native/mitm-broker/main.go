package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type profileBundle struct {
	SchemaVersion string    `json:"schemaVersion"`
	GeneratedAt   string    `json:"generatedAt"`
	Generation    int       `json:"generation"`
	InstanceID    string    `json:"instanceId"`
	Profiles      []profile `json:"profiles"`
}

type profile struct {
	ID          string       `json:"id"`
	Enabled     *bool        `json:"enabled"`
	Kind        string       `json:"kind"`
	Match       profileMatch `json:"match"`
	Rewrite     rewriteRule  `json:"rewrite"`
	Logging     loggingRule  `json:"logging"`
	Priority    int          `json:"priority"`
	Owner       string       `json:"owner"`
	Description string       `json:"description"`
}

type profileMatch struct {
	Scheme     string                   `json:"scheme"`
	Host       string                   `json:"host"`
	PathPrefix string                   `json:"pathPrefix"`
	Path       pathMatcher              `json:"path"`
	Headers    map[string]headerMatcher `json:"headers"`
	Query      map[string]headerMatcher `json:"query"`
}

type pathMatcher struct {
	Type      string `json:"type"`
	Value     string `json:"value"`
	SecretRef string `json:"secretRef"`
	Prefix    string `json:"prefix"`
	Suffix    string `json:"suffix"`
}

type headerMatcher struct {
	Type      string `json:"type"`
	Value     string `json:"value"`
	SecretRef string `json:"secretRef"`
	Prefix    string `json:"prefix"`
}

type rewriteRule struct {
	UpstreamBaseURL string                  `json:"upstreamBaseUrl"`
	PreservePath    *bool                   `json:"preservePath"`
	SetHeaders      map[string]headerSetter `json:"setHeaders"`
}

type headerSetter struct {
	Type      string `json:"type"`
	Value     string `json:"value"`
	SecretRef string `json:"secretRef"`
	Prefix    string `json:"prefix"`
}

type loggingRule struct {
	RedactHeaders     []string `json:"redactHeaders"`
	RedactURLPatterns []string `json:"redactUrlPatterns"`
}

type secretFile struct {
	Secrets map[string]string `json:"secrets"`
}

type route struct {
	profile      profile
	originalHost string
}

type proxyServer struct {
	profiles  []profile
	secrets   map[string]string
	ca        *certificateAuthority
	transport *http.Transport
}

func main() {
	var profileBundlePath string
	var proxyURL string
	var caFile string
	var secretPath string
	var allowRemoteProxy bool

	flag.StringVar(&profileBundlePath, "profile-bundle", "", "Path to the Clawdi MITM profile bundle JSON.")
	flag.StringVar(&proxyURL, "proxy-url", "http://127.0.0.1:0", "HTTP proxy listen URL.")
	flag.StringVar(&caFile, "ca-file", "", "Path where the generated CA PEM should be written.")
	flag.StringVar(&secretPath, "secret-file", "", "Path to the short-lived Clawdi MITM secret map JSON.")
	flag.BoolVar(&allowRemoteProxy, "allow-remote-proxy", false, "Allow the proxy to listen on a non-loopback interface.")
	flag.Parse()

	if profileBundlePath == "" {
		exitf("--profile-bundle is required")
	}
	if caFile == "" {
		exitf("--ca-file is required")
	}

	profiles, err := loadProfiles(profileBundlePath)
	if err != nil {
		exitf("load profile bundle: %v", err)
	}
	if len(profiles) == 0 {
		ready(false, "", "", "no-enabled-profiles")
		return
	}
	secrets, err := loadSecrets(secretPath)
	if err != nil {
		exitf("load secrets: %v", err)
	}
	ca, err := newCertificateAuthority()
	if err != nil {
		exitf("create CA: %v", err)
	}
	if err := writePrivateFile(caFile, ca.rootPEM, 0o644); err != nil {
		exitf("write CA: %v", err)
	}

	listener, actualProxyURL, err := listenProxy(proxyURL, allowRemoteProxy)
	if err != nil {
		exitf("listen proxy: %v", err)
	}

	proxy := &proxyServer{
		profiles: profiles,
		secrets:  secrets,
		ca:       ca,
		transport: &http.Transport{
			Proxy:                 nil,
			ForceAttemptHTTP2:     false,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 5 * time.Minute,
			IdleConnTimeout:       90 * time.Second,
			MaxIdleConns:          100,
			TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
		},
	}

	server := &http.Server{
		Handler:           http.HandlerFunc(proxy.dispatch),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errs := make(chan error, 1)
	go func() {
		errs <- server.Serve(listener)
	}()

	ready(true, actualProxyURL, caFile, "")

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)

	select {
	case sig := <-signals:
		_ = sig
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	case err := <-errs:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			exitf("proxy server: %v", err)
		}
	}
}

func loadProfiles(path string) ([]profile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var bundle profileBundle
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&bundle); err != nil {
		return nil, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, fmt.Errorf("profile bundle has trailing data")
	}
	if bundle.SchemaVersion != "clawdi.mitmProfiles.v1" {
		return nil, fmt.Errorf("unsupported profile bundle schemaVersion %q", bundle.SchemaVersion)
	}
	if strings.TrimSpace(bundle.GeneratedAt) == "" {
		return nil, fmt.Errorf("profile bundle generatedAt is required")
	}
	if bundle.Generation < 0 {
		return nil, fmt.Errorf("profile bundle generation must be non-negative")
	}
	if strings.TrimSpace(bundle.InstanceID) == "" {
		return nil, fmt.Errorf("profile bundle instanceId is required")
	}
	profiles := make([]profile, 0, len(bundle.Profiles))
	for _, p := range bundle.Profiles {
		if p.Enabled != nil && !*p.Enabled {
			continue
		}
		if err := validateProfile(p); err != nil {
			return nil, err
		}
		if p.Priority == 0 {
			p.Priority = 100
		}
		profiles = append(profiles, p)
	}
	sort.SliceStable(profiles, func(i, j int) bool {
		return profiles[i].Priority < profiles[j].Priority
	})
	return profiles, nil
}

func validateProfile(p profile) error {
	if !isProfileID(p.ID) {
		return fmt.Errorf("profile id %q must match ^[a-z0-9][a-z0-9-_.]*$", p.ID)
	}
	switch p.Kind {
	case "http", "websocket", "provider", "passthrough", "deny":
	default:
		return fmt.Errorf("profile %s has unsupported kind %q", p.ID, p.Kind)
	}
	if !isSafeHost(normalizeHost(p.Match.Host)) {
		return fmt.Errorf("profile %s has invalid match.host", p.ID)
	}
	if p.Match.Scheme != "" {
		switch p.Match.Scheme {
		case "http", "https", "ws", "wss":
		default:
			return fmt.Errorf("profile %s has unsupported match.scheme %q", p.ID, p.Match.Scheme)
		}
	}
	if p.Match.PathPrefix != "" && !strings.HasPrefix(p.Match.PathPrefix, "/") {
		return fmt.Errorf("profile %s match.pathPrefix must start with /", p.ID)
	}
	if err := validatePathMatcher(p.ID, p.Match.Path); err != nil {
		return err
	}
	for name, matcher := range p.Match.Headers {
		if !isHeaderName(name) {
			return fmt.Errorf("profile %s has invalid header matcher name %q", p.ID, name)
		}
		if err := validateMatcher(p.ID, "header", name, matcher); err != nil {
			return err
		}
	}
	for name, matcher := range p.Match.Query {
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("profile %s has an empty query matcher name", p.ID)
		}
		if err := validateMatcher(p.ID, "query", name, matcher); err != nil {
			return err
		}
	}
	if p.Kind == "deny" {
		if p.Rewrite.UpstreamBaseURL != "" {
			return fmt.Errorf("profile %s deny profiles must not set rewrite.upstreamBaseUrl", p.ID)
		}
		if p.Rewrite.PreservePath != nil || len(p.Rewrite.SetHeaders) > 0 {
			return fmt.Errorf("profile %s deny profiles must not set rewrite rules", p.ID)
		}
		return nil
	}
	if p.Kind == "passthrough" {
		if p.Rewrite.UpstreamBaseURL != "" {
			return fmt.Errorf("profile %s passthrough profiles must not set rewrite.upstreamBaseUrl", p.ID)
		}
		if p.Rewrite.PreservePath != nil || len(p.Rewrite.SetHeaders) > 0 {
			return fmt.Errorf("profile %s passthrough profiles must not set rewrite rules", p.ID)
		}
		return nil
	}
	if p.Rewrite.UpstreamBaseURL == "" {
		return fmt.Errorf("profile %s requires rewrite.upstreamBaseUrl", p.ID)
	}
	if err := validateUpstreamURL(p.ID, p.Rewrite.UpstreamBaseURL); err != nil {
		return err
	}
	for name := range p.Rewrite.SetHeaders {
		if !isHeaderName(name) {
			return fmt.Errorf("profile %s has invalid rewrite.setHeaders name %q", p.ID, name)
		}
		if err := validateHeaderSetter(p.ID, name, p.Rewrite.SetHeaders[name]); err != nil {
			return err
		}
	}
	for _, name := range p.Logging.RedactHeaders {
		if !isHeaderName(name) {
			return fmt.Errorf("profile %s has invalid logging.redactHeaders name %q", p.ID, name)
		}
	}
	for _, pattern := range p.Logging.RedactURLPatterns {
		if strings.TrimSpace(pattern) == "" {
			return fmt.Errorf("profile %s logging.redactUrlPatterns entries must be non-empty", p.ID)
		}
	}
	return nil
}

func (s *headerSetter) UnmarshalJSON(data []byte) error {
	var literal string
	if err := json.Unmarshal(data, &literal); err == nil {
		s.Type = "literal"
		s.Value = literal
		return nil
	}

	type headerSetterObject headerSetter
	var object headerSetterObject
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&object); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("header setter has trailing data")
	}
	*s = headerSetter(object)
	return nil
}

func validateHeaderSetter(profileID, name string, setter headerSetter) error {
	switch setter.Type {
	case "literal":
		if setter.SecretRef != "" || setter.Prefix != "" {
			return fmt.Errorf("profile %s rewrite.setHeaders %s literal must not set secretRef or prefix", profileID, name)
		}
	case "secretRef":
		if !strings.HasPrefix(setter.SecretRef, "secret://") {
			return fmt.Errorf("profile %s rewrite.setHeaders %s must use a secret:// ref", profileID, name)
		}
		if setter.Value != "" {
			return fmt.Errorf("profile %s rewrite.setHeaders %s secretRef must not set value", profileID, name)
		}
	default:
		return fmt.Errorf("profile %s rewrite.setHeaders %s has unsupported type %q", profileID, name, setter.Type)
	}
	return nil
}

func (s headerSetter) resolve(secrets map[string]string) (string, bool) {
	switch s.Type {
	case "literal":
		return s.Value, true
	case "secretRef":
		secret, ok := secrets[s.SecretRef]
		if !ok {
			return "", false
		}
		return s.Prefix + secret, true
	default:
		return "", false
	}
}

func validateMatcher(profileID, scope, name string, matcher headerMatcher) error {
	switch matcher.Type {
	case "exists":
		if matcher.Value != "" || matcher.SecretRef != "" || matcher.Prefix != "" {
			return fmt.Errorf("profile %s %s matcher %s exists must not set value, secretRef, or prefix", profileID, scope, name)
		}
	case "equals":
		if matcher.SecretRef != "" {
			return fmt.Errorf("profile %s %s matcher %s equals must not set secretRef", profileID, scope, name)
		}
	case "secretRefEquals":
		if !strings.HasPrefix(matcher.SecretRef, "secret://") {
			return fmt.Errorf("profile %s %s matcher %s must use a secret:// ref", profileID, scope, name)
		}
		if matcher.Value != "" {
			return fmt.Errorf("profile %s %s matcher %s secretRefEquals must not set value", profileID, scope, name)
		}
	default:
		return fmt.Errorf("profile %s %s matcher %s has unsupported type %q", profileID, scope, name, matcher.Type)
	}
	return nil
}

func validateUpstreamURL(profileID, rawURL string) error {
	upstream, err := url.Parse(rawURL)
	if err != nil || upstream.Scheme == "" || upstream.Host == "" {
		return fmt.Errorf("profile %s has invalid rewrite.upstreamBaseUrl", profileID)
	}
	switch upstream.Scheme {
	case "http", "https", "ws", "wss":
	default:
		return fmt.Errorf("profile %s rewrite.upstreamBaseUrl must use http, https, ws, or wss", profileID)
	}
	if upstream.User != nil {
		return fmt.Errorf("profile %s rewrite.upstreamBaseUrl must not include credentials", profileID)
	}
	if !isSafeHost(normalizeHost(upstream.Hostname())) {
		return fmt.Errorf("profile %s rewrite.upstreamBaseUrl has invalid host", profileID)
	}
	return nil
}

func validatePathMatcher(profileID string, matcher pathMatcher) error {
	if matcher.Type == "" {
		return nil
	}
	switch matcher.Type {
	case "equals", "prefix":
		if matcher.Value == "" {
			return fmt.Errorf("profile %s path matcher requires value", profileID)
		}
		if matcher.SecretRef != "" || matcher.Prefix != "" || matcher.Suffix != "" {
			return fmt.Errorf("profile %s path matcher %s must not set secretRef, prefix, or suffix", profileID, matcher.Type)
		}
	case "secretRefEquals", "secretRefPrefix":
		if !strings.HasPrefix(matcher.SecretRef, "secret://") {
			return fmt.Errorf("profile %s path matcher must use a secret:// ref", profileID)
		}
		if matcher.Value != "" {
			return fmt.Errorf("profile %s path matcher %s must not set value", profileID, matcher.Type)
		}
	default:
		return fmt.Errorf("profile %s path matcher has unsupported type %q", profileID, matcher.Type)
	}
	return nil
}

func isProfileID(value string) bool {
	if value == "" {
		return false
	}
	for i, r := range value {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			continue
		}
		if i > 0 && (r == '-' || r == '_' || r == '.') {
			continue
		}
		return false
	}
	first := value[0]
	return first >= 'a' && first <= 'z' || first >= '0' && first <= '9'
}

func isHeaderName(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'A' && r <= 'Z':
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case strings.ContainsRune("!#$%&'*+.^_`|~-", r):
		default:
			return false
		}
	}
	return true
}

func loadSecrets(path string) (map[string]string, error) {
	if path == "" {
		return map[string]string{}, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]string{}, nil
		}
		return nil, err
	}
	var wrapped secretFile
	if err := json.Unmarshal(data, &wrapped); err == nil && wrapped.Secrets != nil {
		return wrapped.Secrets, nil
	}
	var direct map[string]string
	if err := json.Unmarshal(data, &direct); err != nil {
		return nil, err
	}
	return direct, nil
}

func listenProxy(rawURL string, allowRemote bool) (net.Listener, string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, "", err
	}
	if parsed.Scheme != "http" {
		return nil, "", fmt.Errorf("unsupported proxy URL scheme %q", parsed.Scheme)
	}
	host := parsed.Hostname()
	if host == "" {
		host = "127.0.0.1"
	}
	if !allowRemote && !isLoopbackHost(host) {
		return nil, "", fmt.Errorf("refusing to listen on non-loopback MITM proxy host %s", host)
	}
	port := parsed.Port()
	if port == "" {
		port = "0"
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(host, port))
	if err != nil {
		return nil, "", err
	}
	actualHost, actualPort, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		_ = listener.Close()
		return nil, "", err
	}
	if actualHost == "" || actualHost == "::" {
		actualHost = host
	}
	return listener, (&url.URL{Scheme: "http", Host: net.JoinHostPort(actualHost, actualPort)}).String(), nil
}

func isLoopbackHost(host string) bool {
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (p *proxyServer) dispatch(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		p.handleConnect(w, r)
		return
	}
	if r.URL != nil && r.URL.IsAbs() && r.URL.Scheme == "http" && r.URL.Host != "" {
		target, matchHost, err := targetFromURL(r.URL)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		p.forwardRequest(w, r, target, matchHost, "http", r.URL.Path, r.URL.RawQuery)
		return
	}
	http.Error(w, "this endpoint is an HTTP forward proxy", http.StatusBadRequest)
}

func (p *proxyServer) handleConnect(w http.ResponseWriter, r *http.Request) {
	target, matchHost, tlsHost, err := targetFromConnect(r.Host)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijacking not supported", http.StatusInternalServerError)
		return
	}
	clientConn, _, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, "hijack failed", http.StatusInternalServerError)
		return
	}
	if _, err := io.WriteString(clientConn, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		_ = clientConn.Close()
		return
	}

	tlsConn := tls.Server(clientConn, &tls.Config{
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"http/1.1"},
		GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
			sni := hello.ServerName
			if sni == "" {
				sni = tlsHost
			}
			return p.ca.mintLeaf(sni)
		},
	})
	_ = tlsConn.SetDeadline(time.Now().Add(10 * time.Second))
	if err := tlsConn.Handshake(); err != nil {
		_ = tlsConn.Close()
		return
	}
	_ = tlsConn.SetDeadline(time.Time{})

	listener := newOneShotListener(tlsConn)
	server := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p.forwardRequest(w, r, target, matchHost, "https", r.URL.Path, r.URL.RawQuery)
		}),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      30 * time.Minute,
		IdleTimeout:       2 * time.Minute,
		ConnState: func(_ net.Conn, state http.ConnState) {
			if state == http.StateHijacked || state == http.StateClosed {
				_ = listener.Close()
			}
		},
	}
	_ = server.Serve(listener)
}

func targetFromConnect(rawTarget string) (target, matchHost, tlsHost string, err error) {
	host, port, err := net.SplitHostPort(rawTarget)
	if err != nil || host == "" || port == "" {
		return "", "", "", fmt.Errorf("CONNECT target must be host:port")
	}
	if !isSafeHost(host) {
		return "", "", "", fmt.Errorf("invalid host")
	}
	if !isValidPort(port) {
		return "", "", "", fmt.Errorf("invalid port")
	}
	target = urlHost(host, port)
	return target, normalizeHost(target), host, nil
}

func targetFromURL(u *url.URL) (target, matchHost string, err error) {
	host := u.Hostname()
	if host == "" {
		return "", "", fmt.Errorf("absolute-form proxy request requires a host")
	}
	if !isSafeHost(host) {
		return "", "", fmt.Errorf("invalid host")
	}
	port := u.Port()
	if port != "" && !isValidPort(port) {
		return "", "", fmt.Errorf("invalid port")
	}
	target = urlHost(host, port)
	return target, normalizeHost(target), nil
}

func urlHost(host, port string) string {
	if port != "" {
		return net.JoinHostPort(host, port)
	}
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		return "[" + host + "]"
	}
	return host
}

func isValidPort(port string) bool {
	n, err := strconv.Atoi(port)
	return err == nil && n > 0 && n <= 65535
}

func (p *proxyServer) forwardRequest(w http.ResponseWriter, r *http.Request, originalTarget, matchHost, scheme, path, rawQuery string) {
	if path == "" {
		path = "/"
	}
	requestPath := path
	if rawQuery != "" {
		requestPath += "?" + rawQuery
	}
	matchScheme := scheme
	if isWebSocketUpgrade(r) {
		if scheme == "https" {
			matchScheme = "wss"
		} else {
			matchScheme = "ws"
		}
	}
	route := p.matchRoute(matchHost, matchScheme, path, rawQuery, r.Header)
	if route == nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "request did not match an enabled Clawdi MITM profile"})
		return
	}
	if route.profile.Kind == "deny" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "blocked by Clawdi MITM profile"})
		return
	}
	upstream, err := routeUpstream(route.profile, originalTarget, scheme)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Clawdi MITM profile has invalid upstream"})
		return
	}

	outURL := *upstream
	outURL.Scheme = normalizeUpstreamScheme(outURL.Scheme)
	outURL.Path, outURL.RawQuery = rewritePath(
		upstream,
		requestPath,
		route.profile.Kind == "passthrough" || route.profile.Rewrite.preservePath(),
	)
	outReq, err := http.NewRequestWithContext(r.Context(), r.Method, outURL.String(), r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "bad gateway"})
		return
	}
	outReq.ContentLength = r.ContentLength
	copyForwardHeaders(r.Header, outReq.Header)
	outReq.Host = upstream.Host
	outReq.Header.Set("Host", upstream.Host)
	if route.profile.Kind != "passthrough" {
		outReq.Header.Set("X-Clawdi-Original-Host", route.originalHost)
	}
	for key, value := range route.profile.Rewrite.SetHeaders {
		resolved, ok := value.resolve(p.secrets)
		if !ok {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Clawdi MITM profile has unresolved rewrite secret"})
			return
		}
		outReq.Header.Set(key, resolved)
	}

	if isWebSocketUpgrade(r) {
		outReq.Body = nil
		outReq.ContentLength = 0
		outReq.Header.Set("Connection", "Upgrade")
		outReq.Header.Set("Upgrade", r.Header.Get("Upgrade"))
		p.forwardWebSocket(w, r, outReq)
		return
	}

	resp, err := p.transport.RoundTrip(outReq)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream request failed"})
		return
	}
	defer resp.Body.Close()

	for key, values := range resp.Header {
		if shouldStripResponseHeader(key) {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func routeUpstream(p profile, originalTarget string, scheme string) (*url.URL, error) {
	if p.Kind == "passthrough" {
		return &url.URL{Scheme: scheme, Host: originalTarget}, nil
	}
	return url.Parse(p.Rewrite.UpstreamBaseURL)
}

func (p *proxyServer) matchRoute(originalHost, scheme, path, rawQuery string, headers http.Header) *route {
	for _, profile := range p.profiles {
		if normalizeHost(profile.Match.Host) != originalHost {
			continue
		}
		if profile.Match.Scheme != "" && profile.Match.Scheme != scheme {
			continue
		}
		if profile.Match.PathPrefix != "" && !strings.HasPrefix(path, profile.Match.PathPrefix) {
			continue
		}
		if !p.pathMatch(profile.Match.Path, path) {
			continue
		}
		if !p.headersMatch(profile.Match.Headers, headers) {
			continue
		}
		if !p.queryMatch(profile.Match.Query, rawQuery) {
			continue
		}
		return &route{profile: profile, originalHost: originalHost}
	}
	return nil
}

func (p *proxyServer) pathMatch(matcher pathMatcher, path string) bool {
	if matcher.Type == "" {
		return true
	}
	switch matcher.Type {
	case "equals":
		return path == matcher.Value
	case "prefix":
		return strings.HasPrefix(path, matcher.Value)
	case "secretRefEquals":
		secret, ok := p.secrets[matcher.SecretRef]
		return ok && path == matcher.Prefix+secret+matcher.Suffix
	case "secretRefPrefix":
		secret, ok := p.secrets[matcher.SecretRef]
		return ok && strings.HasPrefix(path, matcher.Prefix+secret+matcher.Suffix)
	default:
		return false
	}
}

func (p *proxyServer) queryMatch(matchers map[string]headerMatcher, rawQuery string) bool {
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		return false
	}
	for name, matcher := range matchers {
		actualValues := values[name]
		switch matcher.Type {
		case "exists":
			if len(actualValues) == 0 {
				return false
			}
		case "equals":
			if !containsValue(actualValues, matcher.Prefix+matcher.Value) {
				return false
			}
		case "secretRefEquals":
			secret, ok := p.secrets[matcher.SecretRef]
			if !ok {
				return false
			}
			if !containsValue(actualValues, matcher.Prefix+secret) {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func containsValue(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func (p *proxyServer) headersMatch(matchers map[string]headerMatcher, headers http.Header) bool {
	for name, matcher := range matchers {
		actual := headers.Get(name)
		switch matcher.Type {
		case "exists":
			if actual == "" {
				return false
			}
		case "equals":
			if actual != matcher.Prefix+matcher.Value {
				return false
			}
		case "secretRefEquals":
			secret, ok := p.secrets[matcher.SecretRef]
			if !ok {
				return false
			}
			if actual != matcher.Prefix+secret {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func (p *profile) enabled() bool {
	return p.Enabled == nil || *p.Enabled
}

func (r rewriteRule) preservePath() bool {
	return r.PreservePath == nil || *r.PreservePath
}

func rewritePath(upstream *url.URL, requestPath string, preserve bool) (string, string) {
	if !preserve {
		path := upstream.Path
		if path == "" {
			path = "/"
		}
		return path, upstream.RawQuery
	}
	requestOnlyPath := requestPath
	requestRawQuery := ""
	if idx := strings.IndexByte(requestPath, '?'); idx >= 0 {
		requestOnlyPath = requestPath[:idx]
		requestRawQuery = requestPath[idx+1:]
	}
	base := strings.TrimRight(upstream.Path, "/")
	if upstream.Path == "/" {
		base = ""
	}
	if !strings.HasPrefix(requestOnlyPath, "/") {
		requestOnlyPath = "/" + requestOnlyPath
	}
	rawQuery := requestRawQuery
	if upstream.RawQuery != "" {
		if rawQuery != "" {
			rawQuery = upstream.RawQuery + "&" + rawQuery
		} else {
			rawQuery = upstream.RawQuery
		}
	}
	return base + requestOnlyPath, rawQuery
}

func normalizeUpstreamScheme(scheme string) string {
	switch scheme {
	case "ws":
		return "http"
	case "wss":
		return "https"
	default:
		return scheme
	}
}

func copyForwardHeaders(src, dst http.Header) {
	strip := map[string]bool{}
	for _, value := range src.Values("Connection") {
		for _, field := range strings.Split(value, ",") {
			field = strings.TrimSpace(field)
			if field != "" {
				strip[http.CanonicalHeaderKey(field)] = true
			}
		}
	}
	for key, values := range src {
		canonical := http.CanonicalHeaderKey(key)
		if isHopByHop(canonical) || strip[canonical] || strings.EqualFold(canonical, "Proxy-Authorization") {
			continue
		}
		for _, value := range values {
			dst.Add(canonical, value)
		}
	}
}

func isHopByHop(header string) bool {
	switch http.CanonicalHeaderKey(header) {
	case "Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Proxy-Connection", "Te", "Trailer", "Transfer-Encoding", "Upgrade":
		return true
	default:
		return false
	}
}

func shouldStripResponseHeader(header string) bool {
	return isHopByHop(header) || strings.EqualFold(header, "Set-Cookie")
}

func writeJSON(w http.ResponseWriter, status int, body map[string]string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Clawdi-Mitm-Error", "true")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func ready(ok bool, proxyURL, caFile, reason string) {
	payload := map[string]any{"ready": ok}
	if ok {
		payload["proxyUrl"] = proxyURL
		payload["caFile"] = caFile
	} else if reason != "" {
		payload["reason"] = reason
	}
	_ = json.NewEncoder(os.Stdout).Encode(payload)
}

func exitf(format string, args ...any) {
	_, _ = fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

func writePrivateFile(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	file, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

func isSafeHost(host string) bool {
	if host == "" || len(host) > 253 {
		return false
	}
	for _, c := range host {
		if c == '@' || c == '?' || c == '#' || c == '/' || c == '\\' || c == ' ' || c == '%' || c < 0x20 || c == 0x7f {
			return false
		}
	}
	return !strings.HasPrefix(host, ".") && !strings.HasSuffix(host, ".")
}

func normalizeHost(host string) string {
	host = strings.ToLower(strings.TrimSpace(host))
	if h, port, err := net.SplitHostPort(host); err == nil {
		if port == "443" || port == "80" {
			return strings.Trim(h, "[]")
		}
		return urlHost(strings.Trim(h, "[]"), port)
	}
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		return strings.Trim(host, "[]")
	}
	return host
}

func isWebSocketUpgrade(r *http.Request) bool {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return false
	}
	for _, value := range r.Header.Values("Connection") {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), "upgrade") {
				return true
			}
		}
	}
	return false
}

func (p *proxyServer) forwardWebSocket(w http.ResponseWriter, r *http.Request, outReq *http.Request) {
	upstreamConn, upstreamReader, resp, err := dialWebSocket(r.Context(), outReq)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream websocket failed"})
		return
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		defer upstreamConn.Close()
		defer resp.Body.Close()
		for key, values := range resp.Header {
			if shouldStripResponseHeader(key) {
				continue
			}
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
		return
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		_ = upstreamConn.Close()
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "hijacking not supported"})
		return
	}
	clientConn, clientBuf, err := hijacker.Hijack()
	if err != nil {
		_ = upstreamConn.Close()
		return
	}
	if err := resp.Write(clientConn); err != nil {
		_ = clientConn.Close()
		_ = upstreamConn.Close()
		return
	}
	pipeBidirectional(clientConn, clientBuf.Reader, upstreamConn, upstreamReader)
}

func dialWebSocket(ctx context.Context, outReq *http.Request) (net.Conn, *bufio.Reader, *http.Response, error) {
	dialer := net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", dialAddress(outReq.URL))
	if err != nil {
		return nil, nil, nil, err
	}
	if outReq.URL.Scheme == "https" {
		host := outReq.URL.Hostname()
		tlsConn := tls.Client(conn, &tls.Config{MinVersion: tls.VersionTLS12, ServerName: host, NextProtos: []string{"http/1.1"}})
		_ = tlsConn.SetDeadline(time.Now().Add(10 * time.Second))
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = conn.Close()
			return nil, nil, nil, err
		}
		_ = tlsConn.SetDeadline(time.Time{})
		conn = tlsConn
	}
	if err := writeWebSocketRequest(conn, outReq); err != nil {
		_ = conn.Close()
		return nil, nil, nil, err
	}
	reader := bufio.NewReader(conn)
	resp, err := readWebSocketResponse(reader)
	if err != nil {
		_ = conn.Close()
		return nil, nil, nil, err
	}
	return conn, reader, resp, nil
}

func dialAddress(u *url.URL) string {
	if u.Port() != "" {
		return u.Host
	}
	port := "80"
	if u.Scheme == "https" {
		port = "443"
	}
	return net.JoinHostPort(u.Hostname(), port)
}

func writeWebSocketRequest(conn net.Conn, req *http.Request) error {
	path := req.URL.RequestURI()
	if path == "" {
		path = "/"
	}
	host := req.Host
	if host == "" {
		host = req.URL.Host
	}
	if _, err := fmt.Fprintf(conn, "%s %s HTTP/1.1\r\nHost: %s\r\n", req.Method, path, host); err != nil {
		return err
	}
	header := req.Header.Clone()
	header.Del("Host")
	header.Del("Content-Length")
	header.Del("Transfer-Encoding")
	if err := header.WriteSubset(conn, nil); err != nil {
		return err
	}
	_, err := io.WriteString(conn, "\r\n")
	return err
}

func readWebSocketResponse(reader *bufio.Reader) (*http.Response, error) {
	tp := textproto.NewReader(reader)
	statusLine, err := tp.ReadLine()
	if err != nil {
		return nil, err
	}
	parts := strings.SplitN(statusLine, " ", 3)
	if len(parts) < 2 || !strings.HasPrefix(parts[0], "HTTP/") {
		return nil, fmt.Errorf("bad websocket response status line %q", statusLine)
	}
	statusCode, err := strconv.Atoi(parts[1])
	if err != nil {
		return nil, fmt.Errorf("bad websocket response status code %q", parts[1])
	}
	header, err := tp.ReadMIMEHeader()
	if err != nil {
		return nil, err
	}
	statusText := parts[1]
	if len(parts) == 3 {
		statusText += " " + parts[2]
	}
	return &http.Response{
		Status:        statusText,
		StatusCode:    statusCode,
		Proto:         parts[0],
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        http.Header(header),
		Body:          io.NopCloser(reader),
		ContentLength: -1,
	}, nil
}

func pipeBidirectional(clientConn net.Conn, clientReader *bufio.Reader, upstreamConn net.Conn, upstreamReader *bufio.Reader) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _ = io.Copy(upstreamConn, clientReader)
		_ = upstreamConn.SetDeadline(time.Now())
	}()
	go func() {
		defer wg.Done()
		_, _ = io.Copy(clientConn, upstreamReader)
		_ = clientConn.SetDeadline(time.Now())
	}()
	wg.Wait()
	_ = clientConn.Close()
	_ = upstreamConn.Close()
}

type oneShotListener struct {
	conn   net.Conn
	yield  chan net.Conn
	closed chan struct{}
	once   sync.Once
}

func newOneShotListener(conn net.Conn) *oneShotListener {
	listener := &oneShotListener{
		conn:   conn,
		yield:  make(chan net.Conn, 1),
		closed: make(chan struct{}),
	}
	listener.yield <- conn
	return listener
}

func (l *oneShotListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.yield:
		return conn, nil
	case <-l.closed:
		return nil, net.ErrClosed
	}
}

func (l *oneShotListener) Close() error {
	l.once.Do(func() {
		close(l.closed)
	})
	return nil
}

func (l *oneShotListener) Addr() net.Addr {
	return l.conn.LocalAddr()
}

type certificateAuthority struct {
	rootCert *x509.Certificate
	rootKey  *rsa.PrivateKey
	rootPEM  []byte
	cache    map[string]*tls.Certificate
	mu       sync.Mutex
}

func newCertificateAuthority() (*certificateAuthority, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	cert := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "Clawdi MITM Root CA", Organization: []string{"Clawdi"}},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	rootPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	return &certificateAuthority{rootCert: parsed, rootKey: key, rootPEM: rootPEM, cache: map[string]*tls.Certificate{}}, nil
}

func (c *certificateAuthority) mintLeaf(host string) (*tls.Certificate, error) {
	host = normalizeHost(host)
	if !isSafeHost(host) {
		return nil, fmt.Errorf("invalid SNI %q", host)
	}
	c.mu.Lock()
	if cert := c.cache[host]; cert != nil {
		c.mu.Unlock()
		return cert, nil
	}
	c.mu.Unlock()

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	leaf := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: host},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(12 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	if ip := net.ParseIP(host); ip != nil {
		leaf.IPAddresses = []net.IP{ip}
	} else {
		leaf.DNSNames = []string{host}
	}
	der, err := x509.CreateCertificate(rand.Reader, leaf, c.rootCert, &key.PublicKey, c.rootKey)
	if err != nil {
		return nil, err
	}
	tlsCert := &tls.Certificate{
		Certificate: [][]byte{der, c.rootCert.Raw},
		PrivateKey:  key,
		Leaf:        leaf,
	}
	c.mu.Lock()
	c.cache[host] = tlsCert
	c.mu.Unlock()
	return tlsCert, nil
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	return rand.Int(rand.Reader, limit)
}
