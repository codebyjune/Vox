# syntax=docker/dockerfile:1
FROM golang:1.23-alpine AS build
WORKDIR /src

# Cache module layer. We allow the build to resolve/record go.sum when missing.
ENV GOFLAGS=-mod=mod GO111MODULE=on CGO_ENABLED=0
COPY go.mod ./
# Copy source
COPY . .
RUN go mod tidy && go build -trimpath -ldflags="-s -w" -o /out/voiceapp ./cmd/voiceapp

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata && \
    adduser -D -u 1000 voiceapp && \
    mkdir -p /var/lib/voiceapp && chown -R voiceapp /var/lib/voiceapp
WORKDIR /app
COPY --from=build /out/voiceapp /app/voiceapp
USER voiceapp
EXPOSE 8080
ENTRYPOINT ["/app/voiceapp"]
