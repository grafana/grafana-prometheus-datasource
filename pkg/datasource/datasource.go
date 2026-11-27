package datasource

import (
	"context"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkdatasource "github.com/grafana/grafana-plugin-sdk-go/backend/datasource"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/config"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib"
)

// NewInstanceFactory returns the function that datasource.Manage calls to create the instance of each data source.
func NewInstanceFactory() sdkdatasource.InstanceFactoryFunc {
	newService := promlib.NewServiceFactory(sdkhttpclient.NewProvider(), backend.NewLoggerWith("logger", "tsdb.prometheus"), nil)
	return func(ctx context.Context, settings backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
		return &Datasource{Service: newService(ctx, settings)}, nil
	}
}

type Datasource struct {
	Service *promlib.Service
}

func (d *Datasource) Dispose() {
	d.Service.Dispose()
}

func (d *Datasource) QueryData(ctx context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
	ctx = d.contextualMiddlewares(ctx)
	return d.Service.QueryData(ctx, req)
}

func (d *Datasource) CallResource(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	ctx = d.contextualMiddlewares(ctx)
	return d.Service.CallResource(ctx, req, sender)
}

func (d *Datasource) GetBuildInfo(ctx context.Context, req promlib.BuildInfoRequest) (*promlib.BuildInfoResponse, error) {
	ctx = d.contextualMiddlewares(ctx)
	return d.Service.GetBuildInfo(ctx, req)
}

func (d *Datasource) GetHeuristics(ctx context.Context, req promlib.HeuristicsRequest) (*promlib.Heuristics, error) {
	ctx = d.contextualMiddlewares(ctx)
	return d.Service.GetHeuristics(ctx, req)
}

func (d *Datasource) CheckHealth(ctx context.Context, req *backend.CheckHealthRequest) (*backend.CheckHealthResult,
	error) {
	ctx = d.contextualMiddlewares(ctx)
	return d.Service.CheckHealth(ctx, req)
}

func (d *Datasource) contextualMiddlewares(ctx context.Context) context.Context {
	cfg := config.GrafanaConfigFromContext(ctx)

	middlewares := []sdkhttpclient.Middleware{
		sdkhttpclient.ResponseLimitMiddleware(cfg.ResponseLimit()),
	}

	return sdkhttpclient.WithContextualMiddleware(ctx, middlewares...)
}
