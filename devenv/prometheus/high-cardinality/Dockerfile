FROM golang:1.27.3@sha256:e519d3b0a5b285e5aa53ab9eef02bc6bbb9cb04608389b743a136a9ce75f0d1e AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/high-cardinality .

FROM scratch
COPY --from=builder /out/high-cardinality /high-cardinality
EXPOSE 9111
ENTRYPOINT ["/high-cardinality"]
