package converter

import (
	"bytes"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	sdkjsoniter "github.com/grafana/grafana-plugin-sdk-go/data/utils/jsoniter"
	jsoniter "github.com/json-iterator/go"
	"github.com/prometheus/prometheus/model/histogram"
	"github.com/prometheus/prometheus/util/jsonutil"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/encoding/protowire"
)

// testResponse is one query response that the tests encode both as Mimir JSON and as Mimir protobuf.
type testResponse struct {
	resultType string // matrix, vector, scalar or string; empty for an error response
	series     []testSeries
	scalar     testSample
	str        string
	errorType  int
	errorMsg   string
	warnings   []string
	infos      []string
}

type testSeries struct {
	labels     []string // name, value, name, value
	samples    []testSample
	histograms []testHistogram
}

type testSample struct {
	ts    int64
	value float64
}

type testHistogram struct {
	ts int64
	h  *histogram.FloatHistogram
}

func (r testResponse) json() []byte {
	s := jsoniter.ConfigCompatibleWithStandardLibrary.BorrowStream(nil)
	defer jsoniter.ConfigCompatibleWithStandardLibrary.ReturnStream(s)
	s.WriteObjectStart()
	if r.resultType == "" {
		s.WriteObjectField("status")
		s.WriteString("error")
		s.WriteMore()
		s.WriteObjectField("errorType")
		s.WriteString(mimirErrorTypes[r.errorType])
		s.WriteMore()
		s.WriteObjectField("error")
		s.WriteString(r.errorMsg)
	} else {
		s.WriteObjectField("status")
		s.WriteString("success")
		s.WriteMore()
		s.WriteObjectField("data")
		s.WriteObjectStart()
		s.WriteObjectField("resultType")
		s.WriteString(r.resultType)
		s.WriteMore()
		s.WriteObjectField("result")
		switch r.resultType {
		case "scalar":
			writeJSONPair(s, r.scalar.ts, func() { jsonutil.MarshalFloat(r.scalar.value, s) })
		case "string":
			writeJSONPair(s, r.scalar.ts, func() { s.WriteString(r.str) })
		default:
			s.WriteArrayStart()
			for i, series := range r.series {
				if i > 0 {
					s.WriteMore()
				}
				writeJSONSeries(s, r.resultType, series)
			}
			s.WriteArrayEnd()
		}
		s.WriteObjectEnd()
	}
	for _, notices := range []struct {
		key   string
		texts []string
	}{{"warnings", r.warnings}, {"infos", r.infos}} {
		if len(notices.texts) == 0 {
			continue
		}
		s.WriteMore()
		s.WriteObjectField(notices.key)
		s.WriteArrayStart()
		for i, text := range notices.texts {
			if i > 0 {
				s.WriteMore()
			}
			s.WriteString(text)
		}
		s.WriteArrayEnd()
	}
	s.WriteObjectEnd()
	return append([]byte(nil), s.Buffer()...)
}

func writeJSONPair(s *jsoniter.Stream, ts int64, writeValue func()) {
	s.WriteArrayStart()
	jsonutil.MarshalTimestamp(ts, s)
	s.WriteMore()
	writeValue()
	s.WriteArrayEnd()
}

