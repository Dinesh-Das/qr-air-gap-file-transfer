# Pairing while preparing a source

## Objective and authorization

Implement the existing release requirements: pair within seconds, avoid repeating
expensive hashing after connection failure, and require both devices to confirm
the exact WebRTC transcript before any manifest or file bytes are sent. This is
part of the user's authorized release-hardening goal. It does not establish
physical timing acceptance or change the integrity format.

## Behavior

- Check browser/service readiness and create the room before reading source bytes.
- Publish the code and start bounded source hashing independently of signaling.
- Allow connection and human verification while hashing is pending.
- Send the manifest only when preparation and both current-session confirmations
  are complete. Whichever finishes last triggers the same authorization gate.
- Before both confirmations, keep source-specific error details local and send
  only a generic failure to the peer. Test neither/sender-only/receiver-only
  confirmation with a natural changed-source error containing a private filename.
- A connection failure, expired room, or Stop and reconnect retains the pending
  preparation and immutable prepared snapshots. Retry uses them without another
  source selection or hash pass and requires fresh human confirmations.
- New transfer and component disposal cancel preparation. Late progress,
  completion, failure, or persistence from a discarded source cannot affect a new
  transfer. A source preparation failure closes the current connection safely.
- Display preparation progress alongside pairing/verification. After both consent,
  clearly show that file checking continues; the receiver waits for the manifest.
- Reload recovery still validates every persisted file before trusting it. This
  change does not bypass that integrity boundary.

## Implementation plan

Keep source-preparation cancellation and identity separate from the existing
connection generation. Reuse one preparation promise for the selected source.
Keep the existing PeerAuthorization and maybeAuthorize gate as the only place
that starts the protocol. Source selection/reset cancels the source generation;
connection teardown cancels only signaling/data work. Preserve existing errors,
manifest identity, saving, resume receipts, and block accounting.

## Structure and style

React/TypeScript source is in src/components/WebRtcSender.tsx; browser tests are
in e2e/pairing-preparation.spec.ts. Follow existing callbacks, refs, AbortController
and stale-generation checks, for example:

```ts
if (generation !== sourceLifecycleRef.current) return;
sourceRef.current = source;
manifestRef.current = manifest;
maybeAuthorize();
```

## Validation and commands

1. Deterministically hold a real source slice read. Before releasing it, observe a
   pairing code and matching device verification on real WebRTC peers.
2. Test both orders of prerequisites: confirmations first/hash last and hash
   first/one confirmation missing. Neither permits early manifest or payload.
3. Fail/retry a connection while hashing is pending; verify one preparation read,
   fresh confirmation, completed transfer, and independently hashed destination.
4. Discard/unmount pending preparation, release its read, and prove no stale
   manifest, success, source persistence or error leaks into the next transfer.
5. Fail source reading while connected; prove no manifest/data/success, visible
   failure and safe retry. Existing durable recovery and authorization tests stay.

Run the failing reproduction before changing product code:
`npm run test:browser -- e2e/pairing-preparation.spec.ts`.
Then run `npm run check`, the focused browser tests, and `npm run check:release`.
Retain commands, exit codes, raw logs/traces and input hashes. Local browser timing
with synthetic handles does not prove native/two-laptop pairing latency.

## Boundaries

Always preserve bounded reads, source integrity, both-device authorization and
fresh session identity. Do not add dependencies, suppress tests or reduce release
requirements. No deployment, commit or external messages are part of this fix.
Release remains NOT READY until the original full acceptance scope is proven.
