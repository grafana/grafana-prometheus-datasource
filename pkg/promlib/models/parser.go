package models

import (
	"sync"

	"github.com/prometheus/prometheus/promql/parser"
)

// parserPool reuses parser instances across calls. parser.Parser is stateful
// and not goroutine-safe, so each goroutine borrows one, uses it, then returns it.
var parserPool = sync.Pool{
	New: func() any {
		return parser.NewParser(parser.Options{})
	},
}

// ParseExpr parses a PromQL expression using a pooled parser instance.
func ParseExpr(expr string) (parser.Expr, error) {
	p := parserPool.Get().(parser.Parser)
	defer parserPool.Put(p)
	return p.ParseExpr(expr)
}
