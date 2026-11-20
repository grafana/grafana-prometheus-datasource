package client

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

type MockDoer struct {
	Req *http.Request
}

func (doer *MockDoer) Do(req *http.Request) (*http.Response, error) {
	doer.Req = req
	return &http.Response{
		StatusCode: http.StatusOK,
		Status:     "200 OK",
	}, nil
}

func TestClient(t *testing.T) {
	t.Run("QueryResource", func(t *testing.T) {
		t.Run("POST-configured client forwards POST request as POST", func(t *testing.T) {
			doer := &MockDoer{}
			client := NewClient(doer, http.MethodPost, "http://localhost:9090", "60s")

			req := &backend.CallResourceRequest{
				PluginContext: backend.PluginContext{},
				Path:          "/api/v1/series",
				Method:        http.MethodPost,
				URL:           "/api/v1/series",
				Body:          []byte("match%5B%5D=ALERTS&start=1655271408&end=1655293008"),
			}
			res, err := client.QueryResource(context.Background(), req)
			defer func() {
				if res != nil && res.Body != nil {
					if err := res.Body.Close(); err != nil {
						fmt.Println("Error", "err", err)
					}
				}
			}()
			require.NoError(t, err)
			require.NotNil(t, doer.Req)
			require.Equal(t, http.MethodPost, doer.Req.Method)
			body, err := io.ReadAll(doer.Req.Body)
			require.NoError(t, err)
			require.Equal(t, "match%5B%5D=ALERTS&start=1655271408&end=1655293008", string(body))
			require.Equal(t, "http://localhost:9090/api/v1/series", doer.Req.URL.String())
		})

		t.Run("GET-configured client converts incoming POST to GET", func(t *testing.T) {
			doer := &MockDoer{}
			client := NewClient(doer, http.MethodGet, "http://localhost:9090", "60s")

			req := &backend.CallResourceRequest{
				PluginContext: backend.PluginContext{},
				Path:          "/api/v1/query",
				Method:        http.MethodPost,
				URL:           "/api/v1/query",
				Body:          []byte("query=up&time=1234567890"),
			}
			res, err := client.QueryResource(context.Background(), req)
			defer func() {
				if res != nil && res.Body != nil {
					if err := res.Body.Close(); err != nil {
						fmt.Println("Error", "err", err)
					}
				}
			}()
			require.NoError(t, err)
			require.NotNil(t, doer.Req)
			require.Equal(t, http.MethodGet, doer.Req.Method)
			require.Contains(t, doer.Req.URL.RawQuery, "query=up")
			require.Contains(t, doer.Req.URL.RawQuery, "time=1234567890")
		})

		t.Run("GET request is always respected regardless of configured method", func(t *testing.T) {
			doer := &MockDoer{}
			client := NewClient(doer, http.MethodPost, "http://localhost:9090", "60s")

			req := &backend.CallResourceRequest{
				PluginContext: backend.PluginContext{},
				Path:          "/api/v1/series",
				Method:        http.MethodGet,
				URL:           "api/v1/series?match%5B%5D=ALERTS&start=1655272558&end=1655294158",
			}
			res, err := client.QueryResource(context.Background(), req)
			defer func() {
				if res != nil && res.Body != nil {
					if err := res.Body.Close(); err != nil {
						fmt.Println("Error", "err", err)
					}
				}
			}()
			require.NoError(t, err)
			require.NotNil(t, doer.Req)
			require.Equal(t, http.MethodGet, doer.Req.Method)
			body, err := io.ReadAll(doer.Req.Body)
			require.NoError(t, err)
			require.Equal(t, []byte{}, body)
			require.Equal(t, "http://localhost:9090/api/v1/series?match%5B%5D=ALERTS&start=1655272558&end=1655294158", doer.Req.URL.String())
		})

		t.Run("GET-configured client preserves existing query params when converting POST", func(t *testing.T) {
			doer := &MockDoer{}
			client := NewClient(doer, http.MethodGet, "http://localhost:9090", "60s")

			req := &backend.CallResourceRequest{
				PluginContext: backend.PluginContext{},
				Path:          "/api/v1/query",
				Method:        http.MethodPost,
				URL:           "/api/v1/query?timeout=30",
				Body:          []byte("query=up"),
			}
			res, err := client.QueryResource(context.Background(), req)
			defer func() {
				if res != nil && res.Body != nil {
					if err := res.Body.Close(); err != nil {
						fmt.Println("Error", "err", err)
					}
				}
			}()
			require.NoError(t, err)
			require.NotNil(t, doer.Req)
			require.Equal(t, http.MethodGet, doer.Req.Method)
			require.Contains(t, doer.Req.URL.RawQuery, "timeout=30")
			require.Contains(t, doer.Req.URL.RawQuery, "query=up")
		})
	})

	t.Run("QueryRange", func(t *testing.T) {
		doer := &MockDoer{}

		t.Run("sends correct POST query", func(t *testing.T) {
			client := NewClient(doer, http.MethodPost, "http://localhost:9090", "60s")
			req := &models.Query{
				Expr:       "rate(ALERTS{job=\"test\" [$__rate_interval]})",
				Start:      time.Unix(0, 0),
				End:        time.Unix(1234, 0),
				RangeQuery: true,
				Step:       1 * time.Second,
			}
			res, err := client.QueryRange(context.Background(), req)
			defer func() {
				if res != nil && res.Body != nil {
					if err := res.Body.Close(); err != nil {
						fmt.Println("Error", "err", err)
					}
				}
			}()
			require.NoError(t, err)
			require.NotNil(t, doer.Req)
			require.Equal(t, http.MethodPost, doer.Req.Method)
			require.Equal(t, "application/x-www-form-urlencoded", doer.Req.Header.Get("Content-Type"))
			body, err := io.ReadAll(doer.Req.Body)
			require.NoError(t, err)
			require.Equal(t, []byte("end=1234&query=rate%28ALERTS%7Bjob%3D%22test%22+%5B%24__rate_interval%5D%7D%29&start=0&step=1&timeout=60s"), body)
			require.Equal(t, "http://localhost:9090/api/v1/query_range", doer.Req.URL.String())
		})

		t.Run("sends correct GET query", func(t *testing.T) {
			client := NewClient(doer, http.MethodGet, "http://localhost:9090", "60s")
			req := &models.Query{
				Expr:       "rate(ALERTS{job=\"test\" [$__rate_interval]})",
				Start:      time.Unix(0, 0),
				End:        time.Unix(1234, 0),
				RangeQuery: true,
				Step:       1 * time.Second,
			}
			res, err := client.QueryRange(context.Background(), req)
			defer func() {
				if res != nil && res.Body != nil {
					if err := res.Body.Close(); err != nil {
						fmt.Println("Error", "err", err)
					}
				}
			}()
			require.NoError(t, err)
			require.NotNil(t, doer.Req)
			require.Equal(t, http.MethodGet, doer.Req.Method)
			body, err := io.ReadAll(doer.Req.Body)
			require.NoError(t, err)
			require.Equal(t, []byte{}, body)
			require.Equal(t, "http://localhost:9090/api/v1/query_range?end=1234&query=rate%28ALERTS%7Bjob%3D%22test%22+%5B%24__rate_interval%5D%7D%29&start=0&step=1&timeout=60s", doer.Req.URL.String())
		})
	})
}

