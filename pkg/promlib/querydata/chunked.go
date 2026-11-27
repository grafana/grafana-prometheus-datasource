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
// runs before the instant request. A query error goes to the writer as Execute returns it. A failed write ends the
// request with that error.
//
// Prometheus sends the warnings, infos and stats after the result, and only the first chunk of a frame carries its
// metadata. So the converter holds back the last series, and these go on it, where Execute puts the notices on
// every frame and the stats on the first one. Grafana shows the notices of all frames without duplicates, so users
// see the same notices. The exemplar request is read whole, as in Execute, and its frames come last.
func (s *QueryData) ExecuteChunked(ctx context.Context, req *backend.QueryChunkedDataRequest, w backend.ChunkedDataWriter) error {
	fromAlert := req.Headers["FromAlert"] == "true"
	for _, q := range req.Queries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := s.handleQueryChunked(ctx, q, fromAlert, w); err != nil {
			return err
		}
	}
	return nil
}

// handleQueryChunked is handleQuery and fetch for ExecuteChunked. It returns only write errors.
func (s *QueryData) handleQueryChunked(ctx context.Context, bq backend.DataQuery, fromAlert bool, w backend.ChunkedDataWriter) error {
	traceCtx, span := s.tracer.Start(ctx, "datasource.prometheus")
	defer span.End()
	q, err := models.Parse(ctx, s.log, span, bq, s.TimeInterval, s.intervalCalculator, fromAlert)
	if err != nil {
		return writeError(ctx, w, bq.RefID, backend.DataResponse{Error: err})
	}

	// dr joins the errors of the requests as fetch does. The receiver keeps the last error that it gets, so each
	// write sends the errors so far.
	dr := backend.DataResponse{}
	var queryTypes []models.TimeSeriesQueryType
	if q.RangeQuery {
		queryTypes = append(queryTypes, models.RangeQueryType)
	}
	if q.InstantQuery {
		queryTypes = append(queryTypes, models.InstantQueryType)
	}
	for _, queryType := range queryTypes {
		var writeErr error
		res := s.recoverPanic(traceCtx, func() backend.DataResponse {
			var res backend.DataResponse
			res, writeErr = s.queryChunked(traceCtx, q, queryType, w)
			return res
		})
		if writeErr != nil {
			return writeErr
		}
		if res.Error != nil {
			addDataResponse(&res, &dr)
			if err := writeError(ctx, w, q.RefId, dr); err != nil {
				return err
			}
		}
	}

	if q.ExemplarQuery {
		// The sampler needs all exemplars, so the exemplar request is read whole, as in Execute.
		res := s.recoverPanic(traceCtx, func() backend.DataResponse { return s.exemplarQuery(traceCtx, s.client, q) })
		if res.Error != nil {
			// As in fetch, a failed exemplar request is only logged.
			s.log.FromContext(traceCtx).Error("Exemplar query failed", "query", q.Expr, "err", res.Error)
		}
		for i, frame := range res.Frames {
			if err := w.WriteFrame(ctx, q.RefId, fmt.Sprintf("%s/%d", models.ExemplarQueryType, i), frame); err != nil {
				return err
			}
		}
	}
	return nil
}

// queryChunked runs the range or the instant request of q and writes its frames. The returned response has only
// the error of the request. The returned error is a write error.
func (s *QueryData) queryChunked(ctx context.Context, q *models.Query, queryType models.TimeSeriesQueryType, w backend.ChunkedDataWriter) (backend.DataResponse, error) {
	var res *http.Response
	var err error
	if queryType == models.RangeQueryType {
		res, err = s.client.QueryRange(ctx, q)
	} else {
		res, err = s.client.QueryInstant(ctx, q)
	}
	if err != nil {
		return addErrorSourceToDataResponse(err), nil
	}
	return s.parseResponseChunked(ctx, q, res, queryType, w)
}

// parseResponseChunked is parseResponse for ExecuteChunked. Each frame gets the same metadata as in parseResponse,
// and its own frame ID, for example range/0. The returned response has only the error of the request, and the
// returned error is a write error.
func (s *QueryData) parseResponseChunked(ctx context.Context, q *models.Query, res *http.Response, queryType models.TimeSeriesQueryType, w backend.ChunkedDataWriter) (backend.DataResponse, error) {
	defer func() {
		if err := res.Body.Close(); err != nil {
			s.log.FromContext(ctx).Error("Failed to close response body", "err", err)
		}
	}()

	ctx, endSpan := utils.StartTrace(ctx, s.tracer, "datasource.prometheus.parseResponseChunked")
	defer endSpan()

	written := 0
	writeFrame := func(frame *data.Frame) error {
		err := w.WriteFrame(ctx, q.RefId, fmt.Sprintf("%s/%d", queryType, written), frame)
		written++
		return err
	}

	if !isPrometheusResponse(res.StatusCode) {
		r := s.unexpectedResponse(ctx, q, res)
		for _, frame := range r.Frames {
			if err := writeFrame(frame); err != nil {
				return backend.DataResponse{}, err
			}
		}
		return backend.DataResponse{Error: r.Error, ErrorSource: r.ErrorSource}, nil
	}

	var writeErr error
	writeSeries := func(frame *data.Frame) error {
		addMetadataToMultiFrame(q, frame)
		if written == 0 {
			addFirstFrameMetadata(q, frame, res.Header, queryType)
		}
		writeErr = writeFrame(frame)
		return writeErr
	}

	// res.Body is read directly, as in parseResponse.
	iter := jsoniter.Parse(jsoniter.ConfigDefault, res.Body, 1024)
	r := converter.ReadPrometheusStyleResult(iter, converter.Options{OnFrame: writeSeries})
	if writeErr != nil {
		return backend.DataResponse{}, writeErr
	}

	// Add frame to attach metadata
	if len(r.Frames) == 0 && written == 0 && !q.ExemplarQuery {
		r.Frames = append(r.Frames, data.NewFrame(""))
	}
	for _, frame := range r.Frames {
		if err := writeSeries(frame); err != nil {
			return backend.DataResponse{}, err
		}
	}

	if r.Error == nil {
		return backend.DataResponse{}, nil
	}
	return backend.DataResponse{Error: r.Error, Status: backend.Status(res.StatusCode), ErrorSource: r.ErrorSource}, nil
}

// writeError writes the error of rsp with its status. The writer takes the error source from the error.
func writeError(ctx context.Context, w backend.ChunkedDataWriter, refID string, rsp backend.DataResponse) error {
	err := rsp.Error
	if rsp.ErrorSource != "" {
		err = backend.NewErrorWithSource(err, rsp.ErrorSource)
	}
	return w.WriteError(ctx, refID, rsp.Status, err)
}