func writeJSONSeries(s *jsoniter.Stream, resultType string, series testSeries) {
	s.WriteObjectStart()
	s.WriteObjectField("metric")
	s.WriteObjectStart()
	for i := 0; i < len(series.labels); i += 2 {
		if i > 0 {
			s.WriteMore()
		}
		s.WriteObjectField(series.labels[i])
		s.WriteString(series.labels[i+1])
	}
	s.WriteObjectEnd()
	if resultType == "vector" {
		s.WriteMore()
		if len(series.samples) == 1 {
			s.WriteObjectField("value")
			writeJSONPair(s, series.samples[0].ts, func() { jsonutil.MarshalFloat(series.samples[0].value, s) })
		} else {
			s.WriteObjectField("histogram")
			h := series.histograms[0]
			writeJSONPair(s, h.ts, func() { jsonutil.MarshalHistogram(h.h, s) })
		}
		s.WriteObjectEnd()
		return
	}
	if len(series.samples) > 0 {
		s.WriteMore()
		s.WriteObjectField("values")
		s.WriteArrayStart()
		for i, sample := range series.samples {
			if i > 0 {
				s.WriteMore()
			}
			writeJSONPair(s, sample.ts, func() { jsonutil.MarshalFloat(sample.value, s) })
		}
		s.WriteArrayEnd()
	}
	if len(series.histograms) > 0 {
		s.WriteMore()
		s.WriteObjectField("histograms")
		s.WriteArrayStart()
		for i, h := range series.histograms {
			if i > 0 {
				s.WriteMore()
			}
			writeJSONPair(s, h.ts, func() { jsonutil.MarshalHistogram(h.h, s) })
		}
		s.WriteArrayEnd()
	}
	s.WriteObjectEnd()
}

// protobuf encodes the response as gogo/protobuf encodes mimirpb.QueryResponse: fields in number order, and proto3
// zero values left out.
func (r testResponse) protobuf() []byte {
	var b []byte
	if r.resultType != "" {
		b = appendVarintField(b, 1, 1)
	} else {
		b = appendVarintField(b, 2, uint64(r.errorType))
		b = appendBytesField(b, 3, []byte(r.errorMsg))
	}
	switch r.resultType {
	case "string":
		var m []byte
		m = appendBytesField(m, 1, []byte(r.str))
		m = appendVarintField(m, 2, uint64(r.scalar.ts))
		b = protowire.AppendTag(b, 4, protowire.BytesType)
		b = protowire.AppendBytes(b, m)
	case "vector":
		var m []byte
		for _, series := range r.series {
			if len(series.samples) == 1 {
				var v []byte
				v = appendLabels(v, series.labels)
				v = appendDoubleField(v, 2, series.samples[0].value)
				v = appendVarintField(v, 3, uint64(series.samples[0].ts))
				m = protowire.AppendTag(m, 1, protowire.BytesType)
				m = protowire.AppendBytes(m, v)
			}
		}
		for _, series := range r.series {
			if len(series.histograms) == 1 {
				var v []byte
				v = appendLabels(v, series.labels)
				v = protowire.AppendTag(v, 2, protowire.BytesType)
				v = protowire.AppendBytes(v, appendFloatHistogram(nil, series.histograms[0].h))
				v = appendVarintField(v, 3, uint64(series.histograms[0].ts))
				m = protowire.AppendTag(m, 2, protowire.BytesType)
				m = protowire.AppendBytes(m, v)
			}
		}
		b = protowire.AppendTag(b, 5, protowire.BytesType)
		b = protowire.AppendBytes(b, m)
	case "scalar":
		var m []byte
		m = appendDoubleField(m, 1, r.scalar.value)
		m = appendVarintField(m, 2, uint64(r.scalar.ts))
		b = protowire.AppendTag(b, 6, protowire.BytesType)
		b = protowire.AppendBytes(b, m)
	case "matrix":
		var m []byte
		for _, series := range r.series {
			var v []byte
			v = appendLabels(v, series.labels)
			for _, sample := range series.samples {
				var p []byte
				p = appendDoubleField(p, 1, sample.value)
				p = appendVarintField(p, 2, uint64(sample.ts))
				v = protowire.AppendTag(v, 2, protowire.BytesType)
				v = protowire.AppendBytes(v, p)
			}
			for _, h := range series.histograms {
				var p []byte
				p = protowire.AppendTag(p, 1, protowire.BytesType)
				p = protowire.AppendBytes(p, appendFloatHistogram(nil, h.h))
				p = appendVarintField(p, 2, uint64(h.ts))
				v = protowire.AppendTag(v, 3, protowire.BytesType)
				v = protowire.AppendBytes(v, p)
			}
			m = protowire.AppendTag(m, 1, protowire.BytesType)
			m = protowire.AppendBytes(m, v)
		}
		b = protowire.AppendTag(b, 7, protowire.BytesType)
		b = protowire.AppendBytes(b, m)
	}
	b = appendRepeatedStrings(b, 8, r.warnings)
	return appendRepeatedStrings(b, 9, r.infos)
}

