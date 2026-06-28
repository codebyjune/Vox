// Package db is a minimal SQLite persistence layer for room and participant
// history. Pure-Go driver (`modernc.org/sqlite`), no CGO, single-file
// database. Used for debugging, light audit, and a small dashboard; LiveKit
// itself remains the source of truth for live room state.
package db

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

// New opens (or creates) the SQLite database and applies the schema.
func New(path string) (*Store, error) {
	dsn := fmt.Sprintf(
		"file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)",
		path,
	)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// SQLite serializes writers; with WAL, multiple readers + 1 writer is fine.
	db.SetMaxOpenConns(4)

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) migrate() error {
	const schema = `
CREATE TABLE IF NOT EXISTS rooms (
	id           TEXT PRIMARY KEY,
	name         TEXT NOT NULL,
	created_at   INTEGER NOT NULL,
	last_active_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS participants (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	room_id    TEXT NOT NULL,
	identity   TEXT NOT NULL,
	joined_at  INTEGER NOT NULL,
	left_at    INTEGER,
	FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_participants_room ON participants(room_id);
CREATE INDEX IF NOT EXISTS idx_participants_identity ON participants(identity);
`
	_, err := s.db.Exec(schema)
	return err
}

// TouchRoom inserts the room if new, refreshing last_active_at otherwise.
func (s *Store) TouchRoom(roomID, name string) error {
	now := time.Now().Unix()
	_, err := s.db.Exec(`
INSERT INTO rooms(id, name, created_at, last_active_at) VALUES(?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET last_active_at = excluded.last_active_at`,
		roomID, name, now, now)
	return err
}

// RecordJoin logs a participant entering a room.
func (s *Store) RecordJoin(roomID, identity string) error {
	_, err := s.db.Exec(
		`INSERT INTO participants(room_id, identity, joined_at) VALUES(?, ?, ?)`,
		roomID, identity, time.Now().Unix(),
	)
	return err
}

// RecordLeave marks the most recent open session for an identity as left.
func (s *Store) RecordLeave(roomID, identity string) error {
	_, err := s.db.Exec(`
UPDATE participants SET left_at = ?
WHERE id = (
  SELECT id FROM participants
  WHERE room_id = ? AND identity = ? AND left_at IS NULL
  ORDER BY joined_at DESC
  LIMIT 1
)`,
		time.Now().Unix(), roomID, identity,
	)
	return err
}

// RoomSummary is a single row for /api/rooms listing.
type RoomSummary struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	CreatedAt     int64  `json:"createdAt"`
	LastActiveAt  int64  `json:"lastActiveAt"`
	Joins         int64  `json:"joins"`
}

// ListRooms returns up to `limit` rooms ordered by most recent activity.
func (s *Store) ListRooms(limit int) ([]RoomSummary, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.Query(`
SELECT r.id, r.name, r.created_at, r.last_active_at,
       COUNT(p.id) AS joins
FROM rooms r
LEFT JOIN participants p ON p.room_id = r.id
GROUP BY r.id
ORDER BY r.last_active_at DESC
LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]RoomSummary, 0, limit)
	for rows.Next() {
		var r RoomSummary
		if err := rows.Scan(&r.ID, &r.Name, &r.CreatedAt, &r.LastActiveAt, &r.Joins); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) Close() error { return s.db.Close() }
