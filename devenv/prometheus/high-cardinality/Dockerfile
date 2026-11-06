FROM golang:1.26.10@sha256:cfa27959837144bf4649802ba38e59daffd0dd2a7994aa83daaf113285b0f551 AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/high-cardinality .

FROM scratch
COPY --from=builder /out/high-cardinality /high-cardinality
EXPOSE 9111
ENTRYPOINT ["/high-cardinality"]
