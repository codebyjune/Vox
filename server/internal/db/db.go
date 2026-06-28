// Package db is a minimal SQLite persistence layer used for room/participant
// history and a tiny dashboard. Live state still lives in the LiveKit SFU.
package db

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver (no CGO)
)

type Store struct {
	db *sql.DB
}

// New opens (or creates) the SQLite database and applies the schema.
func New(path string) (*Store, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1) // SQLite serial writers

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
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
	FOREIGN KEY(room_id) REFERENCES rooms(id)
);
CREATE INDEX IF NOT EXISTS idx_participants_room ON participants(room_id);
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

// RecordJoin logs a participant entering a room, returning the row id.
func (s *Store) RecordJoin(roomID, identity string) (int64, error) {
	res, err := s.db.Exec(
		`INSERT INTO participants(room_id, identity, joined_at) VALUES(?, ?, ?)`,
		roomID, identity, time.Now().Unix())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// RecordLeave marks the most recent open session for an identity as left.
func (s *Store) RecordLeave(roomID, identity string) error {
	_, err := s.db.Exec(`
UPDATE participants SET left_at = ?
WHERE room_id = ? AND identity = ? AND left_at IS NULL`,
		time.Now().Unix(), roomID, identity)
	return err
}

func (s *Store) Close() error { return s.db.Close() }
