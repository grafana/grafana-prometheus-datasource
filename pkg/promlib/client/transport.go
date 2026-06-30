package client

import (
	"context"
	"fmt"
	"net/http"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/middleware"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

// CreateTransportOptions creates options for the http client.
func CreateTransportOptions(ctx context.Context, settings backend.DataSourceInstanceSettings, logger log.Logger) (*sdkhttpclient.Options, error) {
	opts, err := settings.HTTPClientOptions(ctx)
	if err != nil {
		return nil, fmt.Errorf("error getting HTTP options: %w", err)
	}

	jsonData, err := models.ParsePromOptions(settings)
	if err != nil {
		return nil, fmt.Errorf("error reading settings: %w", err)
	}

	middlewares := []sdkhttpclient.Middleware{
		middleware.CustomQueryParameters(logger, jsonData),
	}
	if jsonData.HTTPMethod == http.MethodGet {
		middlewares = append(middlewares, middleware.ForceHttpGet(logger))
	}
	opts.Middlewares = middlewares

	return &opts, nil
}
