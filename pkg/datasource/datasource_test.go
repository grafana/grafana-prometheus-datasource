package datasource

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkdatasource "github.com/grafana/grafana-plugin-sdk-go/backend/datasource"
	"github.com/grafana/grafana-plugin-sdk-go/config"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/datasource/internal/hostlimit"
)

type resourceSender struct {
	response *backend.CallResourceResponse
}

func (s *resourceSender) Send(response *backend.CallResourceResponse) error {
	s.response = response
	return nil
}

func instancesCreated(t *testing.T) float64 {
	t.Helper()
	metrics, err := prometheus.DefaultGatherer.Gather()
	require.NoError(t, err)
	for _, metric := range metrics {
		if metric.GetName() == "plugins_datasource_instances_total" {
			return metric.Metric[0].GetCounter().GetValue()
		}
	}
	t.Fatal("datasource instance counter not found")
	return 0
}

func TestDatasourceInstanceManagement(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"status":"success","data":["up"]}`)
	}))
	defer server.Close()
	settings := backend.DataSourceInstanceSettings{
		ID: 1, URL: server.URL, JSONData: json.RawMessage(`{}`), Updated: time.Unix(1, 0),
	}
	cfg := config.NewGrafanaCfg(map[string]string{})
	ctx := config.WithGrafanaConfig(context.Background(), cfg)
	pluginCtx := backend.PluginContext{DataSourceInstanceSettings: &settings, GrafanaConfig: cfg}
	manager := sdkdatasource.NewInstanceManager(NewDatasource)
	before := instancesCreated(t)
	i, err := manager.Get(ctx, pluginCtx)
	require.NoError(t, err)
	ds := i.(*Datasource)

	// A client-backed request must not create a second SDK instance.
	sender := &resourceSender{}
	err = ds.CallResource(ctx, &backend.CallResourceRequest{
		PluginContext: pluginCtx, Path: "api/v1/labels", URL: "api/v1/labels", Method: http.MethodGet,
	}, sender)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, sender.response.Status)
	require.JSONEq(t, `{"status":"success","data":["up"]}`, string(sender.response.Body))
	again, err := manager.Get(ctx, pluginCtx)
	require.NoError(t, err)
	require.Same(t, ds, again)
	require.Equal(t, before+1, instancesCreated(t))
}

func TestDatasourceInstanceInvalidation(t *testing.T) {
	settings := backend.DataSourceInstanceSettings{
		ID: 1, JSONData: json.RawMessage(`{}`), Updated: time.Unix(1, 0),
	}
	cfg := config.NewGrafanaCfg(map[string]string{})
	ctx := config.WithGrafanaConfig(context.Background(), cfg)
	pluginCtx := backend.PluginContext{DataSourceInstanceSettings: &settings, GrafanaConfig: cfg}
	manager := sdkdatasource.NewInstanceManager(NewDatasource)
	ds, err := manager.Get(ctx, pluginCtx)
	require.NoError(t, err)

	// The outer SDK manager still owns settings and Grafana config invalidation.
	updatedSettings := settings
	updatedSettings.Updated = time.Unix(2, 0)
	pluginCtx.DataSourceInstanceSettings = &updatedSettings
	updated, err := manager.Get(ctx, pluginCtx)
	require.NoError(t, err)
	require.NotSame(t, ds, updated)
	pluginCtx.GrafanaConfig = config.NewGrafanaCfg(map[string]string{config.ResponseLimit: "1024"})
	ctx = config.WithGrafanaConfig(ctx, pluginCtx.GrafanaConfig)
	reconfigured, err := manager.Get(ctx, pluginCtx)
	require.NoError(t, err)
	require.NotSame(t, updated, reconfigured)
}

func TestNewDatasourceRejectsInvalidSettings(t *testing.T) {
	i, err := NewDatasource(context.Background(), backend.DataSourceInstanceSettings{
		JSONData: json.RawMessage(`{"httpMethod":"invalid"}`),
	})
	require.ErrorContains(t, err, "invalid httpMethod")
	require.Nil(t, i)
}

func TestDatasourceRejectsQueriesOverTheHostLimit(t *testing.T) {
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"status":"success","data":["up"]}`)
	}))
	defer server.Close()
	releaseHeld := sync.OnceFunc(func() { close(release) })
	defer releaseHeld()
	settings := backend.DataSourceInstanceSettings{
		ID: 1, URL: server.URL, JSONData: json.RawMessage(`{}`), Updated: time.Unix(1, 0),
	}
	cfg := config.NewGrafanaCfg(map[string]string{})
	ctx := config.WithGrafanaConfig(context.Background(), cfg)
	pluginCtx := backend.PluginContext{DataSourceInstanceSettings: &settings, GrafanaConfig: cfg}
	i, err := newDatasource(ctx, settings, hostlimit.New(1))
	require.NoError(t, err)
	ds := i.(*Datasource)

	held := make(chan error, 1)
	go func() {
		held <- ds.CallResource(ctx, &backend.CallResourceRequest{
			PluginContext: pluginCtx, Path: "api/v1/labels", URL: "api/v1/labels", Method: http.MethodGet,
		}, &resourceSender{})
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("first request did not reach the server")
	}

	res, err := ds.QueryData(ctx, &backend.QueryDataRequest{
		PluginContext: pluginCtx,
		Queries: []backend.DataQuery{{
			RefID:     "A",
			JSON:      json.RawMessage(`{"expr":"up","range":true}`),
			TimeRange: backend.TimeRange{From: time.Unix(0, 0), To: time.Unix(60, 0)},
			Interval:  15 * time.Second,
		}},
	})
	require.NoError(t, err)
	require.ErrorIs(t, res.Responses["A"].Error, hostlimit.ErrLimitReached)
	require.True(t, backend.IsDownstreamError(res.Responses["A"].Error))
	require.Equal(t, backend.ErrorSourceDownstream, res.Responses["A"].ErrorSource)

	releaseHeld()
	require.NoError(t, <-held)
}
