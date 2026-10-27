# Attestations for assisted transfers: proposed schema

Proposal, 2026-10-23. Nothing in this file is built yet. Open questions are
marked **Q**; the chat that produced this file lists them in full.

## Where it fits

An assisted account spends with an `assistedAnosTransfer` (**Q**: name), the
same object as every other transfer, signed by key1, postQuantumKey1,
walletKey and walletPostQuantumKey. The validators run the normal transfer
checks plus "the sender is an assisted account", coordinate it exactly as
they do a pending or locked transfer (approval receipts, proof of
acceptance), and hold it in `assisted_transfers` instead of `pending`.

It stays there until two attestations have been added to its row: one from
the attestor who met the sender and checked their credentials (the
*witness*, slot 1) and one from an attestor who vouches for the witness (the
*endorser*, slot 2). From then on it is a ready transaction like an approved
pending row: the next leader round lists it, orders it and writes it with
the rest. Everything else proceeds as normal.

## 1. The attestation: attestor to validator

`POST /attestation`, body `{ payload, signatures }`. The payload is signed
as its RFC 8785 canonical bytes, exactly like an account payload or a
validator message.

```
payload: {
  type:          "attestation"
  transactionId: the assisted transfer's id, hex. It is the SHA-256 of the
                 transfer's payload, so it binds the sender, the receiver, the
                 amount and the date; nothing else of the transfer is repeated
  accountId:     the sender's account id, hex. Must match the row's account_id
  attestorId:    the attestor's id, hex: the account id of the attestor's own
                 account, which the stake table lists (section 4)
  role:          "witness" (met the sender, checked their credentials; slot 1)
                 or "endorser" (trusts the witness; slot 2)
  endorses:      the witness's attestorId, hex. Endorser attestations only
  attestedAt:    ISO 8601 timestamp
}
signatures: {
  key1:            P-256 signature by the attestor's key1, 64 bytes r||s, hex
  postQuantumKey1: ML-DSA-87 signature by the attestor's postQuantumKey1, 4627 bytes, hex
}
```

Same formats as everywhere else: lowercase hex, base64 also accepted, the
byte length tells them apart.

Why a payload of its own rather than a bare signature over the transfer's
bytes: the attestation then says who signed, in which role, for which
transaction and when, and anyone holding it can verify it on its own, on the
chain included. The transactionId ties it to the transfer as tightly as
signing the transfer's bytes would.

**Q** Attestors as accounts (attestorId = accountId, signing with pair 1) is
the assumption behind `key1` / `postQuantumKey1`. With a registry of their
own, as the validators have, the fields would be `key` / `postQuantumKey`
and the id a hash of the two public keys, as an accountId is.

**Q** Two signatures (classical + post-quantum, a "key pair" as the accounts
have them), or P-256 only, as the validators sign?

## 2. What the validator checks, and answers

In order:

1. The shape: type, the strings, `role` one of the two, `endorses` present
   exactly when the role is endorser; the three ids decode as digests.
2. The attestor: a row in `stake` with this account id, `active`, type
   attestor; its key1 and postQuantumKey1 read from `accounts`.
