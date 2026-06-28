// Package api exposes the HTTP surface desktop clients talk to: account
// registration/login, and LiveKit token issuance for joining a room.
//
// LiveKit (Cloud or self-hosted) handles TURN/STUN, ICE servers, and the SFU.
// The client picks up the TURN/ICE configuration implicitly from LiveKit.
package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/voiceapp/server/internal/auth"
	"github.com/voiceapp/server/internal/config"
	"github.com/voiceapp/server/internal/db"
	"github.com/voiceapp/server/internal/lkauth"
)

const (
	tokenTTL        = 4 * time.Hour
	maxFieldLen     = 64
	usernameMinLen  = 3
	usernameMaxLen  = 32
	passwordMinLen  = 6
	passwordMaxLen  = 128
)

type Server struct {
	cfg    *config.Config
	store  *db.Store
	logger *slog.Logger
}

func New(cfg *config.Config, store *db.Store, logger *slog.Logger) *Server {
	return &Server{cfg: cfg, store: store, logger: logger}
}

// publicUser is the user shape we send to clients (no password hash).
type publicUser struct {
	ID        int64  `json:"id"`
	Username  string `json:"username"`
	CreatedAt int64  `json:"createdAt"`
}

func pubUser(u *db.User) publicUser {
	return publicUser{ID: u.ID, Username: u.Username, CreatedAt: u.CreatedAt}
}

// Router builds the mux with CORS + logging middleware applied.
func (s *Server) Router() http.Handler {
	mux := http.NewServeMux()
	// Public endpoints.
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/register", s.handleRegister)
	mux.HandleFunc("/api/login", s.handleLogin)
	// Authenticated endpoints.
	mux.Handle("/api/me", s.requireAuth(http.HandlerFunc(s.handleMe)))
	mux.Handle("/api/logout", s.requireAuth(http.HandlerFunc(s.handleLogout)))
	mux.Handle("/api/join", s.requireAuth(http.HandlerFunc(s.handleJoin)))
	mux.Handle("/api/leave", s.requireAuth(http.HandlerFunc(s.handleLeave)))
	mux.Handle("/api/rooms", s.requireAuth(http.HandlerFunc(s.handleRooms)))
	return s.withCORS(s.log(mux))
}

// ---------- auth middleware ----------

// requireAuth validates the bearer session token and stores the user in the
// request context. Unauthenticated requests get 401.
func (s *Server) requireAuth(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			h.ServeHTTP(w, r) // let CORS preflight pass
			return
		}
		token := bearerToken(r)
		if token == "" {
			writeErr(w, http.StatusUnauthorized, "missing session token")
			return
		}
		sess, err := s.store.GetSession(token)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "invalid or expired session")
			return
		}
		user, err := s.store.GetUserByID(sess.UserID)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "user not found")
			return
		}
		h.ServeHTTP(w, r.WithContext(auth.WithUser(r.Context(), user)))
	})
}

func bearerToken(r *http.Request) string {
	v := r.Header.Get("Authorization")
	if v == "" {
		return ""
	}
	parts := strings.SplitN(v, " ", 2)
	if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
		return strings.TrimSpace(parts[1])
	}
	return ""
}

// ---------- public: health / register / login ----------

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ts": time.Now().Unix()})
}

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type authResponse struct {
	Token string     `json:"token"`
	User  publicUser `json:"user"`
}

