package models

import (
	"encoding/json"
	"strconv"
	"strings"
)

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
		}
		return nil
	}

	var number float64
	if err := json.Unmarshal(data, &number); err == nil {
		*b = LenientBool(number != 0)
	}

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

	var scalar any
	if err := json.Unmarshal(data, &scalar); err == nil {
		switch scalar.(type) {
		case float64, bool:
			*s = LenientString(strings.TrimSpace(string(data)))
		}
	}

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
		}
	}

	return nil
}

// LenientInt64 also accepts quoted and fractional numbers, truncating them. dsconfig has no
// integer valueType, so a stored 1000.0 is schema-valid but encoding/json rejects it.
type LenientInt64 int64

func (i *LenientInt64) UnmarshalJSON(data []byte) error {
	var number float64
	if err := json.Unmarshal(data, &number); err == nil {
		*i = LenientInt64(number)
		return nil
	}

	var str string
	if err := json.Unmarshal(data, &str); err == nil {
		if parsed, err := strconv.ParseFloat(strings.TrimSpace(str), 64); err == nil {
			*i = LenientInt64(parsed)
		}
	}

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
	}

	return nil
}
