package converter

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"slices"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/prometheus/prometheus/model/histogram"
	"google.golang.org/protobuf/encoding/protowire"
)

// MimirProtobufMediaType is the media type of the protobuf query response that Mimir sends to clients that accept it.
const MimirProtobufMediaType = "application/vnd.mimir.queryresponse+protobuf"

// mimirErrorTypes maps the mimirpb.QueryErrorType values to the errorType strings of the JSON response.
var mimirErrorTypes = [...]string{
	"", "timeout", "canceled", "execution", "bad_data", "internal", "unavailable",
	"not_found", "not_acceptable", "too_many_requests", "too_large_entry", "cost_limit",
}

var errMalformedProtobuf = errors.New("malformed mimir protobuf response")

// ReadMimirProtobufResult reads a Mimir protobuf query response (mimirpb.QueryResponse) and returns the same frames
// as ReadPrometheusStyleResult returns for the JSON response. It holds one series at a time, not the whole body.
func ReadMimirProtobufResult(r io.Reader, opt Options) backend.DataResponse {
	s := &protoStream{r: bufio.NewReader(r)}
	var rsp backend.DataResponse
	success := false
	errorType, promErr := "", ""
	var warnings, infos []data.Notice

	for {
		num, typ, err := s.tag()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return rspErr(err)
		}
		switch {
		case num == 1 && typ == protowire.VarintType: // status
			v, err := s.uvarint()
			if err != nil {
				return rspErr(err)
			}
			success = v == 1
		case num == 2 && typ == protowire.VarintType: // error_type
			v, err := s.uvarint()
			if err != nil {
				return rspErr(err)
			}
			if v < uint64(len(mimirErrorTypes)) {
				errorType = mimirErrorTypes[v]
			}
		case num == 3 && typ == protowire.BytesType: // error
			b, err := s.message()
			if err != nil {
				return rspErr(err)
			}
			promErr = string(b)
		case num == 4 && typ == protowire.BytesType: // string
			b, err := s.message()
			if err != nil {
				return rspErr(err)
			}
			rsp = readMimirString(b)
		case num == 5 && typ == protowire.BytesType: // vector
			rsp = s.readVector(opt)
		case num == 6 && typ == protowire.BytesType: // scalar
			b, err := s.message()
			if err != nil {
				return rspErr(err)
			}
			rsp = readMimirScalar(b)
		case num == 7 && typ == protowire.BytesType: // matrix
			rsp = s.readMatrix(opt)
		case (num == 8 || num == 9) && typ == protowire.BytesType: // warnings, infos
			b, err := s.message()
			if err != nil {
				return rspErr(err)
			}
			if num == 8 {
				warnings = append(warnings, data.Notice{Severity: data.NoticeSeverityWarning, Text: string(b)})
			} else {
				infos = append(infos, data.Notice{Severity: data.NoticeSeverityInfo, Text: string(b)})
			}
		default:
			if err := s.skip(typ); err != nil {
				return rspErr(err)
			}
		}
		if rsp.Error != nil {
			return rsp
		}
	}

	if !success {
		return backend.DataResponse{
			Error: fmt.Errorf("%s: %s", errorType, promErr),
		}
	}

	attachNotices(&rsp, append(warnings, infos...))
	return rsp
}

func (s *protoStream) readVector(opt Options) backend.DataResponse {
	end, err := s.messageEnd()
	if err != nil {
		return rspErr(err)
	}
	rsp := backend.DataResponse{}
	d := newSeriesDecoder()
	for seriesCount := 0; s.n < end; {
		num, typ, err := s.tag()
		if err != nil {
			return rspErr(err)
		}
		if typ != protowire.BytesType || (num != 1 && num != 2) {
			if err := s.skip(typ); err != nil {
				return rspErr(err)
			}
			continue
		}
		seriesCount++
		if opt.MaxSeries > 0 && seriesCount > opt.MaxSeries {
			return maxSeriesExceeded(opt.MaxSeries)
		}
		b, err := s.message()
		if err != nil {
			return rspErr(err)
		}
		var frame *data.Frame
		if num == 1 { // samples
			frame, err = d.readVectorSample(b)
		} else { // histograms
			frame, err = d.readVectorHistogram(b)
		}
		if err != nil {
			return rspErr(err)
		}
		rsp.Frames = append(rsp.Frames, frame)
	}
	if s.n != end {
		return rspErr(errMalformedProtobuf)
	}
	return rsp
}

