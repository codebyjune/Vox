// Package config loads runtime settings from environment variables.
package config

import (
	"fmt"
	"os"
	"strings"
)

// Config holds all server-side configuration.
type Config struct {
	LiveKitKey         string
	LiveKitSecret      string
	LiveKitHost        string // public wss:// URL clients use to reach the SFU
	LiveKitInternalHost string // internal ws:// URL the server-sdk uses inside the docker net

	TurnDomain       string
	TurnStaticSecret string
	TurnListenPort   int

	HTTPAddr     string
	DBPath       string
	CORSOrigins []string
}

// Load reads configuration from the process environment.
func Load() (*Config, error) {
	c := &Config{
		LiveKitKey:          os.Getenv("LIVEKIT_API_KEY"),
		LiveKitSecret:       os.Getenv("LIVEKIT_API_SECRET"),
		LiveKitHost:         os.Getenv("LIVEKIT_HOST"),
		LiveKitInternalHost: getenv("LIVEKIT_INTERNAL_HOST", "ws://livekit:7880"),
		TurnDomain:          os.Getenv("TURN_DOMAIN"),
		TurnStaticSecret: os.Getenv("TURN_STATIC_SECRET"),
		HTTPAddr:         getenv("GO_HTTP_ADDR", ":8080"),
		DBPath:           getenv("DB_PATH", "/var/lib/voiceapp/app.db"),
		CORSOrigins:      parseList(getenv("CORS_ORIGINS", "*")),
	}

	switch {
	case c.LiveKitKey == "":
		return nil, fmt.Errorf("LIVEKIT_API_KEY is required")
	case c.LiveKitSecret == "":
		return nil, fmt.Errorf("LIVEKIT_API_SECRET is required")
	case c.LiveKitHost == "":
		return nil, fmt.Errorf("LIVEKIT_HOST is required")
	case c.TurnStaticSecret == "":
		return nil, fmt.Errorf("TURN_STATIC_SECRET is required")
	}

	c.TurnListenPort = atoiDefault(os.Getenv("TURN_LISTEN_PORT"), 3478)
	return c, nil
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	var n int
	if _, err := fmt.Sscanf(s, "%d", &n); err != nil {
		return def
	}
	return n
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
