FROM golang:1.26.10@sha256:670bb5aa5349ae03b8516764718486f4f16399134bdc9acd0c46a23f043ab05c AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/utf8 .

FROM scratch
COPY --from=builder /out/utf8 /utf8
EXPOSE 9112
ENTRYPOINT ["/utf8"]
