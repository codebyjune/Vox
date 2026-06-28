// Package turn issues short-lived coturn credentials via the REST API shared
// secret scheme (use-auth-secret). The Go service hands these to each client,
// which passes them straight into LiveKit's rtcConfig.iceServers.
package turn

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"time"
)

// ICEServer is the subset of a WebRTC RTCIceServer the client needs.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

// ICEConfig is the host/port/realm of the coturn deployment.
type ICEConfig struct {
	Domain string
	Port   int // listening port (3478)
}

// Mint builds STUN + TURN ICE servers with time-limited credentials valid
// for `ttl`. The username encodes expiry so coturn rejects expired creds.
func Mint(cfg ICEConfig, sharedSecret, userID string, ttl time.Duration) ([]ICEServer, error) {
	if sharedSecret == "" {
		return nil, fmt.Errorf("turn: empty shared secret")
	}
	if cfg.Domain == "" {
		return nil, fmt.Errorf("turn: empty domain")
	}

	expiry := time.Now().Add(ttl).Unix()
	username := fmt.Sprintf("%d:%s", expiry, userID)

	mac := hmac.New(sha1.New, []byte(sharedSecret))
	mac.Write([]byte(username))
	credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	turnHost := fmt.Sprintf("%s:%d", cfg.Domain, cfg.Port)
	return []ICEServer{
		{URLs: []string{"stun:" + turnHost}},
		{URLs: []string{
			"turn:" + turnHost + "?transport=udp",
			"turn:" + turnHost + "?transport=tcp",
			"turns:" + turnHost + "?transport=tcp",
		}, Username: username, Credential: credential},
	}, nil
}
