//go:build integration

package querydata

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestChunkedJSONLStreamsBeforeUpstreamEOF(t *testing.T) {
	upstreamReleased := make(chan struct{})
	upstreamEOF := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		var samples strings.Builder
		for i := range chunkSampleLimit + 1 {
			if i > 0 {
				samples.WriteByte(',')
			}
			fmt.Fprintf(&samples, `[%d,"1"]`, 1_700_000_000+i)
		}
		_, err := fmt.Fprintf(response, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"__name__":"up"},"values":[%s]}`, samples.String())
		require.NoError(t, err)
		response.(http.Flusher).Flush()

		<-upstreamReleased
		_, err = io.WriteString(response, `]}}`)
		require.NoError(t, err)
		close(upstreamEOF)
	}))
	defer upstream.Close()

	grafanaURL := strings.TrimSuffix(os.Getenv("GRAFANA_URL"), "/")
	if grafanaURL == "" {
		grafanaURL = "http://localhost:3000"
	}
	upstreamURL := upstream.URL
	if host := os.Getenv("GRAFANA_TEST_UPSTREAM_HOST"); host != "" {
		_, port, err := net.SplitHostPort(strings.TrimPrefix(upstream.URL, "http://"))
		require.NoError(t, err)
		upstreamURL = "http://" + net.JoinHostPort(host, port)
	} else {
		_, port, err := net.SplitHostPort(strings.TrimPrefix(upstream.URL, "http://"))
		require.NoError(t, err)
		upstreamURL = "http://" + net.JoinHostPort("host.docker.internal", port)
	}

	uid := fmt.Sprintf("chunked-jsonl-%d", time.Now().UnixNano())
	createDatasource(t, grafanaURL, uid, upstreamURL)
	t.Cleanup(func() { deleteDatasource(t, grafanaURL, uid) })

	payload := []byte(`{"from":"now-30m","to":"now","queries":[{"refId":"A","expr":"up","range":true,"instant":false,"intervalMs":1000,"maxDataPoints":2000}]}`)
	request, err := http.NewRequestWithContext(context.Background(), http.MethodPost,
		fmt.Sprintf("%s/apis/prometheus.datasource.grafana.app/v0alpha1/namespaces/default/datasources/%s/query", grafanaURL, uid),
		bytes.NewReader(payload))
	require.NoError(t, err)
	request.Header.Set("Accept", "text/jsonl")
	request.Header.Set("Content-Type", "application/json")

	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, http.StatusOK, response.StatusCode)

	line, err := bufio.NewReader(response.Body).ReadBytes('\n')
	require.NoError(t, err)
	require.Contains(t, string(line), `"frameId":"range/0"`)
	select {
	case <-upstreamEOF:
		t.Fatal("received a JSONL frame only after the upstream response ended")
	default:
	}

	close(upstreamReleased)
	_, err = io.Copy(io.Discard, response.Body)
	require.NoError(t, err)
	<-upstreamEOF
}

func createDatasource(t *testing.T, grafanaURL, uid, upstreamURL string) {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"name":   uid,
		"uid":    uid,
		"type":   "prometheus",
		"access": "proxy",
		"url":    upstreamURL,
		"jsonData": map[string]any{
			"httpMethod": "GET",
		},
	})
	require.NoError(t, err)
	response, err := http.Post(grafanaURL+"/api/datasources", "application/json", bytes.NewReader(body))
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, http.StatusOK, response.StatusCode)
}

func deleteDatasource(t *testing.T, grafanaURL, uid string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodDelete, grafanaURL+"/api/datasources/uid/"+uid, nil)
	require.NoError(t, err)
	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, http.StatusOK, response.StatusCode)
}
