package querydata

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"strconv"
	"unicode/utf8"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
)

// replySizeLimit is the largest message grpc-go sends to Grafana by default.
const replySizeLimit = math.MaxInt32

// replySizeGuardEnv turns the guard off when set to false or 0. Grafana passes [plugin.<id>] reply_size_guard as this variable.
const replySizeGuardEnv = "GF_PLUGIN_REPLY_SIZE_GUARD"

// replySizeMarginPerFrame covers the 8-byte padding of Arrow IPC messages, which differs between frames by up to 40 bytes.
const replySizeMarginPerFrame = 48

// ErrReplyTooLarge is the error for a reply that is too large to send to Grafana. Its text is a stable token.
var ErrReplyTooLarge = errors.New("err-prometheus-reply-too-large")

func replySizeGuardEnabled() bool {
	v := os.Getenv(replySizeGuardEnv)
	return v != "false" && v != "0"
}

// rejectOversizedReply fails every query of result when a lower bound of its encoded size is over limit, and returns
// that bound. Such a reply cannot reach Grafana, so this changes no reply that would arrive.
func rejectOversizedReply(result *backend.QueryDataResponse, limit int64) (int64, bool) {
	size := replySizeLowerBound(result.Responses, limit)
	if size <= limit {
		return size, false
	}
	err := fmt.Errorf("query result would encode to at least %d bytes, more than the %d-byte limit of a reply to Grafana (%w)", size, limit, ErrReplyTooLarge)
	for refID := range result.Responses {
		result.Responses[refID] = backend.DataResponse{Error: err, ErrorSource: backend.ErrorSourceDownstream}
	}
	return size, true
}

const replySizeRefSearch = 16

// replySizeMinFrames is the frame count under which a reply is checked only for its column bytes.
const replySizeMinFrames = 1000

// replySizeLowerBound returns a lower bound of the protobuf bytes the SDK writes for the frames of responses, or 0 when
// a rough estimate puts the reply under half of limit.
func replySizeLowerBound(responses backend.Responses, limit int64) int64 {
	var frames, columns int64
	for _, r := range responses {
		frames += int64(len(r.Frames))
		for _, f := range r.Frames {
			for _, fl := range f.Fields {
				columns += 8 * int64(fl.Len())
			}
		}
	}
	if frames < replySizeMinFrames && columns < limit/2 {
		return 0
	}
	refs := make(map[string]replySizeRef, len(responses))
	var rough int64
	for refID, r := range responses {
		ref, ok := newReplySizeRef(r.Frames)
		if !ok {
			continue
		}
		refs[refID] = ref
		rough += int64(ref.size) * int64(len(r.Frames))
	}
	if rough < limit/2 {
		return 0
	}
	var total int64
	for refID, r := range responses {
		if ref, ok := refs[refID]; ok {
			total += ref.lowerBound(r.Frames)
		}
	}
	return total
}

// replySizeRef holds the exact size of the first frame and the fixed Arrow overhead of a plain series frame, learned
// from one exact encoding.
type replySizeRef struct {
	first, size, fixed int
	plain              bool
}

func newReplySizeRef(frames data.Frames) (replySizeRef, bool) {
	if len(frames) == 0 {
		return replySizeRef{}, false
	}
	first, err := frames[0].MarshalArrow()
	if err != nil {
		return replySizeRef{}, false
	}
	ref := replySizeRef{first: len(first), size: len(first)}
	i := 1
	for i < len(frames) && i <= replySizeRefSearch && !isPlainSeriesFrame(frames[i]) {
		i++
	}
	if i >= len(frames) || i > replySizeRefSearch {
		return ref, true
	}
	b, err := frames[i].MarshalArrow()
	if err != nil {
		return ref, true
	}
	strs, body := plainFrameVariableBytes(frames[i], exactJSONLens)
	ref.size = len(b)
	ref.fixed = len(b) - 2*strs - body - replySizeMarginPerFrame
	ref.plain = ref.fixed > 0
	return ref, true
}

func (ref replySizeRef) lowerBound(frames data.Frames) int64 {
	total := framed(ref.first)
	if !ref.plain {
		return total
	}
	for _, f := range frames[1:] {
		if !isPlainSeriesFrame(f) {
			continue
		}
		strs, body := plainFrameVariableBytes(f, boundJSONLens)
		total += framed(ref.fixed + 2*strs + body)
	}
	return total
}

// framed adds the tag and length prefix of a frame in the repeated bytes field of the protobuf message.
func framed(n int) int64 {
	l := 1
	for v := n; v >= 0x80; v >>= 7 {
		l++
	}
	return int64(n + 1 + l)
}

// isPlainSeriesFrame reports whether f has the shape of a time series frame from this package: time and float64
// values, labels on the value field only, and only the field config and frame meta members this package sets.
func isPlainSeriesFrame(f *data.Frame) bool {
	if len(f.Fields) != 2 || f.Fields[0].Labels != nil {
		return false
	}
	switch f.Fields[0].Type() {
	case data.FieldTypeTime, data.FieldTypeNullableTime:
	default:
		return false
	}
	switch f.Fields[1].Type() {
	case data.FieldTypeFloat64, data.FieldTypeNullableFloat64:
	default:
		return false
	}
	return plainConfig(f.Fields[0].Config) && plainConfig(f.Fields[1].Config) && plainMeta(f.Meta)
}

