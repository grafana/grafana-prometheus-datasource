package datasource

import (
	"context"
	"sync"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/config"

	"github.com/grafana/grafana-prometheus-datasource/pkg/datasource/internal/hostlimit"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib"
)

var hostLimiter = sync.OnceValue(func() *hostlimit.Limiter {
	limiter, err := hostlimit.FromEnv()
	if err != nil {
		backend.Logger.Error("Ignoring invalid per-host request limit", "error", err)
	} else if limiter.Limit() > 0 {
		backend.Logger.Info("Per-host request limit enabled", "limit", limiter.Limit())
	}
	return limiter
})

func NewDatasource(ctx context.Context, dsInstanceSettings backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
	return newDatasource(ctx, dsInstanceSettings, hostLimiter())
}

func newDatasource(ctx context.Context, dsInstanceSettings backend.DataSourceInstanceSettings, limiter *hostlimit.Limiter) (instancemgmt.Instance, error) {
	plog := backend.NewLoggerWith("logger", "tsdb.prometheus")
	plog.Debug("Initializing")
	service, err := promlib.NewDatasourceService(ctx, dsInstanceSettings, sdkhttpclient.NewProvider(), plog, withHostLimit(limiter))
	if err != nil {
		return nil, err
	}
	return &Datasource{Service: service}, nil
}

func withHostLimit(limiter *hostlimit.Limiter) promlib.ExtendOptions {
	return func(_ context.Context, _ backend.DataSourceInstanceSettings, opts *sdkhttpclient.Options, _ log.Logger) error {
		opts.Middlewares = append(opts.Middlewares, limiter.Middleware())
		return nil
	}
}

type Datasource struct {
	Service *promlib.Service
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

func (d *Datasource) ValidateAdmission(ctx context.Context, req *backend.AdmissionRequest) (*backend.ValidationResponse, error) {
	ctx = d.contextualMiddlewares(ctx)
	return d.Service.ValidateAdmission(ctx, req)
}

func (d *Datasource) MutateAdmission(ctx context.Context, req *backend.AdmissionRequest) (*backend.MutationResponse, error) {
	ctx = d.contextualMiddlewares(ctx)
	return d.Service.MutateAdmission(ctx, req)
}

func (d *Datasource) ConvertObjects(ctx context.Context, req *backend.ConversionRequest) (*backend.ConversionResponse, error) {
	ctx = d.contextualMiddlewares(ctx)
	return d.Service.ConvertObjects(ctx, req)
}

func (d *Datasource) contextualMiddlewares(ctx context.Context) context.Context {
	cfg := config.GrafanaConfigFromContext(ctx)

	middlewares := []sdkhttpclient.Middleware{
		sdkhttpclient.ResponseLimitMiddleware(cfg.ResponseLimit()),
	}

	return sdkhttpclient.WithContextualMiddleware(ctx, middlewares...)
}
