//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	sdklog "github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/config"
	"github.com/grafana/grafana-plugin-sdk-go/data"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/converter"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

type session struct {
	svc         *promlib.Service
	ctx         context.Context
	pCtx        backend.PluginContext
	contentType atomic.Value
}

// newSession serves the Mimir protobuf flag from a fake OFREP host, as Grafana does for a standalone plugin.
func newSession(t testing.TB, tgt target, flagOn bool) *session {
	t.Helper()
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprintf(w, `{"key":"prometheus.mimir-protobuf-responses","value":%t,"reason":"TARGETING_MATCH","variant":"v"}`, flagOn)
	}))
	t.Cleanup(host.Close)

	cfg := config.NewGrafanaCfg(map[string]string{
		config.OpenFeatureProviderURL:  host.URL,
		config.OpenFeatureProviderType: "ofrep",
	})
	settings := &backend.DataSourceInstanceSettings{
		ID: 1, UID: tgt.name, Name: tgt.name, Type: "prometheus", URL: tgt.queryURL,
		JSONData: []byte(`{"httpMethod":"POST","timeInterval":"15s"}`), Updated: time.Unix(1, 0),
	}
	s := &session{
		svc:  promlib.NewService(sdkhttpclient.NewProvider(), sdklog.NewNullLogger(), nil),
		pCtx: backend.PluginContext{OrgID: 1, Namespace: "stacks-1", GrafanaConfig: cfg, DataSourceInstanceSettings: settings},
	}
	t.Cleanup(s.svc.Dispose)
	ctx := config.WithGrafanaConfig(backend.WithPluginContext(t.Context(), s.pCtx), cfg)
	s.ctx = sdkhttpclient.WithContextualMiddleware(ctx, s.recordContentType())
	return s
}

func (s *session) recordContentType() sdkhttpclient.Middleware {
	return sdkhttpclient.NamedMiddlewareFunc("integration-content-type", func(_ sdkhttpclient.Options, next http.RoundTripper) http.RoundTripper {
		return sdkhttpclient.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
			res, err := next.RoundTrip(req)
			if err == nil {
				s.contentType.Store(res.Header.Get("Content-Type"))
			}
			return res, err
		})
	})
}

func TestCheckHealth(t *testing.T) {
	for _, tgt := range targets {
		t.Run(tgt.name, func(t *testing.T) {
			s := newSession(t, tgt, false)
			res, err := s.svc.CheckHealth(s.ctx, &backend.CheckHealthRequest{PluginContext: s.pCtx})
			if err != nil {
				t.Fatalf("CheckHealth: %v", err)
			}
			if res.Status != backend.HealthStatusOk {
				t.Errorf("CheckHealth status = %v (%s), want OK", res.Status, res.Message)
			}
		})
	}
}

func TestQueryData(t *testing.T) {
	queries := []struct {
		name    string
		metric  string
		instant bool
		frames  int
	}{
		{name: "instant vector", metric: "it_vector", instant: true, frames: 50},
		{name: "range matrix", metric: "it_matrix", frames: 10},
		{name: "range native histograms", metric: "it_hist", frames: 5},
	}
	for _, tgt := range targets {
		for _, q := range queries {
			t.Run(tgt.name+"/"+q.name, func(t *testing.T) {
				model, err := json.Marshal(models.QueryModel{
					PrometheusQueryProperties: models.PrometheusQueryProperties{Expr: selector(q.metric), Instant: q.instant, Range: !q.instant},
					Interval:                  "15s",
				})
				if err != nil {
					t.Fatal(err)
				}
				run := func(flagOn bool) (backend.DataResponse, string) {
					s := newSession(t, tgt, flagOn)
					res, err := s.svc.QueryData(s.ctx, &backend.QueryDataRequest{PluginContext: s.pCtx, Queries: []backend.DataQuery{{
						RefID: "A", JSON: model, MaxDataPoints: points, Interval: step,
						TimeRange: backend.TimeRange{From: anchor.Add(-window), To: anchor},
					}}})
					if err != nil {
						t.Fatalf("QueryData (flag on %t): %v", flagOn, err)
					}
					rsp := res.Responses["A"]
					if rsp.Error != nil {
						t.Fatalf("QueryData (flag on %t): response error: %v", flagOn, rsp.Error)
					}
					if len(rsp.Frames) != q.frames {
						t.Errorf("QueryData (flag on %t) returned %d frames, want %d", flagOn, len(rsp.Frames), q.frames)
					}
					contentType, _ := s.contentType.Load().(string)
					return rsp, contentType
				}

				off, offType := run(false)
				on, onType := run(true)
				if !strings.HasPrefix(offType, "application/json") {
					t.Errorf("flag off: Content-Type = %q, want application/json", offType)
				}
				wantOnType := "application/json"
				if tgt.answersProtobuf {
					wantOnType = converter.MimirProtobufMediaType
				}
				if !strings.HasPrefix(onType, wantOnType) {
					t.Errorf("flag on: Content-Type = %q, want %s", onType, wantOnType)
				}
				if !slices.EqualFunc(canonicalFrames(t, off.Frames), canonicalFrames(t, on.Frames), bytes.Equal) {
					t.Error("frames with the flag on differ from frames with the flag off")
				}
			})
		}
	}
}

// canonicalFrames sorts the frames' Arrow bytes, because instant vector order varies, and drops per-request metadata:
// Mimir's Server-Timing stats, and the executed query and calculated step that only the first frame carries.
func canonicalFrames(t *testing.T, frames data.Frames) [][]byte {
	t.Helper()
	out := make([][]byte, 0, len(frames))
	for _, f := range frames {
		if f.Meta != nil {
			f.Meta.Stats = nil
			f.Meta.ExecutedQueryString = ""
			if custom, ok := f.Meta.Custom.(map[string]any); ok {
				delete(custom, "calculatedMinStep")
			}
		}
		b, err := f.MarshalArrow()
		if err != nil {
			t.Fatalf("marshal frame: %v", err)
		}
		out = append(out, b)
	}
	slices.SortFunc(out, bytes.Compare)
	return out
}
