package converter

import (
	"cmp"
	"slices"
	"sort"
	"time"
	"unicode/utf8"

	"github.com/grafana/grafana-plugin-sdk-go/data"
)

// vectorTable collects an instant vector into the single frame the frontend
// builds in transformDFToTable: Time, one string field per label (in order of
// first appearance, sorted within each series) and Value. Every frame sent over
// gRPC carries its own Arrow schema, so one frame per series costs several
// times more than the same rows in one frame.
type vectorTable struct {
	labelIdx map[string]int
	names    []string
	cols     [][]string
	times    []time.Time
	values   []float64
	// noLabels marks rows whose series had no metric object, so seriesFrames can tell nil from empty labels
	noLabels []bool
	// emptyValues marks cells holding a label whose value is "", so seriesFrames can tell them from absent labels
	emptyValues map[[2]int]bool
	pairs       int
}

// A table with many distinct label names but few labels per series is mostly
// empty cells. Past these limits the reader falls back to one frame per series,
// so the table never costs much more than the labels in the response.
const (
	maxEmptyCellRatio = 8
	minTableCellLimit = 1 << 16
)

func newVectorTable() *vectorTable {
	return &vectorTable{labelIdx: map[string]int{}}
}

func (t *vectorTable) add(labels [][2]string, times []time.Time, values []float64) {
	// match Object.keys(labels).sort() in the frontend; stable so a repeated key keeps the last value like a map
	slices.SortStableFunc(labels, func(a, b [2]string) int { return compareUTF16(a[0], b[0]) })
	for _, l := range labels {
		if _, ok := t.labelIdx[l[0]]; !ok {
			t.labelIdx[l[0]] = len(t.names)
			t.names = append(t.names, l[0])
			t.cols = append(t.cols, make([]string, len(t.times), cap(t.times)))
		}
	}
	for i := range times {
		t.times = append(t.times, times[i])
		t.values = append(t.values, values[i])
		t.noLabels = append(t.noLabels, labels == nil)
		for c := range t.cols {
			t.cols[c] = append(t.cols[c], "")
		}
		row := len(t.times) - 1
		for _, l := range labels {
			col := t.labelIdx[l[0]]
			t.cols[col][row] = l[1]
			if l[1] == "" {
				if t.emptyValues == nil {
					t.emptyValues = map[[2]int]bool{}
				}
				t.emptyValues[[2]int{row, col}] = true
			}
		}
		t.pairs += len(labels)
	}
}

// fits reports whether adding a series with these labels and rows keeps the
// table within the sparse limits. It is checked before add, so a series with
// many new label names never allocates its columns.
func (t *vectorTable) fits(labels [][2]string, rows int) bool {
	newNames := 0
	for _, l := range labels {
		if _, ok := t.labelIdx[l[0]]; !ok {
			newNames++
		}
	}
	totalRows := len(t.times) + rows
	cells := totalRows * (len(t.names) + newNames)
	pairs := t.pairs + rows*len(labels)
	return cells <= minTableCellLimit || cells <= maxEmptyCellRatio*(pairs+totalRows)
}

// compareUTF16 orders strings by UTF-16 code units, like JavaScript's default sort.
func compareUTF16(a, b string) int {
	for a != "" && b != "" {
		ra, na := utf8.DecodeRuneInString(a)
		rb, nb := utf8.DecodeRuneInString(b)
		if ra != rb {
			ha, la := utf16Units(ra)
			hb, lb := utf16Units(rb)
			if c := cmp.Compare(ha, hb); c != 0 {
				return c
			}
			return cmp.Compare(la, lb)
		}
		a, b = a[na:], b[nb:]
	}
	return cmp.Compare(len(a), len(b))
}

// utf16Units returns the first and second UTF-16 code unit of r, the second is -1 for runes in the BMP.
func utf16Units(r rune) (int, int) {
	if r < 0x10000 {
		return int(r), -1
	}
	r -= 0x10000
	return int(0xD800 + (r >> 10)), int(0xDC00 + (r & 0x3FF))
}

func (t *vectorTable) frame() *data.Frame {
	if !sort.SliceIsSorted(t.times, func(i, j int) bool { return t.times[i].Before(t.times[j]) }) {
		idx := make([]int, len(t.times))
		for i := range idx {
			idx[i] = i
		}
		sort.SliceStable(idx, func(i, j int) bool { return t.times[idx[i]].Before(t.times[idx[j]]) })
		t.times = reorder(t.times, idx)
		t.values = reorder(t.values, idx)
		for c := range t.cols {
			t.cols[c] = reorder(t.cols[c], idx)
		}
	}

	filterable := true
	fields := make([]*data.Field, 0, len(t.names)+2)
	fields = append(fields, data.NewField(data.TimeSeriesTimeFieldName, nil, t.times))
	for c, name := range t.names {
		fields = append(fields, data.NewField(name, nil, t.cols[c]).SetConfig(&data.FieldConfig{Filterable: &filterable}))
	}
	fields = append(fields, data.NewField(data.TimeSeriesValueFieldName, nil, t.values))

	frame := data.NewFrame("", fields...)
	frame.Meta = &data.FrameMeta{
		Type:        data.FrameTypeNumericLong,
		TypeVersion: data.FrameTypeVersion{0, 1},
		Custom:      resultTypeToCustomMeta("vector"),
	}
	return frame
}

// seriesFrames splits the table back into one frame per series. It is used
// when a native histogram shows up, which cannot be a table row, or when the
// table gets too sparse.
func (t *vectorTable) seriesFrames() []*data.Frame {
	frames := make([]*data.Frame, 0, len(t.times))
	for row := range t.times {
		var labels data.Labels
		if !t.noLabels[row] {
			labels = data.Labels{}
		}
		for c, name := range t.names {
			if v := t.cols[c][row]; v != "" || t.emptyValues[[2]int{row, c}] {
				labels[name] = v
			}
		}
		frames = append(frames, newSeriesFrame("vector", labels, []time.Time{t.times[row]}, []float64{t.values[row]}))
	}
	return frames
}

func pairsToLabels(pairs [][2]string) data.Labels {
	if pairs == nil {
		return nil
	}
	labels := make(data.Labels, len(pairs))
	for _, p := range pairs {
		labels[p[0]] = p[1]
	}
	return labels
}

func reorder[T any](s []T, idx []int) []T {
	out := make([]T, len(s))
	for i, j := range idx {
		out[i] = s[j]
	}
	return out
}
