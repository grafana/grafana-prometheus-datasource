FROM golang:1.27.1@sha256:f44f6e88636cfb311f9ebace870ded69d943f227bb3cb27d32ffd84ea18c43ea AS builder

RUN CGO_ENABLED=0 GOOS=linux go install -tags netgo -ldflags '-w' github.com/prometheus/client_golang/examples/random@v1.12.2

FROM scratch
COPY --from=builder /go/bin/random /random
EXPOSE 8080
ENTRYPOINT ["/random"]
