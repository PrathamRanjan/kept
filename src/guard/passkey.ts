/**
 * Passkey countersign (roadmap B.6, Kept). WebAuthn registration and assertion over the exact payload hash.
 * Verification here checks the authenticator data, client data challenge binding and the ES256 / RS256
 * signature with Node's crypto; attestation is not verified (acceptable for a hackathon, said so on the page).
 */
import { createHash, createPublicKey, createVerify, randomBytes } from "node:crypto";
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";
import { newId } from "../lib/ids.js";

const challenges = new Map<string, { challenge: string; ownerId: string; payloadHash: string | null; at: number }>();

export function newChallenge(ownerId: string, payloadHash: string | null): { id: string; challenge: string } {
  const id = newId("chal");
  const challenge = randomBytes(32).toString("base64url");
  challenges.set(id, { challenge, ownerId, payloadHash, at: Date.now() });
  for (const [k, v] of challenges) if (Date.now() - v.at > 5 * 60_000) challenges.delete(k);
  return { id, challenge };
}

function b64u(b: Buffer) {
  return b.toString("base64url");
}

/** COSE key (EC2 P-256 or RSA) -> PEM public key. */
export function coseToPem(cose: Buffer): string {
  // Minimal CBOR map reader for the keys WebAuthn uses.
  let i = 0;
  const read = (): any => {
    const b = cose[i++];
    const major = b >> 5;
    let info = b & 0x1f;
    let len = info;
    if (info === 24) len = cose[i++];
    else if (info === 25) (len = cose.readUInt16BE(i)), (i += 2);
    else if (info === 26) (len = cose.readUInt32BE(i)), (i += 4);
    if (major === 0) return len;
    if (major === 1) return -1 - len;
    if (major === 2) {
      const v = cose.subarray(i, i + len);
      i += len;
      return v;
    }
    if (major === 3) {
      const v = cose.subarray(i, i + len).toString();
      i += len;
      return v;
    }
    if (major === 4) return Array.from({ length: len }, read);
    if (major === 5) {
      const m = new Map<any, any>();
      for (let k = 0; k < len; k++) {
        const key = read();
        m.set(key, read());
      }
      return m;
    }
    throw new Error("Unsupported CBOR");
  };
  const m: Map<number, any> = read();
  const kty = m.get(1);
  if (kty === 2) {
    const x: Buffer = m.get(-2);
    const y: Buffer = m.get(-3);
    return createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(x), y: b64u(y) }, format: "jwk" }).export({ type: "spki", format: "pem" }).toString();
  }
  if (kty === 3) {
    const n: Buffer = m.get(-1);
    const e: Buffer = m.get(-2);
    return createPublicKey({ key: { kty: "RSA", n: b64u(n), e: b64u(e) }, format: "jwk" }).export({ type: "spki", format: "pem" }).toString();
  }
  throw new Error("Unsupported key type");
}

function parseAttestedKey(authData: Buffer): { credentialId: Buffer; cose: Buffer } {
  let i = 37; // rpIdHash(32) flags(1) counter(4)
  i += 16; // aaguid
  const len = authData.readUInt16BE(i);
  i += 2;
  const credentialId = authData.subarray(i, i + len);
  i += len;
  return { credentialId, cose: authData.subarray(i) };
}

export async function finishRegistration(ownerId: string, chalId: string, body: { clientDataJSON: string; authenticatorData: string; rawId: string }, q?: Queryable) {
  const c = challenges.get(chalId);
  if (!c || c.ownerId !== ownerId) throw new Error("Unknown or expired challenge");
  challenges.delete(chalId);
  const client = JSON.parse(Buffer.from(body.clientDataJSON, "base64url").toString());
  if (client.type !== "webauthn.create" || client.challenge !== c.challenge) throw new Error("Challenge mismatch");
  const auth = Buffer.from(body.authenticatorData, "base64url");
  const { credentialId, cose } = parseAttestedKey(auth);
  const pem = coseToPem(cose);
  const db = q ?? (await getDb());
  await db.query("INSERT INTO passkeys (id, owner_id, credential_id, public_key) VALUES ($1,$2,$3,$4)", [newId("pk"), ownerId, b64u(credentialId), pem]);
  return { credentialId: b64u(credentialId) };
}

export async function verifyAssertion(ownerId: string, chalId: string, payloadHash: string, body: { rawId: string; clientDataJSON: string; authenticatorData: string; signature: string }, q?: Queryable): Promise<boolean> {
  const c = challenges.get(chalId);
  if (!c || c.ownerId !== ownerId) return false;
  challenges.delete(chalId);
  if (c.payloadHash !== payloadHash) return false;
  const client = JSON.parse(Buffer.from(body.clientDataJSON, "base64url").toString());
  if (client.type !== "webauthn.get" || client.challenge !== c.challenge) return false;
  const db = q ?? (await getDb());
  const key = (await db.query<{ public_key: string; counter: number; id: string }>("SELECT id, public_key, counter FROM passkeys WHERE owner_id = $1 AND credential_id = $2", [ownerId, body.rawId])).rows[0];
  if (!key) return false;
  const auth = Buffer.from(body.authenticatorData, "base64url");
  const hash = createHash("sha256").update(Buffer.from(body.clientDataJSON, "base64url")).digest();
  const verifier = createVerify("sha256");
  verifier.update(Buffer.concat([auth, hash]));
  const ok = verifier.verify({ key: key.public_key, dsaEncoding: "der" }, Buffer.from(body.signature, "base64url"));
  if (ok) await db.query("UPDATE passkeys SET counter = $2 WHERE id = $1", [key.id, auth.readUInt32BE(33)]);
  return ok;
}

export async function hasPasskey(ownerId: string, q?: Queryable): Promise<boolean> {
  const db = q ?? (await getDb());
  return (await db.query("SELECT 1 FROM passkeys WHERE owner_id = $1 LIMIT 1", [ownerId])).rows.length > 0;
}

/** Browser-side helper script shared by the approval pages. */
export const PASSKEY_JS = `
const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
async function registerPasskey(startUrl, finishUrl) {
  const r = await fetch(startUrl, { method: 'POST' }).then(r => r.json());
  const cred = await navigator.credentials.create({ publicKey: { challenge: fromB64u(r.challenge), rp: { name: r.rpName }, user: { id: fromB64u(r.userId), name: r.userName, displayName: r.userName }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], authenticatorSelection: { userVerification: 'preferred' } } });
  const body = { chalId: r.id, rawId: b64u(cred.rawId), clientDataJSON: b64u(cred.response.clientDataJSON), authenticatorData: b64u(cred.response.getAuthenticatorData ? cred.response.getAuthenticatorData() : cred.response.authenticatorData) };
  return fetch(finishUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
}
async function countersign(startUrl, finishUrl, approvalId) {
  const r = await fetch(startUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId }) }).then(r => r.json());
  const cred = await navigator.credentials.get({ publicKey: { challenge: fromB64u(r.challenge), userVerification: 'preferred' } });
  const body = { chalId: r.id, approvalId, rawId: b64u(cred.rawId), clientDataJSON: b64u(cred.response.clientDataJSON), authenticatorData: b64u(cred.response.authenticatorData), signature: b64u(cred.response.signature) };
  return fetch(finishUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
}
`;
