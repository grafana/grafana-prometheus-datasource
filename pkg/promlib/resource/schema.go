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

// prometheusTableParams are table parameters that control query behavior.
// They appear as virtual columns in WHERE clauses. Optional (not required)
// so they don't interfere with underscore-based table name encoding.
var prometheusTableParams = []schemas.TableParameter{
	{Name: "promrate", Root: true, Required: false},       // rate duration e.g. "5m"
	{Name: "prominstant", Root: true, Required: false},   // "true" for instant query (default: range)
	{Name: "promstep", Root: true, Required: false},      // query step/resolution e.g. "15s", "1m"
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
			Tables: tables,
		},
	}, nil
}

// Tables implements schemas.TablesHandler.
func (p *SchemaProvider) Tables(ctx context.Context, _ *schemas.TablesRequest) (*schemas.TablesResponse, error) {
	names, err := p.fetchMetricNames(ctx)
	if err != nil {
		return nil, err
	}
	// Declare table parameters for every metric.
	tableParams := make(map[string][]schemas.TableParameter, len(names))
	for _, name := range names {
		tableParams[name] = prometheusTableParams
	}
	return &schemas.TablesResponse{Tables: names, TableParameters: tableParams}, nil
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
func (p *SchemaProvider) fetchPrometheusLabels(ctx context.Context, path string, params url.Values, context string) ([]string, error) {
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
		return nil, fmt.Errorf("failed to fetch labels (context=%q): %w", context, err)
	}
	defer resp.Body.Close()

	var result prometheusLabelsResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode labels response (context=%q): %w", context, err)
	}

	if result.Status != "success" {
		return nil, fmt.Errorf("prometheus returned status %q (context=%q)", result.Status, context)
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
			Name:            name,
			Columns:         baseColumns,
			TableParameters: prometheusTableParams,
		}
	}
	return tables, nil
}