func (s *protoStream) readMatrix(opt Options) backend.DataResponse {
	end, err := s.messageEnd()
	if err != nil {
		return rspErr(err)
	}
	rsp := backend.DataResponse{}
	d := newSeriesDecoder()
	for seriesCount := 0; s.n < end; {
		num, typ, err := s.tag()
		if err != nil {
			return rspErr(err)
		}
		if num != 1 || typ != protowire.BytesType { // series
			if err := s.skip(typ); err != nil {
				return rspErr(err)
			}
			continue
		}
		seriesCount++
		if opt.MaxSeries > 0 && seriesCount > opt.MaxSeries {
			return maxSeriesExceeded(opt.MaxSeries)
		}
		b, err := s.message()
		if err != nil {
			return rspErr(err)
		}
		frame, err := d.readMatrixSeries(b)
		if err != nil {
			return rspErr(err)
		}
		rsp.Frames = append(rsp.Frames, frame)
	}
	if s.n != end {
		return rspErr(errMalformedProtobuf)
	}
	return rsp
}

func readMimirString(b []byte) backend.DataResponse {
	var value string
	var ts int64
	err := eachField(b, func(num protowire.Number, typ protowire.Type, v []byte, x uint64) error {
		switch {
		case num == 1 && typ == protowire.BytesType: // value
			value = string(v)
		case num == 2 && typ == protowire.VarintType: // timestamp_ms
			ts = int64(x)
		}
		return nil
	})
	if err != nil {
		return rspErr(err)
	}

	timeField := data.NewField(data.TimeSeriesTimeFieldName, nil, []time.Time{time.UnixMilli(ts).UTC()})
	valueField := data.NewField(data.TimeSeriesValueFieldName, data.Labels{}, []string{value})
	frame := data.NewFrame("", timeField, valueField)
	frame.Meta = &data.FrameMeta{
		Type:   data.FrameTypeTimeSeriesMulti,
		Custom: resultTypeToCustomMeta("string"),
	}
	return backend.DataResponse{Frames: []*data.Frame{frame}}
}

func readMimirScalar(b []byte) backend.DataResponse {
	var value float64
	var ts int64
	err := eachField(b, func(num protowire.Number, typ protowire.Type, _ []byte, x uint64) error {
		switch {
		case num == 1 && typ == protowire.Fixed64Type: // value
			value = float64FromBits(x)
		case num == 2 && typ == protowire.VarintType: // timestamp_ms
			ts = int64(x)
		}
		return nil
	})
	if err != nil {
		return rspErr(err)
	}

	timeField := data.NewField(data.TimeSeriesTimeFieldName, nil, []time.Time{time.UnixMilli(ts).UTC()})
	valueField := data.NewField(data.TimeSeriesValueFieldName, data.Labels{}, []float64{value})
	frame := data.NewFrame("", timeField, valueField)
	frame.Meta = &data.FrameMeta{
		Type:        data.FrameTypeNumericMulti,
		Custom:      resultTypeToCustomMeta("scalar"),
		TypeVersion: data.FrameTypeVersion{0, 1},
	}
	return backend.DataResponse{Frames: []*data.Frame{frame}}
}

