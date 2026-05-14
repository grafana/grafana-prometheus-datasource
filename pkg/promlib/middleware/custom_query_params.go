package middleware

import (
	"net/http"
	"net/url"
	"strconv"

	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

const (
	customQueryParametersMiddlewareName = "prom-custom-query-parameters"
	customQueryParametersKey            = "customQueryParameters"
	grafanaDataKey                      = "grafanaData"
	warningThresholdKey           		= "max_samples_processed_warning_threshold"
	errorThresholdKey              		= "max_samples_processed_error_threshold"
)

func CustomQueryParameters(logger log.Logger) sdkhttpclient.Middleware {
	return sdkhttpclient.NamedMiddlewareFunc(customQueryParametersMiddlewareName, func(opts sdkhttpclient.Options, next http.RoundTripper) http.RoundTripper {
		grafanaData, exists := opts.CustomOptions[grafanaDataKey]
		if !exists {
			return next
		}

		data, ok := grafanaData.(map[string]any)
		if !ok {
			return next
		}

		customQueryParams := ""
		if v, ok := data[customQueryParametersKey].(string); ok {
			customQueryParams = v
		}

		warnVal, _ := data[warningThresholdKey].(float64)
		errVal, _ := data[errorThresholdKey].(float64)

		if customQueryParams == "" && warnVal == 0 && errVal == 0 {
			return next
		}

		values := url.Values{}
		if customQueryParams != "" {
			parsed, err := url.ParseQuery(customQueryParams)
			if err != nil {
				logger.Error("Failed to parse custom query parameters, skipping middleware", "error", err)
				return next
			}
			values = parsed
		}

		if warnVal > 0 {
			values.Set(warningThresholdKey, strconv.FormatFloat(warnVal, 'f', -1, 64))
		}
		if errVal > 0 {
			values.Set(errorThresholdKey, strconv.FormatFloat(errVal, 'f', -1, 64))
		}

		return sdkhttpclient.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
			q := req.URL.Query()
			for k, keyValues := range values {
				for _, value := range keyValues {
					q.Add(k, value)
				}
			}
			req.URL.RawQuery = q.Encode()

			return next.RoundTrip(req)
		})
	})
}
