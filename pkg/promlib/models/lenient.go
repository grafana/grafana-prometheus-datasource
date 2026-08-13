package models

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
)

// maxLoggedValueLen keeps a stored object or array from filling a log line.
const maxLoggedValueLen = 64

func coerced(toValueType, fromValueType string, data []byte) {
	logLenient(fromValueType, toValueType, "coerced", data)
}

func dropped(toValueType, fromValueType string, data []byte) {
	logLenient(fromValueType, toValueType, "dropped", data)
}

func logLenient(fromValueType, toValueType, outcome string, data []byte) {
	value := string(data)
	if len(value) > maxLoggedValueLen {
		value = value[:maxLoggedValueLen] + "…"
	}
	log.DefaultLogger.Warn("datasource jsonData value does not match its declared type",
		"from", fromValueType, "to", toValueType, "outcome", outcome, "value", value)
}

// LenientBool also accepts the string and numeric spellings of a boolean.
type LenientBool bool

func (b *LenientBool) UnmarshalJSON(data []byte) error {
	var value bool
	if err := json.Unmarshal(data, &value); err == nil {
		*b = LenientBool(value)
		return nil
	}

	var str string
	if err := json.Unmarshal(data, &str); err == nil {
		if parsed, err := strconv.ParseBool(strings.TrimSpace(str)); err == nil {
			*b = LenientBool(parsed)
			coerced("bool", "string", data)
			return nil
		}
		dropped("bool", "string", data)
		return nil
	}

	var number float64
	if err := json.Unmarshal(data, &number); err == nil {
		*b = LenientBool(number != 0)
		coerced("bool", "float64", data)
		return nil
	}

	dropped("bool", "unknown", data)
	return nil
}

// LenientString also accepts a scalar, keeping its JSON text, so an identifier or version
// that YAML turned into a number (prometheusVersion: 2.4) is not blanked.
type LenientString string

func (s *LenientString) UnmarshalJSON(data []byte) error {
	var str string
	if err := json.Unmarshal(data, &str); err == nil {
		*s = LenientString(str)
		return nil
	}

	var number float64
	if err := json.Unmarshal(data, &number); err == nil {
		*s = LenientString(strings.TrimSpace(string(data)))
		coerced("string", "float64", data)
		return nil
	}

	var boolean bool
	if err := json.Unmarshal(data, &boolean); err == nil {
		*s = LenientString(strings.TrimSpace(string(data)))
		coerced("string", "bool", data)
		return nil
	}

	dropped("string", "unknown", data)
	return nil
}

// LenientFloat64 also accepts a quoted number.
type LenientFloat64 float64

func (f *LenientFloat64) UnmarshalJSON(data []byte) error {
	value, from, ok := readFloat64(data)
	if !ok {
		dropped("float64", from, data)
		return nil
	}

	*f = LenientFloat64(value)
	if from != "" {
		coerced("float64", from, data)
	}

	return nil
}

// readFloat64 reports what LenientFloat64 reads, which JSON type it came from ("" meaning the
// declared type, so no leniency), and whether it could be read at all. Split out so
// clearDroppedPointers can ask the same question without logging and skewing the counts.
func readFloat64(data []byte) (value float64, from string, ok bool) {
	var number float64
	if err := json.Unmarshal(data, &number); err == nil {
		// value was expected float64
		return number, "", true
	}

	var str string
	if err := json.Unmarshal(data, &str); err == nil {
		if parsed, err := strconv.ParseFloat(strings.TrimSpace(str), 64); err == nil {
			// value was a number string
			return parsed, "string", true
		}
		// value was a non number string (i.e. "ten")
		return 0, "string", false
	}

	// value was an unsupported value to coerce from.
	return 0, "unknown", false
}

// LenientExemplarTraceIDDestinations ignores a value it cannot read. It does not salvage a
// partial one: a guess would only disagree with what the frontend reads from jsonData.
type LenientExemplarTraceIDDestinations []ExemplarTraceIDDestination

func (d *LenientExemplarTraceIDDestinations) UnmarshalJSON(data []byte) error {
	var destinations []ExemplarTraceIDDestination
	if err := json.Unmarshal(data, &destinations); err == nil {
		*d = destinations
		return nil
	}

	dropped("exemplarDestinations", "unknown", data)
	return nil
}

// encoding/json allocates a pointer field before the lenient type sees the value, so a dropped
// value leaves it non-nil at zero — indistinguishable from a stored 0, which for seriesLimit is
// the difference between "apply your own default" and "limit is zero". A lenient type is handed
// a pointer to the allocated value, never to the field, so only the parser can restore nil.
func (o *PromOptions) clearDroppedPointers(data []byte) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return
	}

	if value, ok := raw["seriesLimit"]; ok {
		if _, _, readable := readFloat64(value); !readable {
			// value was an unsupported value to coerce from
			// set to nil so ensure it is not confused with a stored 0
			o.SeriesLimit = nil
		}
	}
}