func (d *seriesDecoder) readVectorSample(b []byte) (*data.Frame, error) {
	labels, err := d.readLabels(b)
	if err != nil {
		return nil, err
	}
	var value float64
	var ts int64
	err = eachField(b, func(num protowire.Number, typ protowire.Type, _ []byte, x uint64) error {
		switch {
		case num == 2 && typ == protowire.Fixed64Type: // value
			value = float64FromBits(x)
		case num == 3 && typ == protowire.VarintType: // timestamp_ms
			ts = int64(x)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return newSeriesFrame("vector", labels, []time.Time{time.UnixMilli(ts).UTC()}, []float64{value}), nil
}

// seriesDecoder holds what the series of one response share: interned label names, and the histogram buffers and size hint.
type seriesDecoder struct {
	names map[string]string
	fh    histogram.FloatHistogram
	hint  histogramSizeHint
}

func newSeriesDecoder() *seriesDecoder {
	return &seriesDecoder{names: map[string]string{}, hint: newHistogramSizeHint()}
}

func (d *seriesDecoder) readVectorHistogram(b []byte) (*data.Frame, error) {
	labels, err := d.readLabels(b)
	if err != nil {
		return nil, err
	}
	var hist []byte
	var ts int64
	err = eachField(b, func(num protowire.Number, typ protowire.Type, v []byte, x uint64) error {
		switch {
		case num == 2 && typ == protowire.BytesType: // histogram
			hist = v
		case num == 3 && typ == protowire.VarintType: // timestamp_ms
			ts = int64(x)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	info := newHistogramInfo(d.hint.size)
	if err := d.appendBuckets(info, ts, hist); err != nil {
		return nil, err
	}
	d.hint.observe(len(info.times))
	return newHeatmapFrame(labels, info), nil
}

func (d *seriesDecoder) readMatrixSeries(b []byte) (*data.Frame, error) {
	labels, err := d.readLabels(b)
	if err != nil {
		return nil, err
	}
	samples, histograms := 0, 0
	err = eachField(b, func(num protowire.Number, typ protowire.Type, _ []byte, _ uint64) error {
		switch {
		case num == 2 && typ == protowire.BytesType:
			samples++
		case num == 3 && typ == protowire.BytesType:
			histograms++
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	if histograms > 0 {
		info := newHistogramInfo(d.hint.size)
		err = eachField(b, func(num protowire.Number, typ protowire.Type, v []byte, _ uint64) error {
			if num != 3 || typ != protowire.BytesType { // histograms
				return nil
			}
			var hist []byte
			var ts int64
			err := eachField(v, func(num protowire.Number, typ protowire.Type, v []byte, x uint64) error {
				switch {
				case num == 1 && typ == protowire.BytesType: // histogram
					hist = v
				case num == 2 && typ == protowire.VarintType: // timestamp_ms
					ts = int64(x)
				}
				return nil
			})
			if err != nil {
				return err
			}
			return d.appendBuckets(info, ts, hist)
		})
		if err != nil {
			return nil, err
		}
		d.hint.observe(len(info.times))
		return newHeatmapFrame(labels, info), nil
	}

	times := make([]time.Time, 0, samples)
	values := make([]float64, 0, samples)
	err = eachField(b, func(num protowire.Number, typ protowire.Type, v []byte, _ uint64) error {
		if num != 2 || typ != protowire.BytesType { // samples
			return nil
		}
		var value float64
		var ts int64
		err := eachField(v, func(num protowire.Number, typ protowire.Type, _ []byte, x uint64) error {
			switch {
			case num == 1 && typ == protowire.Fixed64Type: // value
				value = float64FromBits(x)
			case num == 2 && typ == protowire.VarintType: // timestamp_ms
				ts = int64(x)
			}
			return nil
		})
		times = append(times, time.UnixMilli(ts).UTC())
		values = append(values, value)
		return err
	})
	if err != nil {
		return nil, err
	}
	return newSeriesFrame("matrix", labels, times, values), nil
}

// appendBuckets adds the non-empty buckets of one mimirpb.FloatHistogram, as the JSON response lists them.
func (d *seriesDecoder) appendBuckets(info *histogramInfo, ts int64, b []byte) error {
	fh := &d.fh
	*fh = histogram.FloatHistogram{
		PositiveSpans:   fh.PositiveSpans[:0],
		NegativeSpans:   fh.NegativeSpans[:0],
		PositiveBuckets: fh.PositiveBuckets[:0],
		NegativeBuckets: fh.NegativeBuckets[:0],
	}
	var customValues []float64
	err := eachField(b, func(num protowire.Number, typ protowire.Type, v []byte, x uint64) error {
		var err error
		switch num {
		case 4: // schema
			fh.Schema = int32(protowire.DecodeZigZag(x))
		case 5: // zero_threshold
			fh.ZeroThreshold = float64FromBits(x)
		case 7: // zero_count
			fh.ZeroCount = float64FromBits(x)
		case 2: // count
			fh.Count = float64FromBits(x)
		case 3: // sum
			fh.Sum = float64FromBits(x)
		case 11: // positive_spans
			fh.PositiveSpans, err = appendSpan(fh.PositiveSpans, typ, v)
		case 8: // negative_spans
			fh.NegativeSpans, err = appendSpan(fh.NegativeSpans, typ, v)
		case 13: // positive_buckets
			fh.PositiveBuckets, err = appendDoubles(fh.PositiveBuckets, typ, v, x)
		case 10: // negative_buckets
			fh.NegativeBuckets, err = appendDoubles(fh.NegativeBuckets, typ, v, x)
		case 16: // custom_values
			customValues, err = appendDoubles(customValues, typ, v, x)
		}
		return err
	})
	if err != nil {
		return err
	}
	fh.CustomValues = customValues
	if err := checkHistogramLayout(fh); err != nil {
		return err
	}

	t := time.UnixMilli(ts).UTC()
	it := fh.AllBucketIterator()
	for it.Next() {
		bucket := it.At()
		if bucket.Count == 0 {
			continue
		}
		info.times = append(info.times, t)
		info.yLayouts = append(info.yLayouts, bucketBoundaries(bucket))
		info.yMins = append(info.yMins, canonicalNaN(bucket.Lower))
		info.yMaxes = append(info.yMaxes, canonicalNaN(bucket.Upper))
		info.counts = append(info.counts, canonicalNaN(bucket.Count))
	}
	return nil
}

// bucketBoundaries is the boundary rule that the JSON response gives each bucket.
func bucketBoundaries(b histogram.Bucket[float64]) int8 {
	switch {
	case b.LowerInclusive && b.UpperInclusive:
		return 3
	case b.LowerInclusive:
		return 1
	case b.UpperInclusive:
		return 0
	default:
		return 2
	}
}

// checkHistogramLayout rejects a histogram whose spans, buckets and custom bounds would make bucket iteration panic.
func checkHistogramLayout(fh *histogram.FloatHistogram) error {
	spanBuckets := func(spans []histogram.Span) int {
		n := 0
		for _, s := range spans {
			n += int(s.Length)
		}
		return n
	}
	switch {
	case histogram.IsExponentialSchema(fh.Schema):
		if spanBuckets(fh.PositiveSpans) == len(fh.PositiveBuckets) && spanBuckets(fh.NegativeSpans) == len(fh.NegativeBuckets) {
			return nil
		}
	case histogram.IsCustomBucketsSchema(fh.Schema):
		if len(fh.NegativeSpans) > 0 || len(fh.NegativeBuckets) > 0 || spanBuckets(fh.PositiveSpans) != len(fh.PositiveBuckets) {
			break
		}
		end := 0
		for _, s := range fh.PositiveSpans {
			if s.Offset < 0 {
				return fmt.Errorf("%w: negative custom bucket offset", errMalformedProtobuf)
			}
			end += int(s.Offset) + int(s.Length)
		}
		if end <= len(fh.CustomValues)+1 {
			return nil
		}
	}
	return fmt.Errorf("%w: histogram with schema %d has buckets that do not match its spans", errMalformedProtobuf, fh.Schema)
}

func appendSpan(spans []histogram.Span, typ protowire.Type, b []byte) ([]histogram.Span, error) {
	if typ != protowire.BytesType {
		return spans, errMalformedProtobuf
	}
	var span histogram.Span
	err := eachField(b, func(num protowire.Number, typ protowire.Type, _ []byte, x uint64) error {
		switch {
		case num == 1 && typ == protowire.VarintType: // offset
			span.Offset = int32(protowire.DecodeZigZag(x))
		case num == 2 && typ == protowire.VarintType: // length
			span.Length = uint32(x)
		}
		return nil
	})
	return append(spans, span), err
}

// appendDoubles appends a repeated double field, which can be packed or one value per field.
func appendDoubles(dst []float64, typ protowire.Type, b []byte, x uint64) ([]float64, error) {
	switch typ {
	case protowire.Fixed64Type:
		return append(dst, float64FromBits(x)), nil
	case protowire.BytesType:
		if len(b)%8 != 0 {
			return dst, errMalformedProtobuf
		}
		dst = slices.Grow(dst, len(b)/8)
		for i := 0; i < len(b); i += 8 {
			dst = append(dst, float64FromBits(binary.LittleEndian.Uint64(b[i:])))
		}
		return dst, nil
	}
	return dst, errMalformedProtobuf
}

func (d *seriesDecoder) readLabels(b []byte) (data.Labels, error) {
	count := 0
	err := eachField(b, func(num protowire.Number, typ protowire.Type, _ []byte, _ uint64) error {
		if num == 1 && typ == protowire.BytesType {
			count++
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if count%2 != 0 {
		return nil, fmt.Errorf("%w: series has an odd number of label strings", errMalformedProtobuf)
	}
	labels := make(data.Labels, count/2)
	var name string
	nameNext := true
	err = eachField(b, func(num protowire.Number, typ protowire.Type, v []byte, _ uint64) error {
		if num != 1 || typ != protowire.BytesType { // metric
			return nil
		}
		if nameNext {
			name = d.name(v)
		} else {
			labels[name] = string(v)
		}
		nameNext = !nameNext
		return nil
	})
	return labels, err
}

func (d *seriesDecoder) name(b []byte) string {
	if name, ok := d.names[string(b)]; ok {
		return name
	}
	name := string(b)
	d.names[name] = name
	return name
}

// eachField calls fn for every field of the message b. For a bytes field it passes the bytes, and for a varint or
// fixed field it passes the value.
func eachField(b []byte, fn func(num protowire.Number, typ protowire.Type, v []byte, x uint64) error) error {
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return fmt.Errorf("%w: %w", errMalformedProtobuf, protowire.ParseError(n))
		}
		b = b[n:]
		var v []byte
		var x uint64
		switch typ {
		case protowire.VarintType:
			x, n = protowire.ConsumeVarint(b)
		case protowire.Fixed64Type:
			x, n = protowire.ConsumeFixed64(b)
		case protowire.Fixed32Type:
			var x32 uint32
			x32, n = protowire.ConsumeFixed32(b)
			x = uint64(x32)
		case protowire.BytesType:
			v, n = protowire.ConsumeBytes(b)
		default:
			n = protowire.ConsumeFieldValue(num, typ, b)
		}
		if n < 0 {
			return fmt.Errorf("%w: %w", errMalformedProtobuf, protowire.ParseError(n))
		}
		b = b[n:]
		if err := fn(num, typ, v, x); err != nil {
			return err
		}
	}
	return nil
}

func float64FromBits(x uint64) float64 {
	return canonicalNaN(math.Float64frombits(x))
}

// canonicalNaN gives every NaN the bits of math.NaN, which the JSON decoder produces for "NaN".
func canonicalNaN(v float64) float64 {
	if v != v {
		return math.NaN()
	}
	return v
}

// protoStream reads protobuf fields from a stream and counts the bytes it has consumed.
type protoStream struct {
	r   *bufio.Reader
	n   int64
	buf []byte
}

func (s *protoStream) ReadByte() (byte, error) {
	b, err := s.r.ReadByte()
	if err == nil {
		s.n++
	}
	return b, err
}

func (s *protoStream) uvarint() (uint64, error) {
	v, err := binary.ReadUvarint(s)
	if errors.Is(err, io.EOF) {
		return 0, io.ErrUnexpectedEOF
	}
	return v, err
}

// tag returns io.EOF only at the end of the stream, between fields.
func (s *protoStream) tag() (protowire.Number, protowire.Type, error) {
	v, err := binary.ReadUvarint(s)
	if err != nil {
		return 0, 0, err
	}
	num, typ := protowire.DecodeTag(v)
	if num < protowire.MinValidNumber {
		return 0, 0, errMalformedProtobuf
	}
	return num, typ, nil
}

// messageEnd reads the length of a bytes field and returns the stream offset where the field ends.
func (s *protoStream) messageEnd() (int64, error) {
	n, err := s.uvarint()
	if err != nil {
		return 0, err
	}
	if n > math.MaxInt64-uint64(s.n) {
		return 0, errMalformedProtobuf
	}
	return s.n + int64(n), nil
}

// message reads a bytes field into a buffer that the next call reuses. The buffer grows only as bytes arrive, so a
// wrong length cannot allocate more than the body holds.
func (s *protoStream) message() ([]byte, error) {
	n, err := s.uvarint()
	if err != nil {
		return nil, err
	}
	s.buf = s.buf[:0]
	for remaining := n; remaining > 0; {
		chunk := int(min(remaining, 1<<20))
		s.buf = slices.Grow(s.buf, chunk)
		got, err := io.ReadFull(s.r, s.buf[len(s.buf):len(s.buf)+chunk])
		s.buf = s.buf[:len(s.buf)+got]
		s.n += int64(got)
		if err != nil {
			return nil, io.ErrUnexpectedEOF
		}
		remaining -= uint64(got)
	}
	return s.buf, nil
}

func (s *protoStream) skip(typ protowire.Type) error {
	switch typ {
	case protowire.VarintType:
		_, err := s.uvarint()
		return err
	case protowire.Fixed64Type:
		return s.discard(8)
	case protowire.Fixed32Type:
		return s.discard(4)
	case protowire.BytesType:
		n, err := s.uvarint()
		if err != nil {
			return err
		}
		return s.discard(n)
	}
	return errMalformedProtobuf
}

func (s *protoStream) discard(n uint64) error {
	for n > 0 {
		chunk := int(min(n, 1<<20))
		got, err := s.r.Discard(chunk)
		s.n += int64(got)
		if err != nil {
			return io.ErrUnexpectedEOF
		}
		n -= uint64(got)
	}
	return nil
}
