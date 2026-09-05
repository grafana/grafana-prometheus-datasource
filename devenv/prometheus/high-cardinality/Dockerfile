FROM golang:1.27.1@sha256:512690a5660563b57d37ecc31129e7f136e831db2aed24a1dbeb8ad7380dc0fa AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/high-cardinality .

FROM scratch
COPY --from=builder /out/high-cardinality /high-cardinality
EXPOSE 9111
ENTRYPOINT ["/high-cardinality"]
