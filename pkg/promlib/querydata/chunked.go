package querydata

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	jsoniter "github.com/json-iterator/go"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

const (
	chunkSampleLimit     = 1024
	chunkInitialCapacity = 128
)

// ExecuteChunked executes supported range queries sequentially and streams their frames.
func (s *QueryData) ExecuteChunked(ctx context.Context, req *backend.QueryChunkedDataRequest, w backend.ChunkedDataWriter) error {
	if len(req.Queries) == 0 {
		return fmt.Errorf("query contains no queries")
	}

	fromAlert := req.Headers["FromAlert"] == "true"
	for _, bq := range req.Queries {
		if isGrafanaSQLQuery(bq) {
			err := fmt.Errorf("chunked queries do not support Grafana SQL flattening")
			if writeErr := w.WriteError(ctx, bq.RefID, backend.StatusBadRequest, err); writeErr != nil {
				return writeErr
			}
			continue
		}
		traceCtx, span := s.tracer.Start(ctx, "datasource.prometheus.chunked")
		query, err := models.Parse(traceCtx, s.log, span, bq, s.TimeInterval, s.intervalCalculator, fromAlert)
		span.End()
		if err != nil {
			if writeErr := w.WriteError(ctx, bq.RefID, backend.StatusBadRequest, err); writeErr != nil {
				return writeErr
			}
			continue
		}
		if err := eligibleChunkedQuery(query); err != nil {
			if writeErr := w.WriteError(ctx, bq.RefID, backend.StatusBadRequest, err); writeErr != nil {
				return writeErr
			}
			continue
		}

		res, err := s.client.QueryRange(traceCtx, query)
		if err != nil {
			if writeErr := w.WriteError(ctx, bq.RefID, backend.StatusBadGateway, backend.DownstreamError(err)); writeErr != nil {
				return writeErr
			}
			continue
		}

		err = s.streamMatrix(ctx, query, res, w)
		closeErr := res.Body.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			if writeErr := w.WriteError(ctx, bq.RefID, backend.StatusBadGateway, backend.DownstreamError(err)); writeErr != nil {
				return writeErr
			}
		}
	}
	return nil
}

func isGrafanaSQLQuery(query backend.DataQuery) bool {
	var model struct {
		GrafanaSQL bool `json:"grafanaSql"`
	}
	return json.Unmarshal(query.JSON, &model) == nil && model.GrafanaSQL
}

func eligibleChunkedQuery(q *models.Query) error {
	switch {
	case q.InstantQuery:
		return fmt.Errorf("chunked queries support range queries only")
	case q.ExemplarQuery:
		return fmt.Errorf("chunked queries do not support exemplars")
	case !q.RangeQuery:
		return fmt.Errorf("chunked queries require a range query")
	}
	return nil
}

func (s *QueryData) streamMatrix(ctx context.Context, q *models.Query, res *http.Response, w backend.ChunkedDataWriter) error {
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 1024))
		return fmt.Errorf("unexpected response with status code %d: %s", res.StatusCode, body)
	}

	iter := jsoniter.Parse(jsoniter.ConfigDefault, res.Body, 1024)
	seenStatus, seenData := false, false
	emitted := false
	for key := iter.ReadObject(); key != ""; key = iter.ReadObject() {
		switch key {
		case "status":
			if seenStatus {
				return fmt.Errorf("noncanonical Prometheus response: duplicate status")
			}
			status := iter.ReadString()
			if iter.Error != nil {
				return iter.Error
			}
			if status != "success" {
				return fmt.Errorf("chunked queries require a successful Prometheus response")
			}
			seenStatus = true
		case "data":
			if !seenStatus || seenData {
				return fmt.Errorf("noncanonical Prometheus response: data must follow status")
			}
			var err error
			emitted, err = s.streamMatrixData(ctx, q, iter, w)
			if err != nil {
				return err
			}
			seenData = true
		default:
			return fmt.Errorf("noncanonical Prometheus response: unsupported field %q", key)
		}
	}
	if iter.Error != nil {
		return fmt.Errorf("invalid Prometheus response: %w", iter.Error)
	}
	if !seenStatus || !seenData {
		return fmt.Errorf("noncanonical Prometheus response: expected status and data")
	}
	if !emitted {
		frame := data.NewFrame("")
		addMetadataToMultiFrame(q, frame)
		frame.Meta.ExecutedQueryString = executedQueryString(q)
		if err := w.WriteFrame(ctx, q.RefId, "range/empty", frame); err != nil {
			return err
		}
	}
	return nil
}

