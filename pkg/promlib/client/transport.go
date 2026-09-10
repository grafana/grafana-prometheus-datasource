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

	// Forward Grafana-provided HTTP headers (e.g. FromAlert, X-Rule-*, X-Dashboard-*,
	// X-Panel-*, X-Grafana-Org-Id, X-Grafana-User) to the outgoing datasource request.
	// When running as an external plugin, Grafana's in-process header-forwarding
	// middleware does not cross the gRPC boundary, so the SDK's header middleware must
	// do the forwarding here.
	opts.ForwardHTTPHeaders = true

	// Custom HTTP headers configured on the datasource are applied by the SDK's
	// CustomHeadersMiddleware, which deletes and re-adds each one on the outgoing
	// request. A custom Accept-Encoding would therefore replace the encoding the
	// resource path pins for itself, and the response would come back in an
	// encoding the resource handlers cannot decode. Response compression is
	// negotiated by the plugin rather than configured by the user, so drop it.
	if opts.Header.Get("Accept-Encoding") != "" {
		logger.Warn("Ignoring custom Accept-Encoding header, the datasource negotiates response compression itself")
		opts.Header.Del("Accept-Encoding")
	}

	return &opts, nil
}
