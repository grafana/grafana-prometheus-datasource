package datasource

import (
	"context"
	"os"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/config"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/instrumentation"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/querydata"
)

// replySizeGuardEnv turns the reply size guard off when set to false or 0. Grafana passes [plugin.<id>] reply_size_guard as this variable.
const replySizeGuardEnv = "GF_PLUGIN_REPLY_SIZE_GUARD"

func NewDatasource(ctx context.Context, dsInstanceSettings backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
	plog := backend.NewLoggerWith("logger", "tsdb.prometheus")
	plog.Debug("Initializing")
	d := &Datasource{
		Service: promlib.NewService(sdkhttpclient.NewProvider(), plog, nil),
		log:     plog,
	}
	if v := os.Getenv(replySizeGuardEnv); v != "false" && v != "0" {
		d.maxReplySize = querydata.MaxReplySize
	}
	return d, nil
}

type Datasource struct {
	Service      *promlib.Service
	log          log.Logger
	maxReplySize int64
}

func (d *Datasource) QueryData(ctx context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
	ctx = d.contextualMiddlewares(ctx)
	resp, err := d.Service.QueryData(ctx, req)
	if err != nil || d.maxReplySize == 0 {
		return resp, err
	}
	if size, rejected := querydata.RejectOversizedReply(resp, d.maxReplySize); rejected {
		instrumentation.UpdateReplySizeGuardMetrics()
		d.log.FromContext(ctx).Warn("Rejected a query reply over the message size limit", "bytesAtLeast", size, "limit", d.maxReplySize, "queries", len(req.Queries))
	}
	return resp, nil
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
