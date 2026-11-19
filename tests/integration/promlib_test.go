//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	sdklog "github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/config"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

type session struct {
	svc  *promlib.Service
	ctx  context.Context
	pCtx backend.PluginContext
}

func newSession(t *testing.T, tgt target) *session {
	t.Helper()
	settings := &backend.DataSourceInstanceSettings{
		ID: 1, UID: tgt.name, Name: tgt.name, Type: "prometheus", URL: tgt.queryURL,
		JSONData: []byte(`{"httpMethod":"POST","timeInterval":"15s"}`), Updated: time.Unix(1, 0),
	}
	s := &session{
		svc:  promlib.NewService(sdkhttpclient.NewProvider(), sdklog.NewNullLogger(), nil),
		pCtx: backend.PluginContext{OrgID: 1, GrafanaConfig: config.NewGrafanaCfg(nil), DataSourceInstanceSettings: settings},
	}
	t.Cleanup(s.svc.Dispose)
	s.ctx = backend.WithPluginContext(t.Context(), s.pCtx)
	return s
}

func TestCheckHealth(t *testing.T) {
	for _, tgt := range targets {
		t.Run(tgt.name, func(t *testing.T) {
			s := newSession(t, tgt)
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
				s := newSession(t, tgt)
				res, err := s.svc.QueryData(s.ctx, &backend.QueryDataRequest{PluginContext: s.pCtx, Queries: []backend.DataQuery{{
					RefID: "A", JSON: model, MaxDataPoints: points, Interval: step,
					TimeRange: backend.TimeRange{From: anchor.Add(-window), To: anchor},
				}}})
				if err != nil {
					t.Fatalf("QueryData: %v", err)
				}
				rsp := res.Responses["A"]
				if rsp.Error != nil {
					t.Fatalf("QueryData response error: %v", rsp.Error)
				}
				if len(rsp.Frames) != q.frames {
					t.Errorf("QueryData returned %d frames, want %d", len(rsp.Frames), q.frames)
				}
			})
		}
	}
}