func appendFloatHistogram(b []byte, h *histogram.FloatHistogram) []byte {
	b = appendDoubleField(b, 2, h.Count)
	b = appendDoubleField(b, 3, h.Sum)
	if h.Schema != 0 {
		b = appendVarintField(b, 4, protowire.EncodeZigZag(int64(h.Schema)))
	}
	b = appendDoubleField(b, 5, h.ZeroThreshold)
	b = appendDoubleField(b, 7, h.ZeroCount)
	b = appendSpans(b, 8, h.NegativeSpans)
	b = appendPackedDoubles(b, 10, h.NegativeBuckets)
	b = appendSpans(b, 11, h.PositiveSpans)
	b = appendPackedDoubles(b, 13, h.PositiveBuckets)
	if h.CounterResetHint != 0 {
		b = appendVarintField(b, 14, uint64(h.CounterResetHint))
	}
	return appendPackedDoubles(b, 16, h.CustomValues)
}

func appendSpans(b []byte, num protowire.Number, spans []histogram.Span) []byte {
	for _, span := range spans {
		var m []byte
		if span.Offset != 0 {
			m = appendVarintField(m, 1, protowire.EncodeZigZag(int64(span.Offset)))
		}
		if span.Length != 0 {
			m = appendVarintField(m, 2, uint64(span.Length))
		}
		b = protowire.AppendTag(b, num, protowire.BytesType)
		b = protowire.AppendBytes(b, m)
	}
	return b
}

func appendPackedDoubles(b []byte, num protowire.Number, values []float64) []byte {
	if len(values) == 0 {
		return b
	}
	var m []byte
	for _, v := range values {
		m = protowire.AppendFixed64(m, math.Float64bits(v))
	}
	b = protowire.AppendTag(b, num, protowire.BytesType)
	return protowire.AppendBytes(b, m)
}

func appendLabels(b []byte, labels []string) []byte {
	return appendRepeatedStrings(b, 1, labels)
}

// appendRepeatedStrings keeps empty elements, which protobuf encodes for repeated fields.
func appendRepeatedStrings(b []byte, num protowire.Number, values []string) []byte {
	for _, v := range values {
		b = protowire.AppendTag(b, num, protowire.BytesType)
		b = protowire.AppendString(b, v)
	}
	return b
}

func appendVarintField(b []byte, num protowire.Number, v uint64) []byte {
	if v == 0 {
		return b
	}
	b = protowire.AppendTag(b, num, protowire.VarintType)
	return protowire.AppendVarint(b, v)
}

// appendDoubleField leaves out 0 and -0, as gogo/protobuf does, so -0 reaches the decoder as 0.
func appendDoubleField(b []byte, num protowire.Number, v float64) []byte {
	if v == 0 {
		return b
	}
	b = protowire.AppendTag(b, num, protowire.Fixed64Type)
	return protowire.AppendFixed64(b, math.Float64bits(v))
}

func appendBytesField(b []byte, num protowire.Number, v []byte) []byte {
	if len(v) == 0 {
		return b
	}
	b = protowire.AppendTag(b, num, protowire.BytesType)
	return protowire.AppendBytes(b, v)
}

func readJSONResponse(b []byte, opt Options) backend.DataResponse {
	return ReadPrometheusStyleResult(jsoniter.ParseBytes(sdkjsoniter.ConfigDefault, b), opt)
}

func readProtobufResponse(b []byte, opt Options) backend.DataResponse {
	return ReadMimirProtobufResult(bytes.NewReader(b), opt)
}

