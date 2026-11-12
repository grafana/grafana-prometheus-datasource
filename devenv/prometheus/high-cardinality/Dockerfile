FROM golang:1.27.4@sha256:5e8afd493a7124a8586e134d9b532731161d4b9becf9dee5a5956b107426f93d AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/high-cardinality .

FROM scratch
COPY --from=builder /out/high-cardinality /high-cardinality
EXPOSE 9111
ENTRYPOINT ["/high-cardinality"]
