package resource

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	schemas "github.com/grafana/schemads"
)

// SchemaProvider implements schemads SchemaHandler, TablesHandler, and ColumnsHandler
// for the Prometheus datasource, providing schema metadata to the dsabstraction app.
type SchemaProvider struct {
	resource *Resource
}

func NewSchemaProvider(r *Resource) *SchemaProvider {
	return &SchemaProvider{resource: r}
}

// baseColumns are the fixed columns present in every Prometheus metric table.
var baseColumns = []schemas.Column{
	{Name: "timestamp", Type: schemas.ColumnTypeDatetime},
	{Name: "value", Type: schemas.ColumnTypeFloat64},
}

// prometheusTableHints declares the per-table execution hints that
// Prometheus supports via FOR (...) clauses.
var prometheusTableHints = []schemas.TableHint{
	{Name: "rate", Description: "Apply rate() with the given duration window, e.g. rate('5m')", HasValue: true},
	{Name: "step", Description: "Override the query step/resolution, e.g. step('30s')", HasValue: true},
	{Name: "instant", Description: "Execute as an instant query instead of a range query"},
}

// prometheusCapabilities declares what SQL operations Prometheus can
// handle natively. The SQL engine uses this to push operations down.
//
// AVG is intentionally excluded: Prometheus's "avg by" preserves the
// time axis (one value per timestamp), so re-averaging those values
// gives an incorrect result when series cardinality varies across
// timestamps. The SQL engine handles AVG from raw data instead.
var prometheusCapabilities = &schemas.DatasourceCapabilities{
	AggregateFunctions: []string{"SUM", "COUNT", "MIN", "MAX"},
}

// Schema implements schemas.SchemaHandler.
// For fullSchema, tables are returned without label columns since that would
// require a per-metric labels call for every metric. Use Columns() for
// per-table label discovery.
func (p *SchemaProvider) Schema(ctx context.Context, _ *schemas.SchemaRequest) (*schemas.SchemaResponse, error) {
	tables, err := p.fetchMetricTables(ctx)
	if err != nil {
		return nil, err
	}
	return &schemas.SchemaResponse{
		FullSchema: &schemas.Schema{
			Tables:       tables,
			Capabilities: prometheusCapabilities,
		},
	}, nil
}

// Tables implements schemas.TablesHandler.
func (p *SchemaProvider) Tables(ctx context.Context, _ *schemas.TablesRequest) (*schemas.TablesResponse, error) {
	names, err := p.fetchMetricNames(ctx)
	if err != nil {
		return nil, err
	}
	return &schemas.TablesResponse{Tables: names, Capabilities: prometheusCapabilities}, nil
}

// Columns implements schemas.ColumnsHandler.
// For each requested table (metric), it fetches the label names from Prometheus
// and returns timestamp + value + sorted label columns.
func (p *SchemaProvider) Columns(ctx context.Context, req *schemas.ColumnsRequest) (*schemas.ColumnsResponse, error) {
	columns := make(map[string][]schemas.Column, len(req.Tables))
	for _, metric := range req.Tables {
		labels, err := p.fetchLabelNames(ctx, metric)
		if err != nil {
			p.resource.log.Warn("failed to fetch labels for metric", "metric", metric, "error", err)
			columns[metric] = baseColumns
			continue
		}
		columns[metric] = buildMetricColumns(labels)
	}
	return &schemas.ColumnsResponse{Columns: columns}, nil
}

// buildMetricColumns returns timestamp + value + alphabetically sorted label columns.
func buildMetricColumns(labels []string) []schemas.Column {
	sort.Strings(labels)

	cols := make([]schemas.Column, 0, len(baseColumns)+len(labels))
	cols = append(cols, baseColumns...)
	for _, label := range labels {
		if label == "__name__" {
			continue
		}
		cols = append(cols, schemas.Column{
			Name:      label,
			Type:      schemas.ColumnTypeString,
			Operators: []schemas.Operator{schemas.OperatorEquals, schemas.OperatorIn},
		})
	}
	return cols
}

// prometheusLabelsResponse is the JSON shape returned by /api/v1/labels and
// /api/v1/label/__name__/values.
type prometheusLabelsResponse struct {
	Status string   `json:"status"`
	Data   []string `json:"data"`
}

// fetchMetricNames calls the Prometheus /api/v1/label/__name__/values endpoint.
func (p *SchemaProvider) fetchMetricNames(ctx context.Context) ([]string, error) {
	return p.fetchPrometheusLabels(ctx, "api/v1/label/__name__/values", nil, "")
}

// fetchLabelNames calls /api/v1/labels?match[]=<metric> to get the label keys
// for a specific metric.
func (p *SchemaProvider) fetchLabelNames(ctx context.Context, metric string) ([]string, error) {
	params := url.Values{}
	params.Set("match[]", metric)
	return p.fetchPrometheusLabels(ctx, "api/v1/labels", params, metric)
}

// fetchPrometheusLabels is the shared helper for fetching label data from Prometheus.
func (p *SchemaProvider) fetchPrometheusLabels(ctx context.Context, path string, params url.Values, description string) ([]string, error) {
	reqURL := path
	if len(params) > 0 {
		reqURL = path + "?" + params.Encode()
	}
	resp, err := p.resource.promClient.QueryResource(ctx, &backend.CallResourceRequest{
		Method: http.MethodGet,
		Path:   path,
		URL:    reqURL,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to fetch labels (description=%q): %w", description, err)
	}
	defer resp.Body.Close()

	var result prometheusLabelsResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode labels response (description=%q): %w", description, err)
	}

	if result.Status != "success" {
		return nil, fmt.Errorf("prometheus returned status %q (description=%q)", result.Status, description)
	}

	return result.Data, nil
}

// fetchMetricTables returns schema Tables with only the base columns.
// Full per-metric label columns are discovered lazily via Columns().
func (p *SchemaProvider) fetchMetricTables(ctx context.Context) ([]schemas.Table, error) {
	names, err := p.fetchMetricNames(ctx)
	if err != nil {
		return nil, err
	}
	tables := make([]schemas.Table, len(names))
	for i, name := range names {
		tables[i] = schemas.Table{
			Name:    name,
			Columns: baseColumns,
			TableHints: prometheusTableHints,
		}
	}
	return tables, nil
}
