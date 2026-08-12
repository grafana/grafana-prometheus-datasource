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
	var number float64
	if err := json.Unmarshal(data, &number); err == nil {
		*f = LenientFloat64(number)
		return nil
	}

	var str string
	if err := json.Unmarshal(data, &str); err == nil {
		if parsed, err := strconv.ParseFloat(strings.TrimSpace(str), 64); err == nil {
			*f = LenientFloat64(parsed)
			coerced("float64", "string", data)
			return nil
		}
		dropped("float64", "string", data)
		return nil
	}

	dropped("float64", "unknown", data)
	return nil
}

// LenientExemplarTraceIDDestinations ignores a value it cannot read rather than failing the
// unmarshal. It deliberately does not salvage a partial value: the backend never reads this
// property, so a guessed one would only disagree with what the frontend reads from jsonData.
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
