FROM golang:1.26.10@sha256:cfa27959837144bf4649802ba38e59daffd0dd2a7994aa83daaf113285b0f551 AS builder

RUN CGO_ENABLED=0 GOOS=linux go install -tags netgo -ldflags '-w' github.com/prometheus/client_golang/examples/random@v1.12.2

FROM scratch
COPY --from=builder /go/bin/random /random
EXPOSE 8080
ENTRYPOINT ["/random"]
