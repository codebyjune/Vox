// Package config loads runtime settings from environment variables.
package config

import (
	"fmt"
	"os"
	"strings"
)

// Config holds all server-side configuration.
type Config struct {
	LiveKitKey    string
	LiveKitSecret string
	LiveKitHost   string // public wss:// URL clients use to reach the SFU (LiveKit Cloud or self-hosted)

	HTTPAddr    string
	CORSOrigins []string
}

// Load reads configuration from the process environment.
func Load() (*Config, error) {
	c := &Config{
		LiveKitKey:  os.Getenv("LIVEKIT_API_KEY"),
		LiveKitSecret: os.Getenv("LIVEKIT_API_SECRET"),
		LiveKitHost: os.Getenv("LIVEKIT_HOST"),
		HTTPAddr:    getenv("GO_HTTP_ADDR", ":8080"),
		CORSOrigins: parseList(getenv("CORS_ORIGINS", "*")),
	}

	switch {
	case c.LiveKitKey == "":
		return nil, fmt.Errorf("LIVEKIT_API_KEY is required")
	case c.LiveKitSecret == "":
		return nil, fmt.Errorf("LIVEKIT_API_SECRET is required")
	case c.LiveKitHost == "":
		return nil, fmt.Errorf("LIVEKIT_HOST is required")
	}
	return c, nil
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func parseList(s string) []string {
	if s == "" {
		return []string{"*"}
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
