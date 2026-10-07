package datasource

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/stretchr/testify/require"
)

func TestDatasourceDisposeClosesIdleConnections(t *testing.T) {
	closed := make(chan struct{}, 1)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, `{"status":"success","data":[]}`)
	}))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateClosed {
			closed <- struct{}{}
		}
	}
	server.Start()
	defer server.Close()
	i, err := NewDatasource(context.Background(), backend.DataSourceInstanceSettings{
		URL: server.URL, JSONData: json.RawMessage(`{}`),
	})
	require.NoError(t, err)
	ds := i.(*Datasource)
	t.Cleanup(ds.Dispose)
	require.NoError(t, ds.CallResource(context.Background(), &backend.CallResourceRequest{
		Path: "api/v1/labels", URL: "api/v1/labels", Method: http.MethodGet,
	}, &resourceSender{}))
	select {
	case <-closed:
		t.Fatal("connection closed before disposal")
	default:
	}
	ds.Dispose()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("Dispose did not close the idle HTTP connection")
	}
}