// requireSameResponse checks that the two responses give the same errors and the same Arrow and JSON frame bytes.
func requireSameResponse(t *testing.T, want, got backend.DataResponse) {
	t.Helper()
	if want.Error != nil || got.Error != nil {
		require.Error(t, want.Error)
		require.Error(t, got.Error)
		require.Equal(t, want.Error.Error(), got.Error.Error())
		require.Equal(t, want.ErrorSource, got.ErrorSource)
		return
	}
	require.Len(t, got.Frames, len(want.Frames))
	for i := range want.Frames {
		wantArrow, err := want.Frames[i].MarshalArrow()
		require.NoError(t, err)
		gotArrow, err := got.Frames[i].MarshalArrow()
		require.NoError(t, err)
		require.Equal(t, wantArrow, gotArrow, "frame %d arrow", i)

		wantJSON, err := data.FrameToJSON(want.Frames[i], data.IncludeAll)
		require.NoError(t, err)
		gotJSON, err := data.FrameToJSON(got.Frames[i], data.IncludeAll)
		require.NoError(t, err)
		require.Equal(t, string(wantJSON), string(gotJSON), "frame %d json", i)

		for j, f := range want.Frames[i].Fields {
			require.Equal(t, f.Labels == nil, got.Frames[i].Fields[j].Labels == nil, "frame %d field %d labels", i, j)
		}
	}
}

func requireDecodersAgree(t *testing.T, r testResponse, opt Options) {
	t.Helper()
	requireSameResponse(t, readJSONResponse(r.json(), opt), readProtobufResponse(r.protobuf(), opt))
}

func exponentialHistogram() *histogram.FloatHistogram {
	return &histogram.FloatHistogram{
		Schema:          1,
		ZeroThreshold:   0.001,
		ZeroCount:       3,
		Count:           26,
		Sum:             123.5,
		PositiveSpans:   []histogram.Span{{Offset: -2, Length: 2}, {Offset: 3, Length: 3}},
		PositiveBuckets: []float64{1, 2, 0, 4, 5},
		NegativeSpans:   []histogram.Span{{Offset: 1, Length: 2}},
		NegativeBuckets: []float64{6, 5},
	}
}

func customBucketsHistogram() *histogram.FloatHistogram {
	return &histogram.FloatHistogram{
		Schema:          histogram.CustomBucketsSchema,
		Count:           10,
		Sum:             42,
		PositiveSpans:   []histogram.Span{{Offset: 0, Length: 2}, {Offset: 1, Length: 2}},
		PositiveBuckets: []float64{1, 2, 3, 4},
		CustomValues:    []float64{0.1, 0.5, 1, 5},
	}
}

func TestReadMimirProtobufResultMatchesJSON(t *testing.T) {
	ts := int64(1795097051127)
	labels := []string{"__name__", "up", "job", `a "quoted" \ value`, "unicode", "✓ ünïcødé"}
	cases := map[string]testResponse{
		"empty matrix": {resultType: "matrix"},
		"empty vector": {resultType: "vector"},
		"matrix": {resultType: "matrix", series: []testSeries{
			{labels: labels, samples: []testSample{{ts, 1}, {ts + 15000, 2.5}, {ts + 30000, -3}}},
			{labels: []string{"job", "b"}, samples: []testSample{{ts, math.NaN()}, {ts + 1, math.Inf(1)}, {ts + 2, math.Inf(-1)}, {ts + 3, 1e-300}, {ts + 4, 1e300}}},
		}},
		"matrix series without labels":    {resultType: "matrix", series: []testSeries{{samples: []testSample{{ts, 1}}}}},
		"matrix with zero time and value": {resultType: "matrix", series: []testSeries{{labels: labels, samples: []testSample{{0, 0}}}}},
		"matrix with a stale marker":      {resultType: "matrix", series: []testSeries{{labels: labels, samples: []testSample{{ts, math.Float64frombits(0x7ff0000000000002)}}}}},
		"vector": {resultType: "vector", series: []testSeries{
			{labels: labels, samples: []testSample{{ts, 42}}},
			{samples: []testSample{{ts, 7}}},
		}},
		"vector with histograms after floats": {resultType: "vector", series: []testSeries{
			{labels: labels, samples: []testSample{{ts, 42}}},
			{labels: []string{"le", "x"}, histograms: []testHistogram{{ts, exponentialHistogram()}}},
			{histograms: []testHistogram{{ts, customBucketsHistogram()}}},
		}},
		"matrix histograms": {resultType: "matrix", series: []testSeries{
			{labels: labels, histograms: []testHistogram{{ts, exponentialHistogram()}, {ts + 60000, customBucketsHistogram()}}},
			{histograms: []testHistogram{{ts, &histogram.FloatHistogram{}}}},
		}},
		"matrix series with floats and histograms": {resultType: "matrix", series: []testSeries{
			{labels: labels, samples: []testSample{{ts, 1}}, histograms: []testHistogram{{ts + 1000, exponentialHistogram()}}},
		}},
		"scalar":          {resultType: "scalar", scalar: testSample{ts, 3.25}},
		"scalar NaN":      {resultType: "scalar", scalar: testSample{ts, math.NaN()}},
		"string":          {resultType: "string", scalar: testSample{ts, 0}, str: "foo ✓"},
		"empty string":    {resultType: "string", scalar: testSample{ts, 0}},
		"error":           {errorType: 4, errorMsg: `1:3: parse error: unexpected "}"`},
		"error timeout":   {errorType: 1, errorMsg: "query timed out"},
		"error cost":      {errorType: 11, errorMsg: "too expensive"},
		"error with info": {errorType: 3, errorMsg: "boom", infos: []string{"info"}},
		"warnings and infos": {resultType: "matrix", warnings: []string{"w1", "w2"}, infos: []string{"i1"}, series: []testSeries{
			{labels: labels, samples: []testSample{{ts, 1}}},
		}},
		"warnings without data": {resultType: "vector", warnings: []string{"only a warning"}},
	}
	for name, r := range cases {
		t.Run(name, func(t *testing.T) {
			requireDecodersAgree(t, r, Options{})
		})
	}
}

