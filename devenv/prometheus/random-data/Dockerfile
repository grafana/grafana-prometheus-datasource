FROM golang:1.27.1@sha256:e0174e51e81218523251d85d248a90d24c3d5e81543b4f07a5d66229397db190 AS builder

RUN CGO_ENABLED=0 GOOS=linux go install -tags netgo -ldflags '-w' github.com/prometheus/client_golang/examples/random@v1.12.2

FROM scratch
COPY --from=builder /go/bin/random /random
EXPOSE 8080
ENTRYPOINT ["/random"]