func (s *QueryData) streamMatrixData(ctx context.Context, q *models.Query, iter *jsoniter.Iterator, w backend.ChunkedDataWriter) (bool, error) {
	seenType, seenResult := false, false
	emitted := false
	seriesOrdinal := 0
	for key := iter.ReadObject(); key != ""; key = iter.ReadObject() {
		switch key {
		case "resultType":
			if seenType {
				return false, fmt.Errorf("noncanonical Prometheus response: duplicate resultType")
			}
			resultType := iter.ReadString()
			if iter.Error != nil {
				return false, iter.Error
			}
			if resultType != "matrix" {
				return false, fmt.Errorf("chunked queries require matrix results, got %q", resultType)
			}
			seenType = true
		case "result":
			if !seenType || seenResult {
				return false, fmt.Errorf("noncanonical Prometheus response: result must follow resultType")
			}
			for more := iter.ReadArray(); more; more = iter.ReadArray() {
				if iter.Error != nil {
					return false, iter.Error
				}
				frameID := fmt.Sprintf("range/%d", seriesOrdinal)
				includeQueryMetadata := seriesOrdinal == 0
				seriesOrdinal++
				wrote, err := s.streamSeries(ctx, q, iter, w, frameID, includeQueryMetadata)
				if err != nil {
					return false, err
				}
				emitted = emitted || wrote
			}
			if iter.Error != nil {
				return false, iter.Error
			}
			seenResult = true
		default:
			return false, fmt.Errorf("noncanonical Prometheus response: unsupported data field %q", key)
		}
	}
	if iter.Error != nil {
		return false, iter.Error
	}
	if !seenType || !seenResult {
		return false, fmt.Errorf("noncanonical Prometheus response: expected resultType and result")
	}
	return emitted, nil
}

func (s *QueryData) streamSeries(ctx context.Context, q *models.Query, iter *jsoniter.Iterator, w backend.ChunkedDataWriter, frameID string, includeQueryMetadata bool) (bool, error) {
	var labels data.Labels
	seenMetric, seenValues := false, false
	wrote := false
	for key := iter.ReadObject(); key != ""; key = iter.ReadObject() {
		switch key {
		case "metric":
			if seenMetric || seenValues {
				return false, fmt.Errorf("noncanonical matrix series: metric must precede values")
			}
			iter.ReadVal(&labels)
			if iter.Error != nil {
				return false, iter.Error
			}
			seenMetric = true
		case "values":
			if !seenMetric || seenValues {
				return false, fmt.Errorf("noncanonical matrix series: values must follow metric")
			}
			times := make([]time.Time, 0, chunkInitialCapacity)
			values := make([]float64, 0, chunkInitialCapacity)
			flush := func() error {
				if len(times) == 0 {
					return nil
				}
				frame := data.NewFrame("", data.NewField(data.TimeSeriesTimeFieldName, nil, times), data.NewField(data.TimeSeriesValueFieldName, labels, values))
				frame.Meta = &data.FrameMeta{
					Type:        data.FrameTypeTimeSeriesMulti,
					Custom:      map[string]any{"resultType": "matrix"},
					TypeVersion: data.FrameTypeVersion{0, 1},
				}
				addMetadataToMultiFrame(q, frame)
				if includeQueryMetadata {
					frame.Meta.ExecutedQueryString = executedQueryString(q)
					if frame.Meta.Custom == nil {
						frame.Meta.Custom = map[string]any{}
					}
					frame.Meta.Custom.(map[string]any)["calculatedMinStep"] = q.Step.Milliseconds()
				}
				if err := w.WriteFrame(ctx, q.RefId, frameID, frame); err != nil {
					return err
				}
				wrote = true
				times = make([]time.Time, 0, chunkInitialCapacity)
				values = make([]float64, 0, chunkInitialCapacity)
				return nil
			}
			for more := iter.ReadArray(); more; more = iter.ReadArray() {
				if err := ctx.Err(); err != nil {
					return false, err
				}
				t, v, err := readChunkedTimeValuePair(iter)
				if err != nil {
					return false, err
				}
				times = append(times, t)
				values = append(values, v)
				if len(times) == chunkSampleLimit {
					if err := flush(); err != nil {
						return false, err
					}
				}
			}
			if iter.Error != nil {
				return false, iter.Error
			}
			if err := flush(); err != nil {
				return false, err
			}
			seenValues = true
		case "histograms", "histogram", "value":
			return false, fmt.Errorf("chunked queries do not support histogram or instant samples")
		default:
			return false, fmt.Errorf("noncanonical matrix series: unsupported field %q", key)
		}
	}
	if iter.Error != nil {
		return false, iter.Error
	}
	if !seenMetric || !seenValues {
		return false, fmt.Errorf("noncanonical matrix series: expected metric and values")
	}
	return wrote, nil
}

func readChunkedTimeValuePair(iter *jsoniter.Iterator) (time.Time, float64, error) {
	if !iter.ReadArray() {
		return time.Time{}, 0, iter.Error
	}
	timestamp := iter.ReadFloat64()
	if iter.Error != nil {
		return time.Time{}, 0, iter.Error
	}
	if !iter.ReadArray() {
		if iter.Error != nil {
			return time.Time{}, 0, iter.Error
		}
		return time.Time{}, 0, fmt.Errorf("invalid Prometheus sample: missing value")
	}
	value := iter.ReadString()
	if iter.Error != nil {
		return time.Time{}, 0, iter.Error
	}
	if iter.ReadArray() {
		return time.Time{}, 0, fmt.Errorf("invalid Prometheus sample value")
	}
	floatValue, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return time.Time{}, 0, err
	}
	return time.UnixMilli(int64(timestamp * 1000)).UTC(), floatValue, nil
}