3. Both signatures verify over the canonical payload against those keys.
4. The transfer: an `assisted_transfers` row with this transactionId whose
   account_id is `accountId`. (**Q** Approved by every validator already, or
   is the row's existence enough?)
5. The slot. Witness: slot 1 empty. Endorser: slot 1 filled, slot 2 empty,
   `endorses` is slot 1's attestorId, and this attestor is not slot 1's.
6. Store the whole attestation, `{ payload, signatures }` as received, in
   the slot (`UPDATE ... WHERE attestor_signature_N IS NULL`, the backstop
   for two arriving at once).
7. Relay it to every other active validator (section 3) and log each answer,
   as the transfer handlers log each validator's approval.

The answer: `202` + `{ transactionId }` once stored here, `400` + `{ error }`
with the reason otherwise, like `/create-account` and `/anos-transfer`. A
signed receipt for the attestor can come with step 9 (the final reply to the
web app), which is not designed yet either.

## 3. The relay: validator to validator

The attestor talks to one validator, but every validator keeps its own
`assisted_transfers`, and a leader round only writes what every validator
lists as ready. So the validator that receives an attestation passes it on.
One phase is enough, unlike a transaction's approval and proof: an
attestation is self-certifying, each validator checks it against its own
stake table and its own row, and the leader round's intersection is the
agreement.

`POST /attestation-relay`:

```
payload: {
  attestation:          the attestation exactly as received ({ payload, signatures })
  type:                 "attestationRelay"
  originatingValidator: the id of the validator the attestor sent it to
  transactionId:        the transfer's id, as the attestation names it
  sentAt:               ISO 8601 timestamp
}
signature: { key }
```

The receiver checks the shape; that originatingValidator is an active
validator whose key verifies the signature; then runs checks 1 to 6 above on
the embedded attestation against its own database. It answers `200` with a
stored receipt, the transaction approved receipt's shape with its own type,
checked by the originating validator the same way (signature, from, to,
transaction):

```
payload: {
  transactionId: the transfer's id
  type:          "attestationStored"
  validatorFrom: the id of the validator that was called
  validatorTo:   the id of the originating validator
  sentAt:        ISO 8601 timestamp
}
signature: { key }
```

**Q** Relay as above, or does the attestor's tool send the attestation to all
five validators itself?

## 4. Tables

### stake

Does not exist yet. This proposal makes an attestor an account with a row
here, so the attestor's keys are the account's keys and nothing new is
registered. `amount` is a placeholder for staking, 0 until that exists.
`type` follows `accounts.type` and `garlic_chain.type`.

```sql
CREATE TABLE IF NOT EXISTS stake (
  account_id  BYTEA   PRIMARY KEY CHECK (octet_length(account_id) = 32),
  type        TEXT    NOT NULL,                              -- 'attestor'
  amount      BIGINT  NOT NULL DEFAULT 0 CHECK (amount >= 0),
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Seeded locally from a `db/stake.sql` that `scripts/setup-db.sh` applies after
`db/validators.sql`, with the account ids of two or three test accounts
created through the web app. Same rows in every validator's database, like
the validator registry.

**Q** Is this what you mean by the stake table, and how should rows get into
it for now?

### assisted_transfers

Pending's third twin, after `locked_transactions`: one row per assisted
transfer waiting for its attestations, one per account at a time, the same
`approved` flag, plus the two slots.

```sql
CREATE TABLE IF NOT EXISTS assisted_transfers (
  transaction_id        BYTEA   PRIMARY KEY CHECK (octet_length(transaction_id) = 32),
  account_id            BYTEA   NOT NULL UNIQUE CHECK (octet_length(account_id) = 32),
  og_transaction        JSONB   NOT NULL,
  approved              BOOLEAN NOT NULL DEFAULT false,
  attestor_signature_1  JSONB,   -- the witness's attestation, { payload, signatures }, as received
  attestor_signature_2  JSONB,   -- the endorser's
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Plus the `set_updated_at` trigger and column comments, as every table has.
Stand-alone, no foreign keys, like the other two.

A row is ready for a leader round when `approved` and both slots are filled.

**Q** Your names were "assisted" / "assisted_transfer" for the table and
attestor_signature_1 / _2 for the columns. The plural matches the other
tables. The columns hold the whole attestation as JSONB rather than bare
signature bytes, so the row says who attested; the names could become
`attestation_1` / `attestation_2` to match, or stay as yours.

### The balance trigger

`garlic_chain_apply_anos_transfer` fires for the three transfer types by
name; the new type joins the list. `CREATE OR REPLACE` on a re-run of
`npm run db:setup` updates it, and the two new tables are created the same
way, so no reset is needed. The comments on `locked_transactions` that say
assisted accounts have a time lock come out (**Q** section in the chat).

## 5. What goes on the chain

The two attestations are what authorised the transfer, so the proposal is
to carry them in the link: when the leader round writes an assisted
transfer, its `og_transaction` is the row's object with a third key,
`attestations: [slot 1, slot 2]`, next to `payload` and `signatures`.
`trans_hash` and `record_hash` hash the payload alone, as today, so the ids
and the chain hashes do not change.

**Q** That, or leave them behind with the row when it is deleted?
