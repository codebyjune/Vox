// Package api exposes the HTTP surface desktop clients talk to.
//
// The Go service now does one thing: sign LiveKit access tokens. LiveKit
// Cloud (or a self-hosted LiveKit server you point LIVEKIT_HOST at) handles
// TURN/STUN, ICE servers, and the SFU. The client picks up the TURN/ICE
// configuration implicitly from the LiveKit server on connect.
package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/voiceapp/server/internal/config"
	"github.com/voiceapp/server/internal/db"
	"github.com/voiceapp/server/internal/lkauth"
)

const (
	tokenTTL    = 4 * time.Hour
	maxFieldLen = 64
)

type Server struct {
	cfg    *config.Config
	store  *db.Store
	logger *slog.Logger
}

func New(cfg *config.Config, store *db.Store, logger *slog.Logger) *Server {
	return &Server{cfg: cfg, store: store, logger: logger}
}

// Router builds the mux with CORS + JSON logging middleware applied.
func (s *Server) Router() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/join", s.handleJoin)
	mux.HandleFunc("/api/leave", s.handleLeave)
	mux.HandleFunc("/api/rooms", s.handleRooms)
	return s.withCORS(s.log(mux))
}

// ---------- handlers ----------

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ts": time.Now().Unix()})
}

type joinRequest struct {
	Room     string `json:"room"`
	Identity string `json:"identity"`
	Name     string `json:"name"`
}

type joinResponse struct {
	Token       string `json:"token"`
	LiveKitHost string `json:"livekitHost"`
	Room        string `json:"room"`
	Identity    string `json:"identity"`
	Name        string `json:"name"`
}

func (s *Server) handleJoin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	// Cap request body so a buggy / hostile client can't OOM us.
	r.Body = http.MaxBytesReader(w, r.Body, 1<<16) // 64 KiB
	var req joinRequest
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}

	identity := sanitize(req.Identity)
	room := sanitize(req.Room)
	if identity == "" {
		writeErr(w, http.StatusBadRequest, "identity is required")
		return
	}
	if room == "" {
		writeErr(w, http.StatusBadRequest, "room is required")
		return
	}
	name := trimLen(req.Name, maxFieldLen)

	tok, err := lkauth.Issue(s.cfg.LiveKitKey, s.cfg.LiveKitSecret, lkauth.TokenParams{
		Identity: identity,
		Room:     room,
		Name:     name,
		TTL:      tokenTTL,
	})
	if err != nil {
		s.logger.Error("issue token", "err", err)
		writeErr(w, http.StatusInternalServerError, "token error")
		return
	}

	// Persist (best-effort; DB outages must not block joining a call).
	if s.store != nil {
		if err := s.store.TouchRoom(room, room); err != nil {
			s.logger.Warn("touch room", "err", err)
		}
		if err := s.store.RecordJoin(room, identity); err != nil {
			s.logger.Warn("record join", "err", err)
		}
	}

	writeJSON(w, http.StatusOK, joinResponse{
		Token:       tok,
		LiveKitHost: s.cfg.LiveKitHost,
		Room:        room,
		Identity:    identity,
		Name:        name,
	})
}

// leave is a fire-and-forget endpoint used for history and observability.
type leaveRequest struct {
	Room     string `json:"room"`
	Identity string `json:"identity"`
}

func (s *Server) handleLeave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var req leaveRequest
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	room := sanitize(req.Room)
	identity := sanitize(req.Identity)
	if room == "" || identity == "" {
		writeErr(w, http.StatusBadRequest, "room and identity are required")
		return
	}
	if s.store != nil {
		if err := s.store.RecordLeave(room, identity); err != nil {
			s.logger.Warn("record leave", "err", err)
		}
	}
	s.logger.Info("leave", "room", room, "identity", identity)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleRooms returns the most recently active rooms (for a small dashboard).
func (s *Server) handleRooms(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.store == nil {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	limit := 100
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := atoi(l); err == nil {
			limit = n
		}
	}
	rows, err := s.store.ListRooms(limit)
	if err != nil {
		s.logger.Warn("list rooms", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "list failed"})
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// ---------- helpers ----------

func (s *Server) log(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		h.ServeHTTP(w, r)
		s.logger.Info("http", "method", r.Method, "path", r.URL.Path,
			"remote", r.RemoteAddr, "dur_ms", time.Since(start).Milliseconds())
	})
}

func (s *Server) withCORS(h http.Handler) http.Handler {
	allowAll := len(s.cfg.CORSOrigins) == 0 || (len(s.cfg.CORSOrigins) == 1 && s.cfg.CORSOrigins[0] == "*")
	allowed := make(map[string]bool, len(s.cfg.CORSOrigins))
	for _, o := range s.cfg.CORSOrigins {
		allowed[o] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if allowAll || allowed[origin] {
			w.Header().Set("Access-Control-Allow-Origin", originOrStar(origin))
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func originOrStar(o string) string {
	if o == "" {
		return "*"
	}
	return o
}

func decodeJSON(r *http.Request, dst any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(dst)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}

func sanitize(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-' || r == '_':
			b.WriteRune(r)
		case r == ' ':
			b.WriteRune('-')
		}
		if b.Len() >= maxFieldLen {
			break
		}
	}
	return b.String()
}

func trimLen(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		s = s[:n]
	}
	return s
}

func atoi(s string) (int, error) {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, fmt.Errorf("not a number: %q", s)
		}
		n = n*10 + int(r-'0')
		if n > 1<<20 {
			return 0, fmt.Errorf("number too large: %q", s)
		}
	}
	return n, nil
}
