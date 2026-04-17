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

// schemadsQuery extends schemas.Query with the tableHintValues field
// that comes from FOR (...) clauses in SQL.
type schemadsQuery struct {
	schemas.Query
	TableHintValues map[string]string `json:"tableHintValues,omitempty"`
}

// normalizeGrafanaSQLRequest rewrites schemads tabular queries into native
// Prometheus queries. Queries without GrafanaSql=true are passed through
// unchanged.
//
// Datasource hints from FOR (...) clauses control execution:
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

		hints := query.TableHintValues
		if hints == nil {
			hints = map[string]string{}
		}

		expr, err := buildPromQLExpr(query.Table, query.Filters, hints)
		if err != nil {
			backend.Logger.Warn("failed to build PromQL expression from schemads", "error", err)
			queries = append(queries, q)
			continue
		}

		_, isInstant := hints["INSTANT"]
		promQuery := models.QueryModel{
			PrometheusQueryProperties: models.PrometheusQueryProperties{
				Expr:    expr,
				Range:   !isInstant,
				Instant: isInstant,
				Format:  models.PromQueryFormatTimeSeries,
			},
		}
		promQuery.RefID = query.RefID
		promQuery.MaxDataPoints = q.MaxDataPoints
		promQuery.IntervalMS = float64(q.Interval.Milliseconds())

		// STEP hint: override query interval/resolution
		if step := hints["STEP"]; step != "" {
			if stepDur, err := time.ParseDuration(step); err == nil {
				promQuery.IntervalMS = float64(stepDur.Milliseconds())
				promQuery.Interval = step
				q.Interval = stepDur
				q.MaxDataPoints = int64(q.TimeRange.Duration().Seconds() / stepDur.Seconds())
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

// buildPromQLExpr constructs a PromQL expression from a metric name, schemads
// filters, and datasource hints. Uses the Prometheus parser for safe AST
// construction.
func buildPromQLExpr(metric string, filters []schemas.ColumnFilter, hints map[string]string) (string, error) {
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

	// Build the base metric selector with any filters.
	var baseExpr string
	if len(matchers) > 0 {
		allMatchers := append([]*labels.Matcher{labels.MustNewMatcher(labels.MatchEqual, "__name__", metric)}, matchers...)
		vs := &parser.VectorSelector{LabelMatchers: allMatchers}
		baseExpr = vs.String()
	} else {
		baseExpr = metric
	}

	// RATE hint: wrap with rate(expr[duration])
	if rateDuration := hints["RATE"]; rateDuration != "" {
		dur, err := time.ParseDuration(rateDuration)
		if err != nil {
			return "", fmt.Errorf("invalid rate duration %q: %w", rateDuration, err)
		}
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
	}

	return baseExpr, nil
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
