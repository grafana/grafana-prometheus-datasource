//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/klauspost/compress/snappy"
	"github.com/prometheus/prometheus/model/histogram"
	"github.com/prometheus/prometheus/prompb"
)

type target struct {
	name            string
	queryURL        string
	writeURL        string
	answersProtobuf bool
}

var targets = []target{
	{name: "prometheus", queryURL: "http://localhost:39090", writeURL: "http://localhost:39090/api/v1/write"},
	{name: "prometheus-2.40", queryURL: "http://localhost:39040", writeURL: "http://localhost:39040/api/v1/write"},
	{name: "mimir", queryURL: "http://localhost:39009/prometheus", writeURL: "http://localhost:39009/api/v1/push", answersProtobuf: true},
	{name: "cortex", queryURL: "http://localhost:39010/prometheus", writeURL: "http://localhost:39010/api/v1/push"},
	{name: "thanos", queryURL: "http://localhost:39904", writeURL: "http://localhost:39291/api/v1/receive"},
}

type dataset struct {
	metric    string
	series    int
	histogram bool
}

var datasets = []dataset{
	{metric: "it_vector", series: 50},
	{metric: "it_matrix", series: 10},
	{metric: "it_hist", series: 5, histogram: true},
}

const (
	step   = 15 * time.Second
	points = 121
	window = (points - 1) * step
)

// Each run writes new series, so a rerun against the same containers never writes samples out of order.
var (
	anchor time.Time
	run    string
)

var errRejected = errors.New("rejected")

func selector(metric string) string {
	return fmt.Sprintf("%s{run=%q}", metric, run)
}

func TestMain(m *testing.M) {
	anchor = time.Now().Truncate(step)
	run = strconv.FormatInt(time.Now().UnixNano(), 10)
	ctx, cancel := context.WithTimeoutCause(context.Background(), 3*time.Minute, errors.New("backends not loaded within 3m"))
	err := load(ctx)
	cancel()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}

func load(ctx context.Context) error {
	body, err := writeRequest()
	if err != nil {
		return err
	}
	want := 0
	for _, d := range datasets {
		want += d.series
	}
	for _, tgt := range targets {
		if err := retry(ctx, func() error { return write(ctx, tgt.writeURL, body) }); err != nil {
			return fmt.Errorf("write to %s: %w", tgt.name, err)
		}
		if err := retry(ctx, func() error { return visible(ctx, tgt.queryURL, want) }); err != nil {
			return fmt.Errorf("read from %s: %w", tgt.name, err)
		}
	}
	return nil
}

func retry(ctx context.Context, f func() error) error {
	for {
		err := f()
		if err == nil || errors.Is(err, errRejected) {
			return err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%w: last error: %w", context.Cause(ctx), err)
		case <-time.After(time.Second):
		}
	}
}

func writeRequest() ([]byte, error) {
	var req prompb.WriteRequest
	for _, d := range datasets {
		for i := range d.series {
			ts := prompb.TimeSeries{Labels: []prompb.Label{{Name: "__name__", Value: d.metric}, {Name: "run", Value: run}, {Name: "series", Value: strconv.Itoa(i)}}}
			for p := range points {
				at := anchor.Add(time.Duration(p-points+1) * step).UnixMilli()
				if d.histogram {
					ts.Histograms = append(ts.Histograms, prompb.FromIntHistogram(at, histogramAt(uint64(i+p+1))))
				} else {
					ts.Samples = append(ts.Samples, prompb.Sample{Timestamp: at, Value: float64(i*points + p)})
				}
			}
			req.Timeseries = append(req.Timeseries, ts)
		}
	}
	b, err := req.Marshal()
	if err != nil {
		return nil, fmt.Errorf("marshal write request: %w", err)
	}
	return snappy.Encode(nil, b), nil
}

func histogramAt(k uint64) *histogram.Histogram {
	return &histogram.Histogram{
		Schema:          1,
		ZeroThreshold:   0.001,
		ZeroCount:       k,
		Count:           7 * k,
		Sum:             1.5 * float64(k),
		PositiveSpans:   []histogram.Span{{Offset: 0, Length: 3}},
		PositiveBuckets: []int64{int64(k), int64(k), int64(k)},
	}
}

func write(ctx context.Context, u string, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("new request: %w", err)
	}
	req.Header.Set("Content-Encoding", "snappy")
	req.Header.Set("Content-Type", "application/x-protobuf")
	req.Header.Set("X-Prometheus-Remote-Write-Version", "0.1.0")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("remote write: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode/100 == 2 {
		return nil
	}
	msg, _ := io.ReadAll(res.Body)
	err = fmt.Errorf("remote write: %s: %s", res.Status, bytes.TrimSpace(msg))
	if res.StatusCode/100 == 4 && res.StatusCode != http.StatusTooManyRequests {
		return fmt.Errorf("%w: %w", errRejected, err)
	}
	return err
}

func visible(ctx context.Context, queryURL string, want int) error {
	q := url.Values{"query": {fmt.Sprintf(`count({__name__=~"it_.+",run=%q})`, run)}, "time": {strconv.FormatInt(anchor.Unix(), 10)}}
	return queryCount(ctx, queryURL, q, want)
}

// queryCount runs an instant count query and checks that its one result is want.
func queryCount(ctx context.Context, queryURL string, q url.Values, want int) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, queryURL+"/api/v1/query?"+q.Encode(), nil)
	if err != nil {
		return fmt.Errorf("new request: %w", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("query: %w", err)
	}
	defer res.Body.Close()
	var out struct {
		Data struct {
			Result []struct {
				Value [2]any `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return fmt.Errorf("decode query response: %w", err)
	}
	if len(out.Data.Result) != 1 {
		return fmt.Errorf("query returned %d results, want 1", len(out.Data.Result))
	}
	if got := out.Data.Result[0].Value[1]; got != strconv.Itoa(want) {
		return fmt.Errorf("found %v series, want %d", got, want)
	}
	return nil
}
