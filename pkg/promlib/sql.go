package promlib

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	schemas "github.com/grafana/schemads"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

// schemadsQuery extends schemas.Query with the datasourceHints field
// that comes from FOR (...) clauses in SQL.
type schemadsQuery struct {
	schemas.Query
	DatasourceHints map[string]string `json:"datasourceHints,omitempty"`
}

// normalizeGrafanaSQLRequest rewrites schemads tabular queries into native
// Prometheus range queries. Queries without GrafanaSql=true are passed through
// unchanged. The metric (table) name becomes the PromQL expression, and
// datasource hints from FOR (...) clauses control rate/step/instant behavior.
//
// Supported hints:
//
//	RATE('5m')  — wraps metric with rate(metric[5m])
//	STEP('30s') — overrides query step/resolution
//	INSTANT     — switches to instant query mode
//
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
		var query schemadsQuery
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

		expr := buildPromQLFromHints(query.Table, query.Filters, query.DatasourceHints)

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

		// INSTANT hint: switch from range to instant query
		if _, ok := query.DatasourceHints["INSTANT"]; ok {
			promQuery.Instant = true
			promQuery.Range = false
		}

		// STEP hint: override query interval/resolution
		if stepStr, ok := query.DatasourceHints["STEP"]; ok && stepStr != "" {
			if d, err := time.ParseDuration(stepStr); err == nil {
				promQuery.IntervalMS = float64(d.Milliseconds())
				// Set a low MaxDataPoints so the interval calculator doesn't override our step
				promQuery.MaxDataPoints = 1
			}
		}

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

// buildPromQLFromHints constructs a PromQL expression from a metric name,
// schemads column filters, and datasource hints.
func buildPromQLFromHints(metric string, filters []schemas.ColumnFilter, hints map[string]string) string {
	// Build label matchers from column filters
	var matchers []string
	for _, f := range filters {
		if f.Name == "timestamp" || f.Name == "value" {
			continue
		}
		for _, cond := range f.Conditions {
			op := "="
			switch cond.Operator {
			case schemas.OperatorEquals:
				op = "="
			case schemas.OperatorNotEquals:
				op = "!="
			default:
				continue
			}
			matchers = append(matchers, fmt.Sprintf(`%s%s"%v"`, f.Name, op, cond.Value))
		}
	}

	// Base expression: metric{matchers}
	expr := metric
	if len(matchers) > 0 {
		expr = fmt.Sprintf("%s{%s}", metric, strings.Join(matchers, ", "))
	}

	// RATE hint: wrap with rate(expr[duration])
	if rateDur, ok := hints["RATE"]; ok && rateDur != "" {
		if len(matchers) > 0 {
			expr = fmt.Sprintf("rate(%s{%s}[%s])", metric, strings.Join(matchers, ", "), rateDur)
		} else {
			expr = fmt.Sprintf("rate(%s[%s])", metric, rateDur)
		}
	}

	return expr
}