func TestReadMimirProtobufResultMatchesJSONRandom(t *testing.T) {
	rnd := rand.New(rand.NewPCG(1, 2))
	for i := range 500 {
		r := randomResponse(rnd)
		t.Run(fmt.Sprintf("%d_%s", i, r.resultType), func(t *testing.T) {
			requireDecodersAgree(t, r, Options{})
		})
	}
}

func randomResponse(rnd *rand.Rand) testResponse {
	r := testResponse{}
	for range rnd.IntN(3) {
		r.warnings = append(r.warnings, randomString(rnd))
	}
	for range rnd.IntN(3) {
		r.infos = append(r.infos, randomString(rnd))
	}
	ts := 1_600_000_000_000 + rnd.Int64N(400_000_000_000)
	switch rnd.IntN(10) {
	case 0:
		r.errorType = rnd.IntN(len(mimirErrorTypes))
		r.errorMsg = randomString(rnd)
	case 1:
		r.resultType = "scalar"
		r.scalar = testSample{ts, randomValue(rnd)}
	case 2:
		r.resultType = "string"
		r.scalar = testSample{ts, 0}
		r.str = randomString(rnd)
	case 3, 4:
		r.resultType = "vector"
		floats, histograms := rnd.IntN(20), rnd.IntN(3)
		for range floats {
			r.series = append(r.series, testSeries{labels: randomLabels(rnd), samples: []testSample{{ts, randomValue(rnd)}}})
		}
		for range histograms {
			r.series = append(r.series, testSeries{labels: randomLabels(rnd), histograms: []testHistogram{{ts, randomHistogram(rnd)}}})
		}
	default:
		r.resultType = "matrix"
		for range rnd.IntN(20) {
			series := testSeries{labels: randomLabels(rnd)}
			step := 1 + rnd.Int64N(60_000)
			for j := range rnd.IntN(50) {
				series.samples = append(series.samples, testSample{ts + int64(j)*step, randomValue(rnd)})
			}
			if rnd.IntN(4) == 0 {
				for j := range 1 + rnd.IntN(5) {
					series.histograms = append(series.histograms, testHistogram{ts + int64(j)*step, randomHistogram(rnd)})
				}
			}
			r.series = append(r.series, series)
		}
	}
	return r
}

