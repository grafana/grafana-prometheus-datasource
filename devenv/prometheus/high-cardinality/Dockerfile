FROM golang:1.27.1@sha256:f44f6e88636cfb311f9ebace870ded69d943f227bb3cb27d32ffd84ea18c43ea AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/high-cardinality .

FROM scratch
COPY --from=builder /out/high-cardinality /high-cardinality
EXPOSE 9111
ENTRYPOINT ["/high-cardinality"]
