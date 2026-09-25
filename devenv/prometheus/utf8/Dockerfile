FROM golang:1.27.1@sha256:3680233e3204827fbdc66088528ae6d4b3d034f51d03a99d454f6de034888244 AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/utf8 .

FROM scratch
COPY --from=builder /out/utf8 /utf8
EXPOSE 9112
ENTRYPOINT ["/utf8"]
