FROM golang:1.26.10@sha256:672c944cfd07599b5f1bb179869270cdc94c6254e41db4d431259693cb286b82 AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/utf8 .

FROM scratch
COPY --from=builder /out/utf8 /utf8
EXPOSE 9112
ENTRYPOINT ["/utf8"]