// handleRegister creates a user and immediately starts a session.
func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var c credentials
	if err := decodeJSON(r, &c); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	username, perr := validateUsername(c.Username)
	if perr != nil {
		writeErr(w, http.StatusBadRequest, perr.Error())
		return
	}
	if perr := validatePassword(c.Password); perr != nil {
		writeErr(w, http.StatusBadRequest, perr.Error())
		return
	}

	hash, err := auth.HashPassword(c.Password)
	if err != nil {
		s.logger.Error("hash password", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	user, err := s.store.CreateUser(username, hash)
	if err != nil {
		if errors.Is(err, db.ErrDuplicateUsername) {
			writeErr(w, http.StatusConflict, "username already taken")
			return
		}
		s.logger.Error("create user", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	s.issueSession(w, r, user)
}

// handleLogin verifies credentials and starts a session.
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var c credentials
	if err := decodeJSON(r, &c); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	// Look up by the normalized username so case/spacing can't bypass it.
	username, _ := validateUsername(c.Username)
	user, err := s.store.GetUserByUsername(username)
	if err != nil || user == nil {
		writeErr(w, http.StatusUnauthorized, "invalid username or password")
		return
	}
	if !auth.CheckPassword(user.PasswordHash, c.Password) {
		writeErr(w, http.StatusUnauthorized, "invalid username or password")
		return
	}
	s.issueSession(w, r, user)
}

// issueSession mints a 30-day session token and writes the auth response.
func (s *Server) issueSession(w http.ResponseWriter, _ *http.Request, user *db.User) {
	token, err := auth.NewToken()
	if err != nil {
		s.logger.Error("gen session token", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	expires := time.Now().Add(auth.SessionTTL).Unix()
	if err := s.store.CreateSession(token, user.ID, expires); err != nil {
		s.logger.Error("create session", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, authResponse{Token: token, User: pubUser(user)})
}

// ---------- authenticated: me / logout ----------

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	user := auth.FromContext(r.Context())
	writeJSON(w, http.StatusOK, pubUser(user))
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	token := bearerToken(r)
	if token != "" {
		if err := s.store.DeleteSession(token); err != nil {
			s.logger.Warn("delete session", "err", err)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------- authenticated: join / leave / rooms ----------

type joinRequest struct {
	Room string `json:"room"`
}

type joinResponse struct {
	Token       string `json:"token"`
	LiveKitHost string `json:"livekitHost"`
	Room        string `json:"room"`
	Identity    string `json:"identity"`
	Name        string `json:"name"`
}

// handleJoin issues a LiveKit token for the authenticated user. The identity
// is taken from the session, never the request body (no impersonation).
func (s *Server) handleJoin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var req joinRequest
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	room := sanitize(req.Room)
	if room == "" {
		writeErr(w, http.StatusBadRequest, "room is required")
		return
	}
	user := auth.FromContext(r.Context())
	identity := user.Username

	tok, err := lkauth.Issue(s.cfg.LiveKitKey, s.cfg.LiveKitSecret, lkauth.TokenParams{
		Identity: identity,
		Room:     room,
		Name:     identity,
		TTL:      tokenTTL,
	})
	if err != nil {
		s.logger.Error("issue token", "err", err)
		writeErr(w, http.StatusInternalServerError, "token error")
		return
	}

	if err := s.store.TouchRoom(room, room); err != nil {
		s.logger.Warn("touch room", "err", err)
	}
	if err := s.store.RecordJoin(room, identity); err != nil {
		s.logger.Warn("record join", "err", err)
	}

	writeJSON(w, http.StatusOK, joinResponse{
		Token:       tok,
		LiveKitHost: s.cfg.LiveKitHost,
		Room:        room,
		Identity:    identity,
		Name:        identity,
	})
}

type leaveRequest struct {
	Room string `json:"room"`
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
	user := auth.FromContext(r.Context())
	if err := s.store.RecordLeave(room, user.Username); err != nil {
		s.logger.Warn("record leave", "err", err)
	}
	s.logger.Info("leave", "room", room, "identity", user.Username)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleRooms returns the most recently active rooms (small dashboard).
func (s *Server) handleRooms(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
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
		writeErr(w, http.StatusInternalServerError, "list failed")
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// ---------- helpers ----------

func validateUsername(raw string) (string, error) {
	u := sanitize(raw)
	n := len(u)
	if n < usernameMinLen {
		return "", fmt.Errorf("username must be at least %d characters", usernameMinLen)
	}
	if n > usernameMaxLen {
		u = u[:usernameMaxLen]
	}
	return u, nil
}

func validatePassword(pw string) error {
	if len(pw) < passwordMinLen {
		return fmt.Errorf("password must be at least %d characters", passwordMinLen)
	}
	if len(pw) > passwordMaxLen {
		return fmt.Errorf("password too long (max %d)", passwordMaxLen)
	}
	return nil
}

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
