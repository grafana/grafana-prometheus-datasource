package promlib

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

func withOpenFeatureConfig(ctx context.Context, providerType, url, contextJSON string) context.Context {
	return config.WithGrafanaConfig(ctx, config.NewGrafanaCfg(map[string]string{
		config.OpenFeatureProviderURL:  url,
		config.OpenFeatureProviderType: providerType,
		config.OpenFeatureContext:      contextJSON,
	}))
}

type fakeOFREP struct {
	mu       sync.Mutex
	status   int
	value    bool
	contexts []map[string]any
}

func (f *fakeOFREP) set(status int, value bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.status, f.value = status, value
}

func (f *fakeOFREP) requests() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.contexts)
}

func (f *fakeOFREP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Context map[string]any `json:"context"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.contexts = append(f.contexts, body.Context)
	w.WriteHeader(f.status)
	_, _ = fmt.Fprintf(w, `{"key":%q,"value":%t,"reason":"TARGETING_MATCH","variant":"v"}`, flagMimirProtobufResponses, f.value)
}

// ofrepHost starts a fake OFREP host and returns a context that advertises it, as Grafana does for MT plugins.
func ofrepHost(t *testing.T, providerType string) (*fakeOFREP, context.Context) {
	t.Helper()
	host := &fakeOFREP{status: http.StatusOK, value: true}
	mux := http.NewServeMux()
	mux.Handle("POST /ofrep/v1/evaluate/flags/"+flagMimirProtobufResponses, host)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	ctx := withOpenFeatureConfig(context.Background(), providerType, server.URL, `{"slug":"mystack"}`)
	return host, backend.WithPluginContext(ctx, backend.PluginContext{Namespace: "stacks-1"})
}

func expireAnswers(f *ofrepFlags) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for k, a := range f.answers {
		a.expires = time.Time{}
		f.answers[k] = a
	}
}

func TestMimirProtobufResponsesEnabled(t *testing.T) {
	logger := log.NewNullLogger()

	t.Run("evaluates against the host endpoint once per TTL", func(t *testing.T) {
		host, ctx := ofrepHost(t, "ofrep")
		f := newOFREPFlags()
		assert.True(t, f.mimirProtobufResponsesEnabled(ctx, logger))
		assert.True(t, f.mimirProtobufResponsesEnabled(ctx, logger))
		assert.Equal(t, []map[string]any{{"targetingKey": "grafana-prometheus-datasource"}}, host.requests(), "no stack attributes")
	})

	t.Run("off when the host serves false", func(t *testing.T) {
		host, ctx := ofrepHost(t, "ofrep")
		host.set(http.StatusOK, false)
		assert.False(t, newOFREPFlags().mimirProtobufResponsesEnabled(ctx, logger))
	})

	for _, providerType := range []string{"features-service", "static"} {
		t.Run("off with no request on a "+providerType+" host", func(t *testing.T) {
			host, ctx := ofrepHost(t, providerType)
			assert.False(t, newOFREPFlags().mimirProtobufResponsesEnabled(ctx, logger))
			assert.Empty(t, host.requests())
		})
	}

	t.Run("off when the host advertises no provider", func(t *testing.T) {
		assert.False(t, newOFREPFlags().mimirProtobufResponsesEnabled(context.Background(), logger))
	})

	t.Run("off when host discovery is malformed", func(t *testing.T) {
		ctx := withOpenFeatureConfig(context.Background(), "ofrep", "http://flags.invalid", `not json`)
		assert.False(t, newOFREPFlags().mimirProtobufResponsesEnabled(ctx, logger))
	})

	t.Run("off when the first request fails", func(t *testing.T) {
		host, ctx := ofrepHost(t, "ofrep")
		host.set(http.StatusInternalServerError, true)
		assert.False(t, newOFREPFlags().mimirProtobufResponsesEnabled(ctx, logger))
	})

	t.Run("a failed refresh keeps the previous answer", func(t *testing.T) {
		host, ctx := ofrepHost(t, "ofrep")
		f := newOFREPFlags()
		require.True(t, f.mimirProtobufResponsesEnabled(ctx, logger))
		expireAnswers(f)
		host.set(http.StatusInternalServerError, false)
		assert.True(t, f.mimirProtobufResponsesEnabled(ctx, logger))
		assert.Len(t, host.requests(), 2)
	})

	t.Run("evaluates once for every stack", func(t *testing.T) {
		host, ctx := ofrepHost(t, "ofrep")
		f := newOFREPFlags()
		f.mimirProtobufResponsesEnabled(ctx, logger)
		f.mimirProtobufResponsesEnabled(backend.WithPluginContext(ctx, backend.PluginContext{Namespace: "stacks-2"}), logger)
		assert.Len(t, host.requests(), 1)
	})

	t.Run("a cancelled caller still caches the answer", func(t *testing.T) {
		host, ctx := ofrepHost(t, "ofrep")
		f := newOFREPFlags()
		cancelled, cancel := context.WithCancelCause(ctx)
		cancel(errors.New("query cancelled"))
		assert.True(t, f.mimirProtobufResponsesEnabled(cancelled, logger))
		assert.True(t, f.mimirProtobufResponsesEnabled(ctx, logger))
		assert.Len(t, host.requests(), 1)
	})
}

func TestQueryClientOptions(t *testing.T) {
	enabled := func(context.Context) bool { return true }
	tests := []struct {
		name     string
		jsonData models.PromOptions
		want     int
	}{
		{name: "defaults", want: 1},
		{name: "custom query parameters without stats", jsonData: models.PromOptions{CustomQueryParameters: "dedup=false&partial_response=true"}, want: 1},
		{name: "query stats enabled", jsonData: models.PromOptions{QueryStatsEnabled: true}, want: 0},
		{name: "stats in custom query parameters", jsonData: models.PromOptions{CustomQueryParameters: "dedup=false&stats=all"}, want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Len(t, queryClientOptions(&tt.jsonData, enabled), tt.want)
		})
	}
}
