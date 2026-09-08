//go:build ignore

// Command gzip-proxy is a test-only reverse proxy that sits in front of an
// upstream Prometheus and forces every response to be gzip-compressed with an
// explicit Content-Length for the compressed bytes.
//
// This deterministically recreates the production conditions behind the
// externalized Prometheus datasource 500s: the datasource plugin decodes the
// gzip body to plaintext but, before the fix, relayed the stale
// Content-Encoding/Content-Length upstream headers, so the downstream proxy saw
// a framing mismatch and reset the write with an HTTP 500.
//
// Vanilla prom/prometheus does not reliably emit this shape, so relying on it
// alone lets the bug hide. This proxy removes that non-determinism.
//
// Configuration (environment variables):
//
//	UPSTREAM - upstream base URL (default "http://prometheus:9090")
//	LISTEN   - listen address    (default ":9090")
package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
)

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	upstream := getenv("UPSTREAM", "http://prometheus:9090")
	listen := getenv("LISTEN", ":9090")

	target, err := url.Parse(upstream)
	if err != nil {
		log.Fatalf("invalid UPSTREAM %q: %v", upstream, err)
	}

	proxy := httputil.NewSingleHostReverseProxy(target)

	orig := proxy.Director
	proxy.Director = func(r *http.Request) {
		orig(r)
		// Force the upstream to answer in plaintext so this proxy fully controls
		// the gzip framing it sends downstream.
		r.Header.Del("Accept-Encoding")
	}

	proxy.ModifyResponse = func(resp *http.Response) error {
		if resp.Header.Get("Content-Encoding") != "" {
			return nil // already encoded, leave it alone
		}

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}
		if closeErr := resp.Body.Close(); closeErr != nil {
			return closeErr
		}

		var buf bytes.Buffer
		gz := gzip.NewWriter(&buf)
		if _, err := gz.Write(body); err != nil {
			return err
		}
		if err := gz.Close(); err != nil {
			return err
		}

		resp.Body = io.NopCloser(&buf)
		resp.Header.Set("Content-Encoding", "gzip")
		// Explicit Content-Length = the *compressed* size. After the plugin
		// decompresses, it writes the larger plaintext body while this small
		// length is still declared, which is what triggers the downstream 500
		// when the stale header is relayed.
		resp.Header.Set("Content-Length", strconv.Itoa(buf.Len()))
		resp.ContentLength = int64(buf.Len())
		return nil
	}

	log.Printf("gzip-proxy listening on %s, forwarding to %s", listen, upstream)
	log.Fatal(http.ListenAndServe(listen, proxy)) //nolint:gosec
}