func randomValue(rnd *rand.Rand) float64 {
	special := []float64{0, math.NaN(), math.Inf(1), math.Inf(-1), math.MaxFloat64, math.SmallestNonzeroFloat64, -1, 1}
	switch rnd.IntN(4) {
	case 0:
		return special[rnd.IntN(len(special))]
	case 1:
		return float64(rnd.Int64N(1_000_000) - 500_000)
	default:
		return rnd.NormFloat64() * math.Pow(10, float64(rnd.IntN(40)-20))
	}
}

func randomString(rnd *rand.Rand) string {
	pieces := []string{"a", "job", "✓", `"`, `\`, "/", " ", "ü", "\n", "\t", "<b>", "0", "_", "😀"}
	var sb strings.Builder
	for range rnd.IntN(12) {
		sb.WriteString(pieces[rnd.IntN(len(pieces))])
	}
	return sb.String()
}

func randomLabels(rnd *rand.Rand) []string {
	var labels []string
	for i := range rnd.IntN(12) {
		labels = append(labels, fmt.Sprintf("label_%d", i), randomString(rnd))
	}
	return labels
}

func randomHistogram(rnd *rand.Rand) *histogram.FloatHistogram {
	h := &histogram.FloatHistogram{Count: float64(rnd.IntN(1000)), Sum: rnd.NormFloat64() * 100}
	bucket := func() float64 {
		if rnd.IntN(4) == 0 {
			return 0
		}
		return float64(rnd.IntN(100)) - float64(rnd.IntN(3))
	}
	if rnd.IntN(3) == 0 {
		h.Schema = histogram.CustomBucketsSchema
		bound := rnd.Float64()
		for range 1 + rnd.IntN(8) {
			h.CustomValues = append(h.CustomValues, bound)
			bound += rnd.Float64() * 10
		}
		end := 0
		for end < len(h.CustomValues)+1 {
			offset := rnd.IntN(2)
			length := 1 + rnd.IntN(3)
			if end+offset+length > len(h.CustomValues)+1 {
				break
			}
			h.PositiveSpans = append(h.PositiveSpans, histogram.Span{Offset: int32(offset), Length: uint32(length)})
			for range length {
				h.PositiveBuckets = append(h.PositiveBuckets, bucket())
			}
			end += offset + length
		}
		return h
	}
	h.Schema = int32(rnd.IntN(13) - 4)
	if rnd.IntN(2) == 0 {
		h.ZeroThreshold = math.Pow(10, -float64(rnd.IntN(10)))
		h.ZeroCount = float64(rnd.IntN(10))
	}
	for _, side := range []struct {
		spans   *[]histogram.Span
		buckets *[]float64
	}{{&h.PositiveSpans, &h.PositiveBuckets}, {&h.NegativeSpans, &h.NegativeBuckets}} {
		for i := range rnd.IntN(4) {
			offset := int32(rnd.IntN(5))
			if i == 0 {
				offset -= 10
			}
			length := 1 + rnd.IntN(4)
			*side.spans = append(*side.spans, histogram.Span{Offset: offset, Length: uint32(length)})
			for range length {
				*side.buckets = append(*side.buckets, bucket())
			}
		}
	}
	return h
}

func TestReadMimirProtobufResultSeriesLimit(t *testing.T) {
	series := []testSeries{
		{labels: []string{"a", "1"}, samples: []testSample{{1, 1}}},
		{labels: []string{"a", "2"}, samples: []testSample{{1, 2}}},
		{labels: []string{"a", "3"}, histograms: []testHistogram{{1, exponentialHistogram()}}},
	}
	for _, resultType := range []string{"matrix", "vector"} {
		r := testResponse{resultType: resultType, series: series}
		t.Run(resultType, func(t *testing.T) {
			for _, limit := range []int{0, 2, 3} {
				requireDecodersAgree(t, r, Options{MaxSeries: limit})
			}
			rsp := readProtobufResponse(r.protobuf(), Options{MaxSeries: 2})
			require.ErrorIs(t, rsp.Error, ErrMaxSeriesExceeded)
		})
	}
}

func TestReadMimirProtobufResultInterleavedVector(t *testing.T) {
	r := testResponse{resultType: "vector", series: []testSeries{
		{labels: []string{"a", "histogram"}, histograms: []testHistogram{{1, exponentialHistogram()}}},
		{labels: []string{"a", "float"}, samples: []testSample{{1, 1}}},
	}}
	rsp := readProtobufResponse(r.protobuf(), Options{})
	require.NoError(t, rsp.Error)
	require.Len(t, rsp.Frames, 2)
	require.Equal(t, data.FrameTypeNumericMulti, rsp.Frames[0].Meta.Type, "the protobuf vector lists float samples before histograms")
	require.Equal(t, data.FrameType("heatmap-cells"), rsp.Frames[1].Meta.Type)
}

func TestReadMimirProtobufResultMalformed(t *testing.T) {
	valid := testResponse{resultType: "matrix", series: []testSeries{
		{labels: []string{"a", "b"}, samples: []testSample{{1, 1}, {2, 2}}, histograms: []testHistogram{{3, exponentialHistogram()}}},
	}}.protobuf()
	statusField := len(appendVarintField(nil, 1, 1))
	for cut := statusField + 1; cut < len(valid); cut++ {
		rsp := readProtobufResponse(valid[:cut], Options{})
		require.Error(t, rsp.Error, "cut at %d of %d", cut, len(valid))
	}

	badHistograms := map[string]*histogram.FloatHistogram{
		"more spans than buckets":     {Schema: 0, PositiveSpans: []histogram.Span{{Length: 3}}, PositiveBuckets: []float64{1}},
		"more buckets than spans":     {Schema: 0, NegativeSpans: []histogram.Span{{Length: 1}}, NegativeBuckets: []float64{1, 2}},
		"unknown schema":              {Schema: 9, PositiveSpans: []histogram.Span{{Length: 1}}, PositiveBuckets: []float64{1}},
		"custom bounds too short":     {Schema: histogram.CustomBucketsSchema, PositiveSpans: []histogram.Span{{Length: 3}}, PositiveBuckets: []float64{1, 2, 3}, CustomValues: []float64{1}},
		"custom negative offset":      {Schema: histogram.CustomBucketsSchema, PositiveSpans: []histogram.Span{{Offset: -1, Length: 1}}, PositiveBuckets: []float64{1}, CustomValues: []float64{1}},
		"custom with negative bucket": {Schema: histogram.CustomBucketsSchema, NegativeSpans: []histogram.Span{{Length: 1}}, NegativeBuckets: []float64{1}, CustomValues: []float64{1}},
		"custom with zero count":      {Schema: histogram.CustomBucketsSchema, ZeroCount: 1, PositiveSpans: []histogram.Span{{Length: 1}}, PositiveBuckets: []float64{1}, CustomValues: []float64{1}},
	}
	for name, h := range badHistograms {
		t.Run(name, func(t *testing.T) {
			r := testResponse{resultType: "matrix", series: []testSeries{{histograms: []testHistogram{{1, h}}}}}
			rsp := readProtobufResponse(r.protobuf(), Options{})
			require.ErrorIs(t, rsp.Error, errMalformedProtobuf)
		})
	}

	t.Run("length past the end of the body", func(t *testing.T) {
		b := protowire.AppendTag(nil, 3, protowire.BytesType)
		b = protowire.AppendVarint(b, 1<<40)
		rsp := readProtobufResponse(b, Options{})
		require.Error(t, rsp.Error)
	})
	t.Run("odd number of label strings", func(t *testing.T) {
		r := testResponse{resultType: "matrix", series: []testSeries{{labels: []string{"a"}, samples: []testSample{{1, 1}}}}}
		rsp := readProtobufResponse(r.protobuf(), Options{})
		require.ErrorIs(t, rsp.Error, errMalformedProtobuf)
	})
	t.Run("unknown fields are skipped", func(t *testing.T) {
		b := valid
		b = protowire.AppendTag(b, 20, protowire.VarintType)
		b = protowire.AppendVarint(b, 5)
		b = protowire.AppendTag(b, 21, protowire.Fixed32Type)
		b = protowire.AppendFixed32(b, 5)
		b = protowire.AppendTag(b, 22, protowire.BytesType)
		b = protowire.AppendBytes(b, []byte("x"))
		requireSameResponse(t, readProtobufResponse(valid, Options{}), readProtobufResponse(b, Options{}))
	})
}

func FuzzReadMimirProtobufResult(f *testing.F) {
	rnd := rand.New(rand.NewPCG(3, 4))
	for range 20 {
		f.Add(randomResponse(rnd).protobuf())
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		_ = readProtobufResponse(b, Options{MaxSeries: 100})
	})
}

func promShapedResponse(resultType string, series, samples, labels int) testResponse {
	r := testResponse{resultType: resultType}
	ts := int64(1_795_097_040_000)
	for i := range series {
		s := testSeries{labels: []string{"__name__", "http_requests_total"}}
		for j := 1; j < labels; j++ {
			s.labels = append(s.labels, fmt.Sprintf("label_%02d", j), fmt.Sprintf("value-%d-%d", j, i%(j*7+1)))
		}
		for j := range samples {
			// Rate-like values with full float64 precision, as most query results have.
			s.samples = append(s.samples, testSample{ts + int64(j)*15_000, float64(i*j%9973) / 7.0})
		}
		r.series = append(r.series, s)
	}
	return r
}

func withHistograms(r testResponse) testResponse {
	for i := range r.series {
		for _, s := range r.series[i].samples {
			h := exponentialHistogram()
			h.Count, h.Sum = s.value*26, s.value
			r.series[i].histograms = append(r.series[i].histograms, testHistogram{s.ts, h})
		}
		r.series[i].samples = nil
	}
	return r
}

func TestReadMimirProtobufResultAllocs(t *testing.T) {
	r := promShapedResponse("matrix", 100, 60, 10)
	pb := r.protobuf()
	requireDecodersAgree(t, r, Options{})
	allocs := testing.AllocsPerRun(20, func() {
		_ = ReadMimirProtobufResult(bytes.NewReader(pb), Options{})
	})
	perSeries := allocs / 100
	t.Logf("%.1f allocations per series", perSeries)
	require.LessOrEqual(t, perSeries, 32.0, "the JSON decoder makes 65 allocations per series for this response")
}

// The testdata/mimir-protobuf fixtures are the same responses written by Mimir's jsonFormatter and ProtobufFormatter
// (grafana/mimir ebcabb3e5041), so they check both decoders against Mimir's own encoders.
func TestReadMimirProtobufResultMatchesMimirFixtures(t *testing.T) {
	names, err := filepath.Glob("testdata/mimir-protobuf/*.pb")
	require.NoError(t, err)
	require.NotEmpty(t, names)
	for _, pbPath := range names {
		name := strings.TrimSuffix(filepath.Base(pbPath), ".pb")
		t.Run(name, func(t *testing.T) {
			pb, err := os.ReadFile(pbPath)
			require.NoError(t, err)
			js, err := os.ReadFile(strings.TrimSuffix(pbPath, ".pb") + ".json")
			require.NoError(t, err)
			want, got := readJSONResponse(js, Options{}), readProtobufResponse(pb, Options{})

			switch name {
			case "vector-interleaved":
				require.NoError(t, got.Error)
				require.Len(t, got.Frames, 2)
				require.Equal(t, want.Frames[0].Fields[0].Labels, got.Frames[1].Fields[0].Labels, "the protobuf vector lists float samples before histograms")
				requireSameResponse(t, backend.DataResponse{Frames: []*data.Frame{want.Frames[1], want.Frames[0]}}, got)
			case "matrix-negative-zero":
				require.Equal(t, math.Copysign(0, -1), want.Frames[0].Fields[1].At(0))
				require.Equal(t, 0.0, got.Frames[0].Fields[1].At(0), "gogo/protobuf leaves -0 out, so it decodes as 0")
				require.False(t, math.Signbit(got.Frames[0].Fields[1].At(0).(float64)))
			default:
				requireSameResponse(t, want, got)
			}
		})
	}
}