func plainConfig(c *data.FieldConfig) bool {
	return c == nil || (c.DisplayName == "" && c.Path == "" && c.Description == "" && c.Filterable == nil &&
		c.Writeable == nil && c.Unit == "" && c.Decimals == nil && c.Min == nil && c.Max == nil && c.Mappings == nil &&
		c.Thresholds == nil && c.Color == nil && c.Links == nil && c.NoValue == "" && c.TypeConfig == nil && c.Custom == nil)
}

func plainMeta(m *data.FrameMeta) bool {
	if m == nil {
		return true
	}
	if m.Path != "" || m.PathSeparator != "" || len(m.Stats) > 0 || len(m.Notices) > 0 || m.Channel != "" ||
		m.PreferredVisualization != "" || m.PreferredVisualizationPluginID != "" || m.DataTopic != "" {
		return false
	}
	if m.Custom == nil {
		return true
	}
	c, ok := m.Custom.(map[string]any)
	if !ok {
		return false
	}
	for _, v := range c {
		if _, ok := v.(string); !ok {
			return false
		}
	}
	return true
}

// jsonLens gives the JSON lengths of the metadata the SDK writes into an Arrow schema.
type jsonLens struct {
	labels func(data.Labels) int
	config func(*data.FieldConfig) int
	meta   func(*data.FrameMeta) int
}

// exactJSONLens measures the reference frame. boundJSONLens never exceeds it and does not allocate.
var (
	exactJSONLens = jsonLens{labels: marshalledLen[data.Labels], config: marshalledLen[*data.FieldConfig], meta: marshalledLen[*data.FrameMeta]}
	boundJSONLens = jsonLens{labels: labelsJSONLen, config: configJSONLen, meta: metaJSONLen}
)

func marshalledLen[T any](v T) int {
	b, err := json.Marshal(v)
	if err != nil {
		return 0
	}
	return len(b)
}

// plainFrameVariableBytes returns the flatbuffer bytes of the strings that vary between plain frames, for one copy of the
// Arrow schema, and the bytes of the record batch columns.
func plainFrameVariableBytes(f *data.Frame, lens jsonLens) (strs, body int) {
	strs = fbString(len(f.Name)) + fbString(len(f.RefID))
	if f.Meta != nil {
		strs += fbString(len("meta")) + fbString(lens.meta(f.Meta))
	}
	for _, fl := range f.Fields {
		strs += fbString(len(fl.Name))
		if fl.Labels != nil {
			strs += fbString(len("labels")) + fbString(lens.labels(fl.Labels))
		}
		if fl.Config != nil {
			strs += fbString(len("config")) + fbString(lens.config(fl.Config))
		}
		rows := fl.Len()
		body += 8 * rows
		if fl.Nullable() {
			body += (rows + 7) / 8 / 8 * 8
		}
	}
	return strs, body
}

// fbString is the bytes a flatbuffer string of length l takes: a 4-byte length, the bytes and a NUL, padded to 4.
func fbString(l int) int { return 4 + (l+1+3)/4*4 }

// jsonStringLen is a lower bound of the length of s as a JSON string from encoding/json. An invalid UTF-8 byte counts
// as one byte, because labels pass it through.
func jsonStringLen(s string) int {
	n := 2
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch {
			case c == '"' || c == '\\' || c == '\n' || c == '\r' || c == '\t' || c == '\b' || c == '\f':
				n += 2
			case c < 0x20 || c == '<' || c == '>' || c == '&':
				n += 6
			default:
				n++
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == utf8.RuneError && size == 1:
			n++
		case r == '\u2028' || r == '\u2029':
			n += 6
		default:
			n += size
		}
		i += size
	}
	return n
}

func labelsJSONLen(l data.Labels) int {
	if len(l) == 0 {
		return 2
	}
	n := 2 + len(l) - 1
	for k, v := range l {
		n += jsonStringLen(k) + 1 + jsonStringLen(v)
	}
	return n
}

func configJSONLen(c *data.FieldConfig) int {
	n, members := 2, 0
	if c.DisplayNameFromDS != "" {
		n += len(`"displayNameFromDS":`) + jsonStringLen(c.DisplayNameFromDS)
		members++
	}
	if c.Interval != 0 {
		n += len(`"interval":`) + jsonFloatLen(c.Interval)
		members++
	}
	if members > 1 {
		n += members - 1
	}
	return n
}

// jsonFloatLen is a lower bound of the length of x from encoding/json, which drops a leading zero of the exponent.
func jsonFloatLen(x float64) int {
	var buf [32]byte
	abs := math.Abs(x)
	if abs != 0 && (abs < 1e-6 || abs >= 1e21) {
		return len(strconv.AppendFloat(buf[:0], x, 'e', -1, 64)) - 1
	}
	return len(strconv.AppendFloat(buf[:0], x, 'f', -1, 64))
}

func metaJSONLen(m *data.FrameMeta) int {
	n, members := 2, 0
	add := func(k int) { n += k; members++ }
	if m.Type != "" {
		add(len(`"type":`) + jsonStringLen(string(m.Type)))
	}
	add(len(`"typeVersion":[,]`) + len(strconv.Itoa(int(m.TypeVersion[0]))) + len(strconv.Itoa(int(m.TypeVersion[1]))))
	if c, ok := m.Custom.(map[string]any); ok && len(c) > 0 {
		k := len(`"custom":{}`) + len(c) - 1
		for key, v := range c {
			k += jsonStringLen(key) + 1 + jsonStringLen(v.(string))
		}
		add(k)
	}
	if m.ExecutedQueryString != "" {
		add(len(`"executedQueryString":`) + jsonStringLen(m.ExecutedQueryString))
	}
	return n + members - 1
}
