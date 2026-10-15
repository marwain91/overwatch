import { AdminRole } from '../services/users';

export interface RegisteredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created_at: string;
  last_used_at?: string;        // refreshed (at most daily) on authorize/token use; drives pruning
}

// Stored only long enough to exchange for a token (~60s, in memory).
export interface AuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;       // S256
  email: string;
  role: AdminRole;
  resource?: string;
  expires_at: number;           // epoch ms
}

// Persisted (hashed) refresh token record. A family is one grant: every
// rotation carries family_id/granted_at forward. Records written before
// families existed lack them and are migrated on their next rotation.
export interface RefreshTokenRecord {
  token_hash: string;           // sha256 of the opaque token
  client_id: string;
  email: string;
  expires_at: number;           // epoch ms
  family_id?: string;
  granted_at?: number;          // epoch ms of the code exchange that started the family
  rotated?: { token_hash: string; at: number }[]; // latest tokens rotated out of this family (reuse detection)
}
