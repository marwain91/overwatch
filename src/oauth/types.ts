import { AdminRole } from '../services/users';

export interface RegisteredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created_at: string;
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

// Persisted (hashed) refresh token record.
export interface RefreshTokenRecord {
  token_hash: string;           // sha256 of the opaque token
  client_id: string;
  email: string;
  expires_at: number;           // epoch ms
}
