// VoiceApp backend: serves join tokens, TURN credentials, and a room listing.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/voiceapp/server/internal/api"
	"github.com/voiceapp/server/internal/config"
	"github.com/voiceapp/server/internal/db"
)

// Placeholder values that the .env.example ships with. The preflight refuses to
// start the server if either is still set, so deployments cannot accidentally
// ship the defaults into production.
var placeholderSecrets = map[string]string{
	"LIVEKIT_API_KEY":    "APIvoiceapp123",
	"LIVEKIT_API_SECRET": "super-secret-change-me-please-32bytes!!",
	"TURN_STATIC_SECRET": "turn-shared-static-secret-change-me",
}

func preflight() error {
	var problems []string
	for env, placeholder := range placeholderSecrets {
		if os.Getenv(env) == placeholder {
			problems = append(problems, env)
		}
	}
	if len(problems) > 0 {
		return errors.New(
			"refusing to start with placeholder secrets: " +
				strings.Join(problems, ", ") +
				" — see .env.example and replace them with strong random values")
	}
	return nil
}

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	if err := preflight(); err != nil {
		logger.Error("preflight", "err", err)
		os.Exit(1)
	}

	cfg, err := config.Load()
	if err != nil {
		logger.Error("config", "err", err)
		os.Exit(1)
	}

	store, err := db.New(cfg.DBPath)
	if err != nil {
		logger.Error("db", "err", err)
		os.Exit(1)
	}
	defer store.Close()

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           api.New(cfg, store, logger).Router(),
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
