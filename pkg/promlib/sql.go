package promlib

import (
	"encoding/json"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	schemas "github.com/grafana/schemads"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

// normalizeGrafanaSQLRequest rewrites schemads tabular queries into native
// Prometheus range queries. Queries without GrafanaSql=true are passed through
// unchanged. The metric (table) name becomes the PromQL expression.
// Returns the modified request and the set of refIDs that were schemads queries
// (so their responses can be flattened).
func normalizeGrafanaSQLRequest(req *backend.QueryDataRequest) (*backend.QueryDataRequest, map[string]struct{}) {
	if req == nil || len(req.Queries) == 0 {
		return req, nil
	}

	grafanaConfig := req.PluginContext.GrafanaConfig
	queries := make([]backend.DataQuery, 0, len(req.Queries))
	schemadsRefIDs := make(map[string]struct{})

	for _, q := range req.Queries {
		var query schemas.Query
		if err := json.Unmarshal(q.JSON, &query); err != nil {
			queries = append(queries, q)
			continue
		}

		if !query.GrafanaSql || query.Table == "" {
			queries = append(queries, q)
			continue
		}

		if grafanaConfig == nil {
			backend.Logger.Warn("grafanaConfig is not set, skipping schemads query")
			continue
		}
		if !grafanaConfig.FeatureToggles().IsEnabled("dsAbstractionApp") {
			backend.Logger.Warn("dsAbstractionApp is not enabled, skipping schemads query")
			continue
		}

		// Build the PromQL expression. If a table function is specified
		// (e.g. prometheus_rate), wrap the metric accordingly.
		expr := query.Table
		funcName, funcArgs := extractFunctionContext(q.JSON)
		if funcName == "prometheus_rate" {
			duration := funcArgs["duration"]
			if duration == "" {
				duration = "5m"
			}
			expr = "rate(" + query.Table + "[" + duration + "])"
		}

		promQuery := models.QueryModel{
			PrometheusQueryProperties: models.PrometheusQueryProperties{
				Expr:   expr,
				Range:  true,
				Format: models.PromQueryFormatTimeSeries,
			},
		}
		promQuery.RefID = query.RefID
		promQuery.MaxDataPoints = q.MaxDataPoints
		promQuery.IntervalMS = float64(q.Interval.Milliseconds())

		raw, err := json.Marshal(promQuery)
		if err != nil {
			backend.Logger.Warn("failed to marshal prometheus query from schemads", "error", err)
			queries = append(queries, q)
			continue
		}

		q.JSON = raw
		queries = append(queries, q)
		schemadsRefIDs[q.RefID] = struct{}{}
	}

	req.Queries = queries
	if len(schemadsRefIDs) == 0 {
		return req, nil
	}
	return req, schemadsRefIDs
}

// extractFunctionContext extracts functionName and functionArgs from the raw
// query JSON. These fields are set by the dsabstraction table function engine
// when a query originates from a table function call.
func extractFunctionContext(raw json.RawMessage) (string, map[string]string) {
	var payload struct {
		FunctionName string            `json:"functionName"`
		FunctionArgs map[string]string `json:"functionArgs"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", nil
	}
	return payload.FunctionName, payload.FunctionArgs
}
