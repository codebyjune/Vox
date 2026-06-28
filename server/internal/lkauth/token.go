// Package lkauth mints LiveKit access tokens (JWT) for desktop clients.
package lkauth

import (
	"fmt"
	"time"

	"github.com/livekit/protocol/auth"
)

// TokenParams describes the access a joining participant should receive.
type TokenParams struct {
	Identity string
	Room     string
	Name     string // optional display name
	TTL      time.Duration
}

// Issue returns a signed LiveKit JWT granting room join. The minimal grant
// (RoomJoin + Room) grants default media permissions; the room participant
// ceiling is enforced by livekit.yaml (room.max_participants).
func Issue(apiKey, apiSecret string, p TokenParams) (string, error) {
	if p.TTL == 0 {
		p.TTL = 4 * time.Hour
	}

	at := auth.NewAccessToken(apiKey, apiSecret)
	at.AddGrant(&auth.VideoGrant{
		RoomJoin: true,
		Room:     p.Room,
	})
	at.SetIdentity(p.Identity).SetValidFor(p.TTL)

	if p.Name != "" {
		at.SetName(p.Name)
	}

	tok, err := at.ToJWT()
	if err != nil {
		return "", fmt.Errorf("sign token: %w", err)
	}
	return tok, nil
}
