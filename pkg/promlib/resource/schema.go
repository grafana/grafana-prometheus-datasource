package resource

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

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

// metricsColumns is the fixed column schema for every Prometheus metric table.
var metricsColumns = []schemas.Column{
	{Name: "timestamp", Type: schemas.ColumnTypeDatetime},
	{Name: "value", Type: schemas.ColumnTypeFloat64},
}

// Schema implements schemas.SchemaHandler.
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
	return &schemas.TablesResponse{Tables: names}, nil
}

// Columns implements schemas.ColumnsHandler.
func (p *SchemaProvider) Columns(_ context.Context, req *schemas.ColumnsRequest) (*schemas.ColumnsResponse, error) {
	columns := make(map[string][]schemas.Column, len(req.Tables))
	for _, table := range req.Tables {
		columns[table] = metricsColumns
	}
	return &schemas.ColumnsResponse{Columns: columns}, nil
}

// prometheusLabelsResponse is the JSON shape returned by /api/v1/label/__name__/values.
type prometheusLabelsResponse struct {
	Status string   `json:"status"`
	Data   []string `json:"data"`
}

// fetchMetricNames calls the Prometheus /api/v1/label/__name__/values endpoint.
func (p *SchemaProvider) fetchMetricNames(ctx context.Context) ([]string, error) {
	path := "api/v1/label/__name__/values"
	resp, err := p.resource.promClient.QueryResource(ctx, &backend.CallResourceRequest{
		Method: http.MethodGet,
		Path:   path,
		URL:    path,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to fetch metric names: %w", err)
	}
	defer resp.Body.Close()

	var result prometheusLabelsResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode metric names response: %w", err)
	}

	if result.Status != "success" {
		return nil, fmt.Errorf("prometheus returned status %q for label values", result.Status)
	}

	return result.Data, nil
}

// fetchMetricTables returns schema Tables with the fixed columns for each metric.
func (p *SchemaProvider) fetchMetricTables(ctx context.Context) ([]schemas.Table, error) {
	names, err := p.fetchMetricNames(ctx)
	if err != nil {
		return nil, err
	}
	tables := make([]schemas.Table, len(names))
	for i, name := range names {
		tables[i] = schemas.Table{
			Name:    name,
			Columns: metricsColumns,
		}
	}
	return tables, nil
}
