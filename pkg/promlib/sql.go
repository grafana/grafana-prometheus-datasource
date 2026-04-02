package promlib

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/prometheus/prometheus/model/labels"
	"github.com/prometheus/prometheus/promql/parser"
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

		// Build the PromQL expression using the Prometheus parser.
		funcName, funcArgs := extractFunctionContext(q.JSON)
		expr, err := buildPromQLExpr(query.Table, funcName, funcArgs, query.Filters)
		if err != nil {
			backend.Logger.Warn("failed to build PromQL expression from schemads", "error", err)
			queries = append(queries, q)
			continue
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

// buildPromQLExpr constructs a PromQL expression from a metric name, optional
// table function context, and schemads column filters. It uses the Prometheus
// parser to build a proper AST rather than string concatenation, which makes
// filter injection safe and composable.
func buildPromQLExpr(metric, funcName string, funcArgs map[string]string, filters []schemas.ColumnFilter) (string, error) {
	// Build label matchers from schemads filters.
	var matchers []*labels.Matcher
	for _, f := range filters {
		for _, cond := range f.Conditions {
			m, err := schemadsFilterToMatcher(f.Name, cond)
			if err != nil {
				continue
			}
			matchers = append(matchers, m)
		}
	}

	// Start with a plain metric selector.
	baseExpr := metric
	if len(matchers) > 0 {
		// Build metric{label="value",...} via parser round-trip.
		allMatchers := append([]*labels.Matcher{labels.MustNewMatcher(labels.MatchEqual, "__name__", metric)}, matchers...)
		vs := &parser.VectorSelector{LabelMatchers: allMatchers}
		baseExpr = vs.String()
	}

	// Wrap in function call if a table function is specified.
	switch funcName {
	case "prometheus_rate":
		duration := funcArgs["duration"]
		if duration == "" {
			duration = "5m"
		}
		dur, err := time.ParseDuration(duration)
		if err != nil {
			return "", fmt.Errorf("invalid duration %q: %w", duration, err)
		}
		// Parse the base expression so we can wrap it in a Call AST node.
		innerExpr, err := parser.ParseExpr(baseExpr)
		if err != nil {
			return "", fmt.Errorf("failed to parse base expression %q: %w", baseExpr, err)
		}
		call := &parser.Call{
			Func: parser.Functions["rate"],
			Args: parser.Expressions{
				&parser.MatrixSelector{
					VectorSelector: innerExpr,
					Range:          dur,
				},
			},
		}
		return call.String(), nil
	case "":
		// No function — plain metric query.
		return baseExpr, nil
	default:
		return "", fmt.Errorf("unsupported function %q", funcName)
	}
}

// schemadsFilterToMatcher converts a schemads filter condition to a Prometheus
// label matcher.
func schemadsFilterToMatcher(name string, cond schemas.FilterCondition) (*labels.Matcher, error) {
	var mt labels.MatchType
	switch cond.Operator {
	case schemas.OperatorEquals:
		mt = labels.MatchEqual
	case schemas.OperatorNotEquals:
		mt = labels.MatchNotEqual
	case schemas.OperatorLike:
		mt = labels.MatchRegexp
	default:
		return nil, fmt.Errorf("unsupported operator %q for Prometheus", cond.Operator)
	}
	value := fmt.Sprintf("%v", cond.Value)
	return labels.NewMatcher(mt, name, value)
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
