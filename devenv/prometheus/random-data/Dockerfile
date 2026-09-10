FROM golang:1.27.0@sha256:4013ae0f9e7994f8535c58c811f8f863fbed38b72e0d51e6592156f758d66146 AS builder

RUN CGO_ENABLED=0 GOOS=linux go install -tags netgo -ldflags '-w' github.com/prometheus/client_golang/examples/random@v1.12.2

FROM scratch
COPY --from=builder /go/bin/random /random
EXPOSE 8080
ENTRYPOINT ["/random"]
