// VoiceApp backend: signs LiveKit access tokens.
//
// This is a stateless process. LiveKit (Cloud or self-hosted) handles TURN,
// SFU, and persistence. Run locally:
//
//	go run ./cmd/voiceapp
//
// or build + run a single binary:
//
//	go build -o voiceapp ./cmd/voiceapp && ./voiceapp
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/voiceapp/server/internal/api"
	"github.com/voiceapp/server/internal/config"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	cfg, err := config.Load()
	if err != nil {
		logger.Error("config", "err", err)
		os.Exit(1)
	}

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           api.New(cfg, logger).Router(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		logger.Info("shutting down")
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	logger.Info("voiceapp backend listening", "addr", cfg.HTTPAddr,
		"livekit", cfg.LiveKitHost)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("server", "err", err)
		os.Exit(1)
	}
	logger.Info("bye")
}
