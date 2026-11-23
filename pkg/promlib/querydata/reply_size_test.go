package querydata

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/querydata/exemplar"
)

func encodedReplySize(t testing.TB, responses backend.Responses) int64 {
	t.Helper()
	var n int64
	for _, r := range responses {
		for _, f := range r.Frames {
			b, err := f.MarshalArrow()
			require.NoError(t, err)
			n += framed(len(b))
		}
	}
	return n
}

var labelValueTails = []string{
	"", "", "", "", "", "", `q"b\s`, "<a&b>", "é€\u2028\x01\n", "\xff",
	strings.Repeat("\xff", 16), strings.Repeat("<", 16), strings.Repeat(`"`, 16), strings.Repeat("\u2028", 8), strings.Repeat("\x01", 16),
}

func randomSeriesFrame(r *rand.Rand, labels, rows int, legend string) *data.Frame {
	l := data.Labels{"__name__": strings.Repeat("m", 5+r.Intn(70))}
	for i := range labels {
		l[fmt.Sprintf("label_%d_%s", i, strings.Repeat("k", r.Intn(12)))] = strings.Repeat("v", r.Intn(60)) + labelValueTails[r.Intn(len(labelValueTails))]
	}
	f := data.NewFrame("", data.NewField("Time", nil, make([]time.Time, rows)), data.NewField(l["__name__"], l, make([]float64, rows)))
	f.Fields[0].Config = &data.FieldConfig{Interval: float64(15000 * (1 + r.Intn(8)))}
	switch legend {
	case "":
		f.Fields[1].Config = &data.FieldConfig{DisplayNameFromDS: l.String()}
	case "custom":
		f.Fields[1].Config = &data.FieldConfig{DisplayNameFromDS: "custom " + strings.Repeat("x", r.Intn(30))}
	}
	f.Meta = &data.FrameMeta{Type: data.FrameTypeNumericMulti, TypeVersion: data.FrameTypeVersion{0, 1}, Custom: map[string]any{"resultType": "vector"}}
	return f
}

// randomResponse mixes plain series frames with frame shapes the bound does not model: a first frame with stats and
// non-string custom meta, histogram frames with more fields, and exemplar frames with string fields.
func randomResponse(r *rand.Rand) backend.DataResponse {
	n := 1 + r.Intn(40)
	labels, rows := r.Intn(25), 1
	if r.Intn(2) == 0 {
		rows = 1 + r.Intn(300)
	}
	legend := []string{"", "__auto", "custom"}[r.Intn(3)]
	frames := make(data.Frames, 0, n+2)
	for i := range n {
		f := randomSeriesFrame(r, labels, rows, legend)
		if i == 0 {
			f.Meta.ExecutedQueryString = "Expr: " + strings.Repeat("e", r.Intn(200))
			f.Meta.Custom = map[string]any{"calculatedMinStep": int64(60000), "resultType": "vector"}
			f.Meta.Stats = []data.QueryStat{{FieldConfig: data.FieldConfig{DisplayName: "Instant: Response time"}, Value: 12}}
		}
		frames = append(frames, f)
	}
	if r.Intn(3) == 0 {
		h := data.NewFrame("", data.NewField("Time", nil, make([]time.Time, rows)), data.NewField("yMin", nil, make([]float64, rows)),
			data.NewField("yMax", nil, make([]float64, rows)), data.NewField("count", data.Labels{"le": "+Inf"}, make([]float64, rows)))
		h.Meta = &data.FrameMeta{Type: "heatmap-cells"}
		frames = append(frames, h)
	}
	if r.Intn(3) == 0 {
		e := data.NewFrame("exemplar", data.NewField("Time", nil, make([]time.Time, rows)), data.NewField("Value", nil, make([]float64, rows)),
			data.NewField("traceID", nil, make([]string, rows)))
		e.Meta = &data.FrameMeta{Custom: map[string]any{"resultType": "exemplar"}}
		frames = append(frames, e)
	}
	r.Shuffle(len(frames)-1, func(i, j int) { frames[i+1], frames[j+1] = frames[j+1], frames[i+1] })
	return backend.DataResponse{Frames: frames}
}

