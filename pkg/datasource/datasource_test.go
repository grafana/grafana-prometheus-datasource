package datasource

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkdatasource "github.com/grafana/grafana-plugin-sdk-go/backend/datasource"
	"github.com/grafana/grafana-plugin-sdk-go/config"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/require"
)

const vectorResponse = `{"status":"success","data":{"resultType":"vector","result":[{"metric":{"__name__":"up"},"value":[1795100000,"1"]}]}}`

var ttlConfig = config.NewGrafanaCfg(map[string]string{"GF_INSTANCE_FEATURE_TOGGLES_ENABLE": "ttlPluginInstanceManager"})

func pluginContext(id int, url string) backend.PluginContext {
	return backend.PluginContext{
		Namespace:     "stacks-1",
		GrafanaConfig: ttlConfig,
		DataSourceInstanceSettings: &backend.DataSourceInstanceSettings{
			ID:       int64(id),
			UID:      fmt.Sprintf("ds-%d", id),
			Type:     "prometheus",
			URL:      url,
			JSONData: []byte(`{}`),
		},
	}
}

func queryUp(t *testing.T, ds *Datasource, pCtx backend.PluginContext) {
	t.Helper()
	ctx := config.WithGrafanaConfig(context.Background(), ttlConfig)
	res, err := ds.QueryData(ctx, &backend.QueryDataRequest{
		PluginContext: pCtx,
		Queries: []backend.DataQuery{{
			RefID:     "A",
			JSON:      []byte(`{"expr":"up","instant":true}`),
			TimeRange: backend.TimeRange{From: time.Unix(1795099940, 0), To: time.Unix(1795100000, 0)},
		}},
	})
	require.NoError(t, err)
	require.NoError(t, res.Responses["A"].Error)
}

func activeInstances(t *testing.T) float64 {
	t.Helper()
	families, err := prometheus.DefaultGatherer.Gather()
	require.NoError(t, err)
	for _, f := range families {
		if f.GetName() == "plugins_active_instances" {
			return f.GetMetric()[0].GetGauge().GetValue()
		}
	}
	t.Fatal("plugins_active_instances is not registered")
	return 0
}

func TestInstanceFactoryCachesEachDataSourceOnce(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Connection", "close")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(vectorResponse))
	}))
	t.Cleanup(srv.Close)

	im := sdkdatasource.NewInstanceManager(NewInstanceFactory())
	query := func(id int) {
		pCtx := pluginContext(id, srv.URL)
		inst, err := im.Get(config.WithGrafanaConfig(context.Background(), ttlConfig), pCtx)
		require.NoError(t, err)
		queryUp(t, inst.(*Datasource), pCtx)
	}

	query(0)
	instancesBefore, goroutinesBefore := activeInstances(t), runtime.NumGoroutine()
	const dataSources = 50
	for id := 1; id <= dataSources; id++ {
		query(id)
	}

	require.Equal(t, float64(dataSources), activeInstances(t)-instancesBefore)
	require.Less(t, runtime.NumGoroutine()-goroutinesBefore, dataSources/5)
}

func TestDatasourceDisposeClosesIdleConnections(t *testing.T) {
	closed := make(chan struct{}, 1)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(vectorResponse))
	}))
	srv.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateClosed {
			select {
			case closed <- struct{}{}:
			default:
			}
		}
	}
	srv.Start()
	t.Cleanup(srv.Close)

	pCtx := pluginContext(1, srv.URL)
	inst, err := NewInstanceFactory()(config.WithGrafanaConfig(context.Background(), ttlConfig), *pCtx.DataSourceInstanceSettings)
	require.NoError(t, err)
	ds := inst.(*Datasource)
	queryUp(t, ds, pCtx)

	ds.Dispose()

	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("the idle upstream connection is still open after Dispose")
	}
}

func brokenSettings(pCtx backend.PluginContext) backend.PluginContext {
	settings := *pCtx.DataSourceInstanceSettings
	settings.Updated = settings.Updated.Add(time.Minute)
	settings.JSONData = []byte(`{`)
	pCtx.DataSourceInstanceSettings = &settings
	return pCtx
}

func TestBrokenSettingsKeepActiveInstancesCount(t *testing.T) {
	pCtx := pluginContext(1, "http://localhost:9090")
	pCtx.GrafanaConfig = config.NewGrafanaCfg(nil)
	ctx := config.WithGrafanaConfig(context.Background(), pCtx.GrafanaConfig)
	im := sdkdatasource.NewInstanceManager(NewInstanceFactory())
	before := activeInstances(t)

	_, err := im.Get(ctx, pCtx)
	require.NoError(t, err)
	broken := brokenSettings(pCtx)
	for range 3 {
		_, _ = im.Get(ctx, broken)
	}

	// The SDK disposes a replaced instance, and decrements the gauge, 5 s after the replacement.
	time.Sleep(6 * time.Second)
	require.Equal(t, before+1, activeInstances(t))
}

func TestInstanceFactoryReturnsBuildErrorFromHandlers(t *testing.T) {
	pCtx := brokenSettings(pluginContext(1, "http://localhost:9090"))
	ctx := config.WithGrafanaConfig(context.Background(), ttlConfig)
	inst, err := NewInstanceFactory()(ctx, *pCtx.DataSourceInstanceSettings)
	require.NoError(t, err)
	ds := inst.(*Datasource)

	_, err = ds.QueryData(ctx, &backend.QueryDataRequest{PluginContext: pCtx, Queries: []backend.DataQuery{{RefID: "A"}}})
	require.ErrorContains(t, err, "error reading settings")

	health, err := ds.CheckHealth(ctx, &backend.CheckHealthRequest{PluginContext: pCtx})
	require.NoError(t, err)
	require.Equal(t, backend.HealthStatusError, health.Status)
	require.Contains(t, health.Message, "error reading settings")
	require.True(t, strings.HasSuffix(health.Message, " - error getting datasource info"), health.Message)
}
