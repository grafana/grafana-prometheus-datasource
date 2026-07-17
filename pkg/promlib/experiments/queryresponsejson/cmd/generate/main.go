// Command generate writes a deterministic Prometheus matrix response fixture.
package main

import (
	"bufio"
	"crypto/sha256"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const twoGiB = 2_147_483_648

func main() {
	defaultPath := filepath.Join(os.TempDir(), "prom-query-json-bench", "query-range-2g.json")
	output := flag.String("output", defaultPath, "fixture output path")
	minBytes := flag.Int64("min-bytes", twoGiB, "minimum completed JSON document size")
	samplesPerSeries := flag.Int("samples-per-series", 128, "samples per matrix series")
	flag.Parse()

	if *minBytes <= 0 {
		exitf("min-bytes must be positive")
	}
	if *samplesPerSeries <= 0 {
		exitf("samples-per-series must be positive")
	}
	if err := os.MkdirAll(filepath.Dir(*output), 0o755); err != nil {
		exitf("create output directory: %v", err)
	}
	file, err := os.Create(*output)
	if err != nil {
		exitf("create fixture: %v", err)
	}
	defer file.Close()

	hasher := sha256.New()
	counter := &countingWriter{writer: io.MultiWriter(file, hasher)}
	writer := bufio.NewWriterSize(counter, 1<<20)
	if _, err := writer.WriteString(`{"status":"success","data":{"resultType":"matrix","result":[`); err != nil {
		exitf("write fixture header: %v", err)
	}

	series := 0
	for counter.bytes < *minBytes {
		if series > 0 {
			if _, err := writer.WriteString(","); err != nil {
				exitf("write series delimiter: %v", err)
			}
		}
		if err := writeSeries(writer, series, *samplesPerSeries); err != nil {
			exitf("write series %d: %v", series, err)
		}
		series++
		if err := writer.Flush(); err != nil {
			exitf("flush fixture: %v", err)
		}
	}
	if _, err := writer.WriteString(`]}}`); err != nil {
		exitf("write fixture footer: %v", err)
	}
	if err := writer.Flush(); err != nil {
		exitf("flush fixture footer: %v", err)
	}
	if err := file.Close(); err != nil {
		exitf("close fixture: %v", err)
	}

	fmt.Printf("bytes=%d series=%d samples=%d sha256=%x path=%s\n",
		counter.bytes, series, series*(*samplesPerSeries), hasher.Sum(nil), *output)
}

func writeSeries(writer *bufio.Writer, series, samples int) error {
	if _, err := fmt.Fprintf(writer, `{"metric":{"__name__":"http_request_duration_seconds","job":"api","instance":"api-%05d","region":"us-east-1","environment":"benchmark"},"values":[`, series); err != nil {
		return err
	}
	for sample := range samples {
		if sample > 0 {
			if _, err := writer.WriteString(","); err != nil {
				return err
			}
		}
		value := sampleValue(series, sample)
		if _, err := fmt.Fprintf(writer, `[%d,"%s"]`, 1_700_000_000+sample*15, value); err != nil {
			return err
		}
	}
	_, err := writer.WriteString(`]}`)
	return err
}

func sampleValue(series, sample int) string {
	switch (series*128 + sample) % 101 {
	case 0:
		return "NaN"
	case 1:
		return "+Inf"
	case 2:
		return "-Inf"
	default:
		return fmt.Sprintf("%.6f", float64((series%1_000)*128+sample)/1000)
	}
}

type countingWriter struct {
	writer io.Writer
	bytes  int64
}

func (writer *countingWriter) Write(data []byte) (int, error) {
	written, err := writer.writer.Write(data)
	writer.bytes += int64(written)
	return written, err
}

func exitf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