func TestReplySizeLowerBoundNeverExceedsTheEncodedReply(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for i := range 3000 {
		responses := backend.Responses{}
		for q := range 1 + r.Intn(3) {
			responses[fmt.Sprint("R", q)] = randomResponse(r)
		}
		bound, exact := replySizeLowerBound(responses, 0), encodedReplySize(t, responses)
		require.LessOrEqual(t, bound, exact, "reply %d", i)
	}
}

// ruleShapeBody writes a Prometheus instant vector like the recording rules whose replies fail in production: 16 labels
// and about 800 JSON bytes per series.
func ruleShapeBody(series int) []byte {
	pad := func(s string, n int) string { return (s + strings.Repeat("x", n))[:n] }
	var b bytes.Buffer
	b.WriteString(`{"status":"success","data":{"resultType":"vector","result":[`)
	for i := range series {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `{"metric":{"__name__":"cluster:namespace:pod_memory:active:kube_pod_container_resource_limits","cluster":%q,"container":%q,"instance":%q,"job":%q,"namespace":%q,"pod":%q,"resource":"memory","uid":"%08x-0000-4000-8000-%012x","unit":"byte","node":%q,"environment":%q`,
			pad(fmt.Sprintf("cluster-%02d", i%41), 14), pad(fmt.Sprintf("ctr-%03d", i%122), 13), pad(fmt.Sprintf("ksm-%02d:kube-state-metrics:http", i%15), 43),
			pad("integrations/kubernetes/kube-state-me", 37), pad(fmt.Sprintf("ns-%03d", i%120), 18), pad(fmt.Sprintf("pod-%07d-", i*5/8), 30), i, i,
			pad(fmt.Sprintf("ip-10-0-%d-%d.ec2.internal", (i/250)%256, i%7000), 44), pad(fmt.Sprintf("cluster-%02d", i%41), 14))
		for j := range 4 {
			fmt.Fprintf(&b, `,"extra_label_%d":%q`, j, pad(fmt.Sprintf("value-%d-%d", j, i%(50*(j+1))), 40))
		}
		fmt.Fprintf(&b, `},"value":[1795100000,"%d"]}`, (i%64+1)*134217728)
	}
	b.WriteString(`]}}`)
	return b.Bytes()
}

// The smallest oversized replies seen in production are about 2.04 GiB, so the bound must reach 0.98 of the encoded
// size there. This shape at 482,000 series encodes to about 2.17 GB.
func TestReplySizeLowerBoundCatchesTheRuleShapeJustOverTheLimit(t *testing.T) {
	const sample, prodSeries = 2000, 482_000
	qd := QueryData{exemplarSampler: exemplar.NewStandardDeviationSampler}
	q := &models.Query{Expr: "x", Step: time.Minute, InstantQuery: true}
	dr := qd.parseResponse(context.Background(), q, &http.Response{Body: io.NopCloser(bytes.NewReader(ruleShapeBody(sample))), StatusCode: http.StatusOK}, models.InstantQueryType)
	require.NoError(t, dr.Error)
	responses := backend.Responses{"A": dr}

	bound, exact := replySizeLowerBound(responses, 0), encodedReplySize(t, responses)
	require.GreaterOrEqual(t, float64(bound)/float64(exact), 0.985)
	require.Greater(t, exact*prodSeries/sample, int64(replySizeLimit), "the reply at prod size fails to send today")
	require.Greater(t, bound*prodSeries/sample, int64(replySizeLimit), "the bound at prod size catches it")
}

func plainFrames(n int) data.Frames {
	r := rand.New(rand.NewSource(2))
	frames := make(data.Frames, n)
	for i := range frames {
		frames[i] = randomSeriesFrame(r, 12, 1, "")
	}
	return frames
}

func TestReplySizeLowerBoundAllocatesTheSameForAnyFrameCount(t *testing.T) {
	allocs := func(n int) float64 {
		responses := backend.Responses{"A": {Frames: plainFrames(n)}}
		return testing.AllocsPerRun(3, func() { replySizeLowerBound(responses, 0) })
	}
	small, large := allocs(1000), allocs(20_000)
	require.LessOrEqual(t, large, small+5, "the Arrow encoder's own allocations vary by one or two")
	require.LessOrEqual(t, large, 300.0)
}

func BenchmarkReplySizeLowerBound(b *testing.B) {
	responses := backend.Responses{"A": {Frames: plainFrames(100_000)}}
	b.ReportAllocs()
	for b.Loop() {
		replySizeLowerBound(responses, 0)
	}
}