func TestClientMimirProtobufAccept(t *testing.T) {
	q := &models.Query{Expr: "up", Start: time.Unix(0, 0), End: time.Unix(60, 0), Step: time.Second}
	calls := map[string]func(*Client) (*http.Response, error){
		"range":   func(c *Client) (*http.Response, error) { return c.QueryRange(context.Background(), q) },
		"instant": func(c *Client) (*http.Response, error) { return c.QueryInstant(context.Background(), q) },
		"exemplars": func(c *Client) (*http.Response, error) {
			return c.QueryExemplars(context.Background(), q)
		},
		"resource": func(c *Client) (*http.Response, error) {
			return c.QueryResource(context.Background(), &backend.CallResourceRequest{Path: "api/v1/query", Method: http.MethodGet, URL: "api/v1/query?query=up"})
		},
	}
	tests := []struct {
		name    string
		opts    []Option
		accepts map[string]bool
	}{
		{name: "without the option", accepts: map[string]bool{}},
		{name: "option off", opts: []Option{WithMimirProtobuf(func(context.Context) bool { return false })}, accepts: map[string]bool{}},
		{name: "option on", opts: []Option{WithMimirProtobuf(func(context.Context) bool { return true })}, accepts: map[string]bool{"range": true, "instant": true}},
	}
	for _, tt := range tests {
		for name, call := range calls {
			t.Run(tt.name+"/"+name, func(t *testing.T) {
				doer := &MockDoer{}
				_, err := call(NewClient(doer, http.MethodPost, "http://localhost:9090", "", tt.opts...))
				require.NoError(t, err)
				want := ""
				if tt.accepts[name] {
					want = "application/vnd.mimir.queryresponse+protobuf, application/json;q=0.9"
				}
				require.Equal(t, want, doer.Req.Header.Get("Accept"))
			})
		}
	}
}
