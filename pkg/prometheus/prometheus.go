package prometheus

import (
	"context"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib"
)

type prometheusLib interface {
	QueryData(ctx context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error)
	CallResource(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error
	GetBuildInfo(ctx context.Context, req promlib.BuildInfoRequest) (*promlib.BuildInfoResponse, error)
	GetHeuristics(ctx context.Context, req promlib.HeuristicsRequest) (*promlib.Heuristics, error)
	CheckHealth(ctx context.Context, req *backend.CheckHealthRequest) (*backend.CheckHealthResult, error)
}

type Service struct {
	lib prometheusLib
}

func ProvideService(httpClientProvider *sdkhttpclient.Provider) *Service {
	plog := backend.NewLoggerWith("logger", "tsdb.prometheus")
	plog.Debug("Initializing")
	return &Service{
		lib: promlib.NewService(httpClientProvider, plog, nil),
	}
}

func (s *Service) QueryData(ctx context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
	return s.lib.QueryData(ctx, req)
}

func (s *Service) CallResource(ctx context.Context, req *backend.CallResourceRequest, sender backend.CallResourceResponseSender) error {
	return s.lib.CallResource(ctx, req, sender)
}

func (s *Service) GetBuildInfo(ctx context.Context, req promlib.BuildInfoRequest) (*promlib.BuildInfoResponse, error) {
	return s.lib.GetBuildInfo(ctx, req)
}

func (s *Service) GetHeuristics(ctx context.Context, req promlib.HeuristicsRequest) (*promlib.Heuristics, error) {
	return s.lib.GetHeuristics(ctx, req)
}

func (s *Service) CheckHealth(ctx context.Context, req *backend.CheckHealthRequest) (*backend.CheckHealthResult,
	error) {
	return s.lib.CheckHealth(ctx, req)
}
