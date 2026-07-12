package resource_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/resource"
)

func newSearchResource(t *testing.T, serverURL string) *resource.Resource {
	t.Helper()
	settings := backend.DataSourceInstanceSettings{
		URL:      serverURL,
		JSONData: []byte(`{"httpMethod":"GET"}`),
	}
	r, err := resource.New(http.DefaultClient, settings, log.DefaultLogger)
	require.NoError(t, err)
	return r
}

func collectLines(t *testing.T, r *resource.Resource, ctx context.Context, endpoint string, params url.Values) ([]resource.SearchLine, error) {
	t.Helper()
	var lines []resource.SearchLine
	err := r.StreamSearch(ctx, endpoint, params, func(l resource.SearchLine) error {
		lines = append(lines, l)
		return nil
	})
	return lines, err
}

func TestIsValidSearchEndpoint(t *testing.T) {
	assert.True(t, resource.IsValidSearchEndpoint(resource.SearchMetricNames))
	assert.True(t, resource.IsValidSearchEndpoint(resource.SearchLabelNames))
	assert.True(t, resource.IsValidSearchEndpoint(resource.SearchLabelValues))
	assert.False(t, resource.IsValidSearchEndpoint("series"))
	assert.False(t, resource.IsValidSearchEndpoint("../admin"))
	assert.False(t, resource.IsValidSearchEndpoint(""))
}

func TestStreamSearch_RejectsInvalidEndpoint(t *testing.T) {
	r := newSearchResource(t, "http://example.invalid")
	err := r.StreamSearch(context.Background(), "not_allowed", url.Values{}, func(resource.SearchLine) error { return nil })
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid search endpoint")
}

func TestStreamSearch_BatchesThenTrailer(t *testing.T) {
	body := strings.Join([]string{
		`{"results":[{"name":"up"},{"name":"up_total"}],"warnings":["w1"]}`,
		`{"results":[{"name":"uptime"}]}`,
		`{"status":"success","has_more":true,"warnings":["truncated"]}`,
	}, "\n") + "\n"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		assert.Equal(t, "/api/v1/search/metric_names", req.URL.Path)
		assert.Equal(t, http.MethodGet, req.Method)
		assert.Equal(t, "up", req.URL.Query().Get("search[]"))
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	r := newSearchResource(t, srv.URL)
	params := url.Values{}
	params.Add("search[]", "up")
	lines, err := collectLines(t, r, context.Background(), resource.SearchMetricNames, params)
	require.NoError(t, err)
	require.Len(t, lines, 3)

	require.Len(t, lines[0].Results, 2)
	assert.Equal(t, []string{"w1"}, lines[0].Warnings)
	assert.False(t, lines[0].IsTerminal())

	require.Len(t, lines[1].Results, 1)

	assert.True(t, lines[2].IsTerminal())
	assert.False(t, lines[2].IsError())
	assert.True(t, lines[2].HasMore)
	assert.Equal(t, []string{"truncated"}, lines[2].Warnings)
}

func TestStreamSearch_MidStreamError(t *testing.T) {
	body := strings.Join([]string{
		`{"results":[{"value":"prod"}]}`,
		`{"status":"error","errorType":"internal","error":"boom"}`,
	}, "\n") + "\n"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	r := newSearchResource(t, srv.URL)
	lines, err := collectLines(t, r, context.Background(), resource.SearchLabelValues, url.Values{})
	require.NoError(t, err)
	require.Len(t, lines, 2)
	assert.False(t, lines[0].IsTerminal())
	assert.True(t, lines[1].IsError())
	assert.Equal(t, "boom", lines[1].Error)
	assert.Equal(t, "internal", lines[1].ErrType)
}

