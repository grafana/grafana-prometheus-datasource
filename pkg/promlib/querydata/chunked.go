package querydata

import (
	"context"
	"fmt"
	"net/http"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	jsoniter "github.com/json-iterator/go"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/converter"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/utils"
)

// ExecuteChunked runs the queries as Execute does, and writes each series as its own chunk, so that the series of
// a response do not all stay in memory. The queries run one after another, and for each query the range request
// runs before the instant request. A failed write ends the request with that error.
func (s *QueryData) ExecuteChunked(ctx context.Context, req *backend.QueryChunkedDataRequest, w backend.ChunkedDataWriter) error {
	fromAlert := req.Headers["FromAlert"] == "true"
	for _, q := range req.Queries {
		if err := s.handleQueryChunked(ctx, q, fromAlert, w); err != nil {
			return err
		}
	}
	return nil
}

func (s *QueryData) handleQueryChunked(ctx context.Context, bq backend.DataQuery, fromAlert bool, w backend.ChunkedDataWriter) error {
	traceCtx, span := s.tracer.Start(ctx, "datasource.prometheus")
	defer span.End()
	q, err := models.Parse(ctx, s.log, span, bq, s.TimeInterval, s.intervalCalculator, fromAlert)
	if err != nil {
		return err
	}

	if q.RangeQuery {
		res, err := s.client.QueryRange(traceCtx, q)
		if err != nil {
			return err
		}
		if err := s.parseResponseChunked(traceCtx, q, res, models.RangeQueryType, w); err != nil {
			return err
		}
	}

	if q.InstantQuery {
		res, err := s.client.QueryInstant(traceCtx, q)
		if err != nil {
			return err
		}
		if err := s.parseResponseChunked(traceCtx, q, res, models.InstantQueryType, w); err != nil {
			return err
		}
	}

	return nil
}

// parseResponseChunked is parseResponse for ExecuteChunked. Each frame gets the same metadata as in parseResponse,
// and its own frame ID, for example range/0.
func (s *QueryData) parseResponseChunked(ctx context.Context, q *models.Query, res *http.Response, queryType models.TimeSeriesQueryType, w backend.ChunkedDataWriter) error {
	defer func() {
		if err := res.Body.Close(); err != nil {
			s.log.FromContext(ctx).Error("Failed to close response body", "err", err)
		}
	}()

	ctx, endSpan := utils.StartTrace(ctx, s.tracer, "datasource.prometheus.parseResponseChunked")
	defer endSpan()

	written := 0
	var writeErr error
	write := func(frame *data.Frame) error {
		addMetadataToMultiFrame(q, frame)
		if written == 0 {
			addFirstFrameMetadata(q, frame, res.Header, queryType)
		}
		writeErr = w.WriteFrame(ctx, q.RefId, fmt.Sprintf("%s/%d", queryType, written), frame)
		written++
		return writeErr
	}

	iter := jsoniter.Parse(jsoniter.ConfigDefault, res.Body, 1024)
	r := converter.ReadPrometheusStyleResult(iter, converter.Options{OnFrame: write})
	if writeErr != nil {
		return writeErr
	}

	// Add frame to attach metadata
	if len(r.Frames) == 0 && written == 0 {
		r.Frames = append(r.Frames, data.NewFrame(""))
	}
	for _, frame := range r.Frames {
		if err := write(frame); err != nil {
			return err
		}
	}
	return nil
}