func TestStreamSearch_PreStreamHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"status":"error","errorType":"bad_data","error":"invalid label"}`))
	}))
	defer srv.Close()

	r := newSearchResource(t, srv.URL)
	lines, err := collectLines(t, r, context.Background(), resource.SearchLabelValues, url.Values{})
	require.NoError(t, err)
	require.Len(t, lines, 1)
	assert.True(t, lines[0].IsError())
	assert.Equal(t, "invalid label", lines[0].Error)
}

func TestStreamSearch_AbruptEOFNoTrailer(t *testing.T) {
	// Two batches, no trailer, connection just ends.
	body := `{"results":[{"name":"a"}]}` + "\n" + `{"results":[{"name":"b"}]}` + "\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	r := newSearchResource(t, srv.URL)
	lines, err := collectLines(t, r, context.Background(), resource.SearchMetricNames, url.Values{})
	require.NoError(t, err)
	require.Len(t, lines, 2)
	assert.False(t, lines[1].IsTerminal())
}

func TestStreamSearch_TrailingLineWithoutNewline(t *testing.T) {
	// Last line has no trailing newline.
	body := `{"results":[{"name":"a"}]}` + "\n" + `{"status":"success","has_more":false}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	r := newSearchResource(t, srv.URL)
	lines, err := collectLines(t, r, context.Background(), resource.SearchMetricNames, url.Values{})
	require.NoError(t, err)
	require.Len(t, lines, 2)
	assert.True(t, lines[1].IsTerminal())
}

func TestStreamSearch_MalformedLineReturnsNumberedErrorAfterPartialResults(t *testing.T) {
	body := `{"results":[{"name":"valid"}]}` + "\n" + `{"results":invalid}` + "\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	r := newSearchResource(t, srv.URL)
	lines, err := collectLines(t, r, context.Background(), resource.SearchMetricNames, url.Values{})

	require.Error(t, err)
	assert.Contains(t, err.Error(), "line 2")
	require.Len(t, lines, 1)
	require.Len(t, lines[0].Results, 1)
}

func TestStreamSearch_LargeLineAndBlankLines(t *testing.T) {
	// A single very large line (bigger than the 64KiB read buffer) plus blank lines
	// that must be skipped.
	var big strings.Builder
	big.WriteString(`{"results":[`)
	for i := 0; i < 5000; i++ {
		if i > 0 {
			big.WriteString(",")
		}
		fmt.Fprintf(&big, `{"name":"metric_%d"}`, i)
	}
	big.WriteString(`]}`)

	body := "\n" + big.String() + "\n\n" + `{"status":"success"}` + "\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	r := newSearchResource(t, srv.URL)
	lines, err := collectLines(t, r, context.Background(), resource.SearchMetricNames, url.Values{})
	require.NoError(t, err)
	require.Len(t, lines, 2) // blank lines skipped
	assert.Len(t, lines[0].Results, 5000)
	assert.True(t, lines[1].IsTerminal())
}

func TestStreamSearch_ContextCancel(t *testing.T) {
	released := make(chan struct{})
	var once sync.Once
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fl, ok := w.(http.Flusher)
		require.True(t, ok)
		_, _ = w.Write([]byte(`{"results":[{"name":"a"}]}` + "\n"))
		fl.Flush()
		<-released // block until the test cancels
	}))
	defer srv.Close()
	defer once.Do(func() { close(released) })

	r := newSearchResource(t, srv.URL)
	ctx, cancel := context.WithCancel(context.Background())

	gotFirst := make(chan struct{})
	var lines []resource.SearchLine
	errCh := make(chan error, 1)
	go func() {
		errCh <- r.StreamSearch(ctx, resource.SearchMetricNames, url.Values{}, func(l resource.SearchLine) error {
			lines = append(lines, l)
			close(gotFirst)
			return nil
		})
	}()

	select {
	case <-gotFirst:
	case <-time.After(5 * time.Second):
		t.Fatal("did not receive first batch")
	}

	cancel()
	once.Do(func() { close(released) })

	select {
	case err := <-errCh:
		require.Error(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("StreamSearch did not return after cancel")
	}
	require.Len(t, lines, 1)
}
