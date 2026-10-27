-- db/schema.sql
--
-- The whole database schema, built from nothing. scripts/setup-db.sh applies
-- it to every validator's database, followed by db/validators.sql.
--
-- Safe to run again on a database that already has it: tables use IF NOT
-- EXISTS, the function and triggers use OR REPLACE, comments just overwrite.
-- It never alters a table that already exists, though. After changing this
-- file, rebuild the local databases from scratch with
--
--   npm run db:reset
--
-- Naming conventions:
--   * PostgreSQL folds unquoted identifiers to lowercase, so everything is
--     lowercase snake_case. camelCase or Capitalised names would have to be
--     double-quoted in every query forever.
--   * Table names are plural nouns (a row is one account, the table holds
--     accounts).
--
-- Storage of hashes and public keys:
--   * All of them are raw bytes, so they are stored as BYTEA, not as hex text.
--     BYTEA uses half the space of hex, compares byte-for-byte, and has no
--     upper/lowercase ambiguity. Encode to hex or base64 at the API boundary.
--   * Where the length is fixed by the algorithm, a CHECK enforces it so a
--     truncated or mis-encoded value can never be stored:
--       SHA-256 digest ..................... 32 bytes
--       P-256 public key, compressed ....... 33 bytes (validators)
--       ML-DSA-87 public key ............... 2592 bytes (FIPS 204)
--     Account P-256 keys are left unconstrained: 33 bytes compressed or 65
--     uncompressed depending on the encoding chosen.
--   * Money is BIGINT in millionths of a unit (6 implied decimals), never
--     floats. BIGINT tops out at about 9.22 trillion units.
--
-- Timestamps: every table has created_at and updated_at (TIMESTAMPTZ).
-- PostgreSQL has no "ON UPDATE CURRENT_TIMESTAMP", so one reusable trigger
-- function stamps updated_at, attached to every table. The WHEN clause on each
-- trigger skips the write when an UPDATE changed nothing, so updated_at only
-- moves on real changes.
--
-- Comments live in the database itself and show up in psql with \d+ <table>.

-- IF NOT EXISTS raises a NOTICE for every table that is already there. On a
-- re-run that is one line of noise per table, so only warnings and up show.
SET client_min_messages = warning;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- accounts: one row per wallet account.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS accounts (
  -- SHA-256 digest that identifies the account.
  account_id        BYTEA   PRIMARY KEY
                            CHECK (octet_length(account_id) = 32),

  -- Primary signing key pair: classical ECDSA + post-quantum ML-DSA-87.
  public_key1       BYTEA   NOT NULL,
  public_key_pq1    BYTEA   NOT NULL
                            CHECK (octet_length(public_key_pq1) = 2592),

  -- Secondary signing key pair.
  public_key2       BYTEA,
  public_key_pq2    BYTEA   CHECK (octet_length(public_key_pq2) = 2592),

  -- Alternate wallet key pair.
  alt_wallet_pk     BYTEA,
  alt_wallet_pk_pq  BYTEA   CHECK (octet_length(alt_wallet_pk_pq) = 2592),

  -- Balance in millionths of a unit. Never negative.
  current_balance   BIGINT  NOT NULL DEFAULT 0
                            CHECK (current_balance >= 0),

  -- Break-glass (recovery) key pair.
  break_glass_pk    BYTEA,
  break_glass_pk_pq BYTEA   CHECK (octet_length(break_glass_pk_pq) = 2592),

  -- Short free-form classifier for the account.
  type              TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER accounts_set_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  accounts                   IS 'One row per wallet account.';
COMMENT ON COLUMN accounts.account_id        IS 'SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN accounts.public_key1       IS 'ECDSA public key, raw bytes.';
COMMENT ON COLUMN accounts.public_key_pq1    IS 'ML-DSA-87 public key, 2592 raw bytes.';
COMMENT ON COLUMN accounts.public_key2       IS 'Secondary ECDSA public key.';
COMMENT ON COLUMN accounts.public_key_pq2    IS 'Secondary ML-DSA-87 public key.';
COMMENT ON COLUMN accounts.alt_wallet_pk     IS 'Alternate wallet ECDSA public key.';
COMMENT ON COLUMN accounts.alt_wallet_pk_pq  IS 'Alternate wallet ML-DSA-87 public key.';
COMMENT ON COLUMN accounts.current_balance   IS 'Millionths of a unit (6 implied decimals).';
COMMENT ON COLUMN accounts.break_glass_pk    IS 'Break-glass ECDSA public key.';
COMMENT ON COLUMN accounts.break_glass_pk_pq IS 'Break-glass ML-DSA-87 public key.';
COMMENT ON COLUMN accounts.type              IS 'Short account classifier.';
COMMENT ON COLUMN accounts.created_at        IS 'When the row was inserted. Set by default, never changed.';
COMMENT ON COLUMN accounts.updated_at        IS 'When the row last changed. Maintained by the accounts_set_updated_at trigger.';


-- ---------------------------------------------------------------------------
-- garlic_chain: one row per link in the garlic chain, a transaction moving an
-- amount from one account to another, with a pointer to the transaction that
-- follows it.
--
-- og_transaction is the signed transaction object exactly as submitted, kept
-- whole as JSONB. A signature can only be checked against the exact bytes that
-- were signed, and those bytes are rebuilt from the object with RFC 8785
-- canonical JSON (src/crypto/canonical.js). The signatures and the public keys
-- that verify them are fields inside that object, so separate columns for
-- them would be duplicates that could drift from the signed truth.
--
-- trans_hash is the hash of the signed part of the object; comparing it with
-- a fresh hash of og_transaction is a cheap integrity check before the
-- expensive signature verification.
--
-- JSONB does not preserve key order or whitespace. That is fine because the
-- canonical form fixes both. Big integers must travel as strings so they
-- survive the round trip through JavaScript doubles.
--
-- position numbers the rows in the order they were written: 1, 2, 3, ... The
-- highest number is the chain's tail, the link the next one chains its
-- record_hash on (src/garlic-chain/garlic-chain.queries.js findTail), and
-- the highest number for an account is that account's newest transaction.
-- Every validator writes the same rows in the same order, so the numbers
-- agree across validators. It is the last column because it was added once
-- the table was in use (ALTER TABLE ADD COLUMN appends), so a database
-- built from this file matches one that was altered.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS garlic_chain (
  -- The accounts involved. Each holds an accounts.account_id value, or NULL
  -- when not applicable to the transaction.
  account_id          BYTEA   CHECK (octet_length(account_id) = 32),
  account_id_to       BYTEA   CHECK (octet_length(account_id_to) = 32),

  -- Identifies this transaction. One row per transaction.
  transaction_id      BYTEA   PRIMARY KEY
                              CHECK (octet_length(transaction_id) = 32),

  -- Millionths of a unit, same scale as accounts.current_balance.
  amount              BIGINT  NOT NULL,

  -- Hash of the signed part of og_transaction.
  trans_hash          BYTEA   NOT NULL
                              CHECK (octet_length(trans_hash) = 32),

  -- Hash of the whole record.
  record_hash         BYTEA   CHECK (octet_length(record_hash) = 32),

  -- Short free-form classifier for the transaction.
  type                TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The signed transaction object exactly as submitted (see above).
  og_transaction      JSONB   NOT NULL,

  -- The row's place in the chain: 1 for the first link ever, counting up
  -- with every insert. The highest is the tail.
  position            BIGINT  GENERATED ALWAYS AS IDENTITY UNIQUE
);

CREATE OR REPLACE TRIGGER garlic_chain_set_updated_at
  BEFORE UPDATE ON garlic_chain
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  garlic_chain                     IS 'One row per transaction (link) in the garlic chain.';
COMMENT ON COLUMN garlic_chain.account_id          IS 'The account this transaction belongs to. SHA-256 digest, 32 raw bytes. NULL when not applicable.';
COMMENT ON COLUMN garlic_chain.account_id_to       IS 'Receiver account_id. SHA-256 digest, 32 raw bytes. NULL when not applicable.';
COMMENT ON COLUMN garlic_chain.transaction_id      IS 'Transaction identifier. SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN garlic_chain.amount              IS 'Millionths of a unit (6 implied decimals).';
COMMENT ON COLUMN garlic_chain.trans_hash          IS 'Hash of the transaction. SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN garlic_chain.record_hash         IS 'Hash of the whole record. SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN garlic_chain.type                IS 'Short transaction classifier.';
COMMENT ON COLUMN garlic_chain.created_at          IS 'When the row was inserted. Set by default, never changed.';
COMMENT ON COLUMN garlic_chain.updated_at          IS 'When the row last changed. Maintained by the garlic_chain_set_updated_at trigger.';
COMMENT ON COLUMN garlic_chain.og_transaction      IS 'The signed transaction object exactly as submitted, as JSON. Carries its own signatures and public keys.';
COMMENT ON COLUMN garlic_chain.position            IS 'The row''s place in the chain, counting up from 1 with every insert. The highest is the tail.';


-- ---------------------------------------------------------------------------
-- Moving the anos: when a transfer link is inserted, of any of the seven
-- transfer types below, its amount leaves the sender's balance (account_id)
-- and lands in the receiver's (account_id_to). Done by a trigger so the
-- balances can never
-- disagree with the chain: the link and both balance changes happen in one
-- statement, inside whatever transaction wrote the link (the batch in
-- src/accounts/accounts.service.js writeTransactions), and all of it commits
-- or none of it does.
--
-- Each UPDATE must change exactly one row; a missing account raises, which
-- fails the insert and rolls the batch back. accounts.current_balance has
-- CHECK (current_balance >= 0), so a sender without enough anos fails the
-- same way. The server checks both before it accepts a transfer into
-- pending; the trigger is the backstop. The UPDATEs fire
-- accounts_set_updated_at, so both accounts' updated_at move.
--
-- Only rows whose type is one of the seven transfer types qualify (the WHEN
-- clause): 'anosTransfer', 'guardedAnosTransfer', 'vaultAnosTransfer',
-- 'assistedAnosTransfer', 'escrowTransfer', 'transferToFund' (an account
-- staking anos with the fund) and 'transferFromFund' (a payout of a fund
-- proposal; the fund is the sender). An account creation or a fund proposal
-- link has no account_id_to and amount 0, and is left alone.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION apply_anos_transfer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed integer;
BEGIN
  UPDATE accounts
     SET current_balance = current_balance - NEW.amount
   WHERE account_id = NEW.account_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION '% %: no account % to send from',
      NEW.type, encode(NEW.transaction_id, 'hex'), encode(NEW.account_id, 'hex');
  END IF;

  UPDATE accounts
     SET current_balance = current_balance + NEW.amount
   WHERE account_id = NEW.account_id_to;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION '% %: no account % to send to',
      NEW.type, encode(NEW.transaction_id, 'hex'), encode(NEW.account_id_to, 'hex');
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER garlic_chain_apply_anos_transfer
  AFTER INSERT ON garlic_chain
  FOR EACH ROW
  WHEN (NEW.type IN ('anosTransfer', 'guardedAnosTransfer', 'vaultAnosTransfer',
                     'assistedAnosTransfer', 'escrowTransfer',
                     'transferToFund', 'transferFromFund'))
  EXECUTE FUNCTION apply_anos_transfer();


-- ---------------------------------------------------------------------------
-- pending: transactions received but not yet moved onto the garlic chain.
-- Stand-alone table: no foreign keys to accounts or garlic_chain.
--
-- og_transaction is the original transaction object exactly as the phone
-- built it, kept whole as JSONB, same column as garlic_chain.og_transaction
-- so one canonicalise-and-verify path serves both.
--
-- account_id is the account a pending transaction belongs to (for a
-- create-account transaction, the account being created). The value also
-- lives inside og_transaction, but a real column gives it the same
-- representation as every other id, an index, and a UNIQUE constraint: this
-- system allows exactly one pending transaction per account. The server fills
-- it at insert time from the payload it has already validated, and checks all
-- four uniqueness rules in one query before inserting; the constraints are
-- the backstop for two validators racing. UNIQUE creates the index that the
-- "already pending for this account" lookup uses.
--
-- PostgreSQL has no TINYINT. BOOLEAN is its 1-byte true/false type, and the
-- pg driver hands it to Node as a real JavaScript boolean.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pending (
  -- Identifies the submitted transaction. SHA-256 digest, 32 raw bytes.
  transaction_id   BYTEA   PRIMARY KEY
                           CHECK (octet_length(transaction_id) = 32),

  -- The transaction object as created on the user's phone, stored whole.
  og_transaction   JSONB   NOT NULL,

  -- true once every validator has accepted it. Starts out false.
  approved         BOOLEAN NOT NULL DEFAULT false,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The account this transaction belongs to. One pending transaction per account.
  account_id       BYTEA   NOT NULL UNIQUE
                           CHECK (octet_length(account_id) = 32)
);

CREATE OR REPLACE TRIGGER pending_set_updated_at
  BEFORE UPDATE ON pending
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  pending                IS 'Stand-alone; no foreign keys.';
COMMENT ON COLUMN pending.transaction_id IS 'SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN pending.og_transaction IS 'Original transaction object from the user''s phone, as JSON.';
COMMENT ON COLUMN pending.approved       IS 'true/false flag, default false.';
COMMENT ON COLUMN pending.created_at     IS 'When the row was inserted. Set by default, never changed.';
COMMENT ON COLUMN pending.updated_at     IS 'When the row last changed. Maintained by the pending_set_updated_at trigger.';
COMMENT ON COLUMN pending.account_id     IS 'The account this transaction belongs to. SHA-256 digest, 32 raw bytes. One pending transaction per account.';


-- ---------------------------------------------------------------------------
-- locked_transactions: This is for guarded and vault accounts, which both
-- have time locks. A transfer out of such an account waits here, instead
-- of in pending, until its future_date has passed; the leader round then
-- writes it with the pending transactions (src/validators/validators.service.js).
-- There is only one locked transaction per account at a time, so account_id
-- is unique. transaction_id is the primary key, as in pending: a proof of
-- acceptance and the leader's lists name a transaction by its id.
-- Stand-alone table: no foreign keys to accounts or garlic_chain.
--
-- future_date is the transaction's createdAt, which the wallet dates the
-- account's lock ahead; the code checks that, not the table
-- (src/transfer/transfer.service.js). It arrives as an ISO 8601 string, for
-- example "2027-03-01T15:30:00.000Z". TIMESTAMPTZ parses the string, honours
-- its offset and stores the absolute instant, so it compares correctly with
-- now() and reads back as the same instant whatever time zone the server
-- session runs in. A plain TIMESTAMP would drop the offset and keep the
-- wall-clock digits.
--
-- og_transaction is the same column as pending.og_transaction and
-- garlic_chain.og_transaction, so one canonicalise-and-verify path serves all
-- three.
--
-- transaction_id is the last column because it was added once the table was
-- in use (ALTER TABLE ADD COLUMN appends), so a database built from this file
-- matches one that was altered.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS locked_transactions (
  -- The account this transaction belongs to. SHA-256 digest, 32 raw bytes.
  -- One locked transaction per account at a time, hence UNIQUE.
  account_id       BYTEA   NOT NULL UNIQUE
                           CHECK (octet_length(account_id) = 32),

  -- The moment the transaction may be written: its createdAt.
  future_date      TIMESTAMPTZ NOT NULL,

  -- The transaction object exactly as submitted, stored whole.
  og_transaction   JSONB   NOT NULL,

  -- true once approved. Starts out false.
  approved         BOOLEAN NOT NULL DEFAULT false,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Identifies the submitted transaction. SHA-256 digest, 32 raw bytes.
  transaction_id   BYTEA   PRIMARY KEY
                           CHECK (octet_length(transaction_id) = 32)
);

CREATE OR REPLACE TRIGGER locked_transactions_set_updated_at
  BEFORE UPDATE ON locked_transactions
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  locked_transactions                IS 'This is for guarded and vault accounts, which both have time locks. Transfers out of them wait here until future_date. One locked transaction per account at a time. Stand-alone; no foreign keys.';
COMMENT ON COLUMN locked_transactions.account_id     IS 'The account this transaction belongs to. SHA-256 digest, 32 raw bytes. One locked transaction per account at a time.';
COMMENT ON COLUMN locked_transactions.future_date    IS 'The transaction''s createdAt: the moment it may be written. Absolute instant, in the future when inserted.';
COMMENT ON COLUMN locked_transactions.og_transaction IS 'The transaction object exactly as submitted, as JSON.';
COMMENT ON COLUMN locked_transactions.approved       IS 'true/false flag, default false.';
COMMENT ON COLUMN locked_transactions.created_at     IS 'When the row was inserted. Set by default, never changed.';
COMMENT ON COLUMN locked_transactions.updated_at     IS 'When the row last changed. Maintained by the locked_transactions_set_updated_at trigger.';
COMMENT ON COLUMN locked_transactions.transaction_id IS 'SHA-256 digest, 32 raw bytes.';


-- ---------------------------------------------------------------------------
-- stakes: one row per account that has anos staked with the fund, with the
-- amount staked for each of the six purposes (src/stakes/stake-purposes.js).
-- An account takes a role by staking: a transferToFund naming the purpose
-- adds its amount to that purpose's column here, in the same database
-- transaction as its garlic chain link (src/fund/fund.service.js). A role is
-- held while the column is at or above the purpose's minimum, from the env
-- file; there are no flags. A fund proposal that returns stake reduces the
-- column, and the row is deleted once every amount is zero.
-- Stand-alone table: no foreign keys.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stakes (
  -- The account that staked. SHA-256 digest, 32 raw bytes.
  account_id        BYTEA   PRIMARY KEY
                            CHECK (octet_length(account_id) = 32),

  -- Millionths of a unit staked for each purpose. Never negative.
  dao_vote_stake    BIGINT  NOT NULL DEFAULT 0 CHECK (dao_vote_stake >= 0),
  moderator_stake   BIGINT  NOT NULL DEFAULT 0 CHECK (moderator_stake >= 0),
  attestor_stake    BIGINT  NOT NULL DEFAULT 0 CHECK (attestor_stake >= 0),
  guardian_stake    BIGINT  NOT NULL DEFAULT 0 CHECK (guardian_stake >= 0),
  validator_stake   BIGINT  NOT NULL DEFAULT 0 CHECK (validator_stake >= 0),
  master_pod_stake  BIGINT  NOT NULL DEFAULT 0 CHECK (master_pod_stake >= 0),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER stakes_set_updated_at
  BEFORE UPDATE ON stakes
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  stakes                  IS 'One row per account with anos staked with the fund. A role is held while its column is at or above the minimum. Stand-alone; no foreign keys.';
COMMENT ON COLUMN stakes.account_id       IS 'The account that staked. SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN stakes.dao_vote_stake   IS 'Staked for daoVote. Millionths of a unit (6 implied decimals).';
COMMENT ON COLUMN stakes.moderator_stake  IS 'Staked for moderator. Millionths of a unit.';
COMMENT ON COLUMN stakes.attestor_stake   IS 'Staked for attestor. Millionths of a unit.';
COMMENT ON COLUMN stakes.guardian_stake   IS 'Staked for guardian. Millionths of a unit.';
COMMENT ON COLUMN stakes.validator_stake  IS 'Staked for validator. Millionths of a unit.';
COMMENT ON COLUMN stakes.master_pod_stake IS 'Staked for masterPod. Millionths of a unit.';
COMMENT ON COLUMN stakes.created_at       IS 'When the row was inserted. Set by default, never changed.';
COMMENT ON COLUMN stakes.updated_at       IS 'When the row last changed. Maintained by the stakes_set_updated_at trigger.';


-- ---------------------------------------------------------------------------
-- assisted_transfers: pending's twin for transfers out of assisted accounts
-- (assistedAnosTransfer). A transfer waits here until two attestors have
-- attested to it; the leader round then writes it with the pending
-- transactions and moves the row to logs. The same one transaction per
-- account and the same approved flag as pending, plus three slots for the
-- follow-ups attached to the transfer, each holding the whole signed object
-- ({ payload, signatures }) as received, with its own approved flag:
-- attestation_1 and attestation_2 (the first attestation to arrive goes in
-- slot 1) and cancellation, the sender's assistedTransferCancel. Once a
-- cancellation is approved the row moves to logs instead.
-- Stand-alone table: no foreign keys.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS assisted_transfers (
  -- Identifies the submitted transaction. SHA-256 digest, 32 raw bytes.
  transaction_id          BYTEA   PRIMARY KEY
                                  CHECK (octet_length(transaction_id) = 32),

  -- The sending account. One outstanding transaction per account, hence UNIQUE.
  account_id              BYTEA   NOT NULL UNIQUE
                                  CHECK (octet_length(account_id) = 32),

  -- The transaction object exactly as submitted, stored whole.
  og_transaction          JSONB   NOT NULL,

  -- true once every validator has accepted the transaction. Starts out false.
  approved                BOOLEAN NOT NULL DEFAULT false,

  -- The two attestations and the sender's cancellation, whole, each with its
  -- own approved flag. NULL while the slot is empty.
  attestation_1           JSONB,
  attestation_1_approved  BOOLEAN NOT NULL DEFAULT false,
  attestation_2           JSONB,
  attestation_2_approved  BOOLEAN NOT NULL DEFAULT false,
  cancellation            JSONB,
  cancellation_approved   BOOLEAN NOT NULL DEFAULT false,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER assisted_transfers_set_updated_at
  BEFORE UPDATE ON assisted_transfers
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  assisted_transfers                        IS 'Transfers out of assisted accounts waiting for two attestations. One per account at a time. Stand-alone; no foreign keys.';
COMMENT ON COLUMN assisted_transfers.transaction_id         IS 'SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN assisted_transfers.account_id             IS 'The sending account. SHA-256 digest, 32 raw bytes. One outstanding transaction per account.';
COMMENT ON COLUMN assisted_transfers.og_transaction         IS 'The transaction object exactly as submitted, as JSON.';
COMMENT ON COLUMN assisted_transfers.approved               IS 'true once every validator accepted the transaction. Default false.';
COMMENT ON COLUMN assisted_transfers.attestation_1          IS 'The first attestation to arrive, { payload, signatures } as received. NULL while empty.';
COMMENT ON COLUMN assisted_transfers.attestation_1_approved IS 'true once every validator accepted attestation_1. Default false.';
COMMENT ON COLUMN assisted_transfers.attestation_2          IS 'The second attestation, { payload, signatures } as received. NULL while empty.';
COMMENT ON COLUMN assisted_transfers.attestation_2_approved IS 'true once every validator accepted attestation_2. Default false.';
COMMENT ON COLUMN assisted_transfers.cancellation           IS 'The sender''s assistedTransferCancel, { payload, signatures } as received. NULL while none.';
COMMENT ON COLUMN assisted_transfers.cancellation_approved  IS 'true once every validator accepted the cancellation; the row then moves to logs. Default false.';
COMMENT ON COLUMN assisted_transfers.created_at             IS 'When the row was inserted. Set by default, never changed.';
COMMENT ON COLUMN assisted_transfers.updated_at             IS 'When the row last changed. Maintained by the assisted_transfers_set_updated_at trigger.';


-- ---------------------------------------------------------------------------
-- escrow_transfers: pending's twin for escrow transfers (escrowTransfer). The
-- seller (account_id) sends the anos; the buyer (account_id_to) pays
-- off-chain. The transfer waits here until the seller signs for success, the
-- buyer cancels, or one of them disputes and two arbitrators decide
-- (escrow_arbitrations). Three slots hold those signed objects whole, each
-- with its own approved flag. Written, the row moves to logs, or to archives
-- when there was a dispute; cancelled, to logs; arbitrated to cancel, to
-- archives.
-- Stand-alone table: no foreign keys.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS escrow_transfers (
  -- Identifies the submitted transaction. SHA-256 digest, 32 raw bytes.
  transaction_id              BYTEA   PRIMARY KEY
                                      CHECK (octet_length(transaction_id) = 32),

  -- The seller, who sends the anos. One outstanding transaction per account.
  account_id                  BYTEA   NOT NULL UNIQUE
                                      CHECK (octet_length(account_id) = 32),

  -- The buyer, who pays off-chain.
  account_id_to               BYTEA   NOT NULL
                                      CHECK (octet_length(account_id_to) = 32),

  -- The transaction object exactly as submitted, stored whole.
  og_transaction              JSONB   NOT NULL,

  -- true once every validator has accepted the transaction. Starts out false.
  approved                    BOOLEAN NOT NULL DEFAULT false,

  -- The seller's escrowSuccess, the buyer's escrowCancel and either side's
  -- escrowDispute, whole, each with its own approved flag. NULL while empty.
  success_signature           JSONB,
  success_signature_approved  BOOLEAN NOT NULL DEFAULT false,
  cancel_signature            JSONB,
  cancel_signature_approved   BOOLEAN NOT NULL DEFAULT false,
  dispute_signature           JSONB,
  dispute_signature_approved  BOOLEAN NOT NULL DEFAULT false,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER escrow_transfers_set_updated_at
  BEFORE UPDATE ON escrow_transfers
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  escrow_transfers                            IS 'Escrow transfers waiting for the seller''s success, the buyer''s cancel or an arbitrated verdict. One per seller at a time. Stand-alone; no foreign keys.';
COMMENT ON COLUMN escrow_transfers.transaction_id             IS 'SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN escrow_transfers.account_id                 IS 'The seller, who sends the anos. SHA-256 digest, 32 raw bytes. One outstanding transaction per account.';
COMMENT ON COLUMN escrow_transfers.account_id_to              IS 'The buyer, who pays off-chain. SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN escrow_transfers.og_transaction             IS 'The transaction object exactly as submitted, as JSON.';
COMMENT ON COLUMN escrow_transfers.approved                   IS 'true once every validator accepted the transaction. Default false.';
COMMENT ON COLUMN escrow_transfers.success_signature          IS 'The seller''s escrowSuccess, { payload, signatures } as received. NULL while none.';
COMMENT ON COLUMN escrow_transfers.success_signature_approved IS 'true once every validator accepted the success signature; the transfer is then ready to write. Default false.';
COMMENT ON COLUMN escrow_transfers.cancel_signature           IS 'The buyer''s escrowCancel, { payload, signatures } as received. NULL while none.';
COMMENT ON COLUMN escrow_transfers.cancel_signature_approved  IS 'true once every validator accepted the cancel signature; the row then moves to logs. Default false.';
COMMENT ON COLUMN escrow_transfers.dispute_signature          IS 'The seller''s or the buyer''s escrowDispute, { payload, signatures } as received. NULL while none.';
COMMENT ON COLUMN escrow_transfers.dispute_signature_approved IS 'true once every validator accepted the dispute; from then on only verdicts move the escrow. Default false.';
COMMENT ON COLUMN escrow_transfers.created_at                 IS 'When the row was inserted. Set by default, never changed.';
COMMENT ON COLUMN escrow_transfers.updated_at                 IS 'When the row last changed. Maintained by the escrow_transfers_set_updated_at trigger.';


-- ---------------------------------------------------------------------------
-- escrow_arbitrations: one row per arbitrator per disputed escrow, holding
-- the arbitrator's signed escrowVerdict whole. An arbitrator is an account
-- with attestor stake. The first verdict to have two approved rows decides
-- the escrow: success makes it ready to write, cancel moves it to archives.
-- The rows follow the escrow into logs or archives (src/records/).
-- Stand-alone table: no foreign keys.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS escrow_arbitrations (
  -- The disputed escrow's transaction id. SHA-256 digest, 32 raw bytes.
  transaction_id         BYTEA   NOT NULL
                                 CHECK (octet_length(transaction_id) = 32),

  -- The arbitrator's account. One verdict per arbitrator per escrow.
  arbitrator_account_id  BYTEA   NOT NULL
                                 CHECK (octet_length(arbitrator_account_id) = 32),

  -- What the arbitrator decided.
  verdict                TEXT    NOT NULL CHECK (verdict IN ('success', 'cancel')),

  -- The escrowVerdict object exactly as received, stored whole.
  signature              JSONB   NOT NULL,

  -- true once every validator has accepted the verdict. Starts out false.
  approved               BOOLEAN NOT NULL DEFAULT false,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (transaction_id, arbitrator_account_id)
);

CREATE OR REPLACE TRIGGER escrow_arbitrations_set_updated_at
  BEFORE UPDATE ON escrow_arbitrations
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  escrow_arbitrations                       IS 'One row per arbitrator per disputed escrow. Two approved rows with the same verdict decide it. Stand-alone; no foreign keys.';
COMMENT ON COLUMN escrow_arbitrations.transaction_id        IS 'The disputed escrow''s transaction id. SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN escrow_arbitrations.arbitrator_account_id IS 'The arbitrator''s account. SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN escrow_arbitrations.verdict               IS 'success or cancel.';
COMMENT ON COLUMN escrow_arbitrations.signature             IS 'The escrowVerdict object exactly as received, as JSON.';
COMMENT ON COLUMN escrow_arbitrations.approved              IS 'true once every validator accepted the verdict. Default false.';
COMMENT ON COLUMN escrow_arbitrations.created_at            IS 'When the row was inserted. Set by default, never changed.';
COMMENT ON COLUMN escrow_arbitrations.updated_at            IS 'When the row last changed. Maintained by the escrow_arbitrations_set_updated_at trigger.';


-- ---------------------------------------------------------------------------
-- fund_proposals: pending's twin for fund proposals (fundProposal), a
-- guardian's list of payments from the fund. account_id is always the fund's
-- id, so the UNIQUE means one open proposal at a time. The proposal is open
-- for guardian votes (guardian_votes) until vote_closes_at, its createdAt
-- plus GUARDIAN_VOTE_MINUTES; a leader round after that tallies the votes
-- and writes it, moving the row and its votes to archives, or archives it
-- unwritten when the vote failed. proposer_weight is the proposer's votes
-- when the proposal was stored: the proposer's own vote for is counted from
-- it, so the proposer has no guardian_votes row.
-- Stand-alone table: no foreign keys.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fund_proposals (
  -- Identifies the proposal. SHA-256 digest, 32 raw bytes.
  transaction_id   BYTEA   PRIMARY KEY
                           CHECK (octet_length(transaction_id) = 32),

  -- Always the fund's account id; UNIQUE, so one open proposal at a time.
  account_id       BYTEA   NOT NULL UNIQUE
                           CHECK (octet_length(account_id) = 32),

  -- The proposal object exactly as submitted, stored whole.
  og_transaction   JSONB   NOT NULL,

  -- true once every validator has accepted the proposal. Starts out false.
  approved         BOOLEAN NOT NULL DEFAULT false,

  -- When voting ends: createdAt plus GUARDIAN_VOTE_MINUTES.
  vote_closes_at   TIMESTAMPTZ NOT NULL,

  -- The proposer's votes when the proposal was stored; counted as for.
  proposer_weight  INTEGER NOT NULL CHECK (proposer_weight >= 1),

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER fund_proposals_set_updated_at
  BEFORE UPDATE ON fund_proposals
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  fund_proposals                 IS 'Fund proposals open for guardian votes. One at a time. Stand-alone; no foreign keys.';
COMMENT ON COLUMN fund_proposals.transaction_id  IS 'SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN fund_proposals.account_id      IS 'Always the fund''s account id. SHA-256 digest, 32 raw bytes. One open proposal at a time.';
COMMENT ON COLUMN fund_proposals.og_transaction  IS 'The proposal object exactly as submitted, as JSON.';
COMMENT ON COLUMN fund_proposals.approved        IS 'true once every validator accepted the proposal. Default false.';
COMMENT ON COLUMN fund_proposals.vote_closes_at  IS 'When voting ends: the proposal''s createdAt plus GUARDIAN_VOTE_MINUTES. Absolute instant.';
COMMENT ON COLUMN fund_proposals.proposer_weight IS 'The proposer''s votes when the proposal was stored, counted as a vote for.';
COMMENT ON COLUMN fund_proposals.created_at      IS 'When the row was inserted. Set by default, never changed.';
COMMENT ON COLUMN fund_proposals.updated_at      IS 'When the row last changed. Maintained by the fund_proposals_set_updated_at trigger.';


-- ---------------------------------------------------------------------------
-- guardian_votes: one row per guardian per fund proposal, holding the
-- guardian's signed guardianVote whole. weight is the guardian's votes at
-- the moment they voted (floor of guardian_stake over GUARDIAN_VOTE_ANOS),
-- kept for the record and used in the tally. The rows follow the proposal
-- into archives (src/records/).
-- Stand-alone table: no foreign keys.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS guardian_votes (
  -- The proposal's transaction id. SHA-256 digest, 32 raw bytes.
  transaction_id       BYTEA   NOT NULL
                               CHECK (octet_length(transaction_id) = 32),

  -- The guardian's account. One vote per guardian per proposal.
  guardian_account_id  BYTEA   NOT NULL
                               CHECK (octet_length(guardian_account_id) = 32),

  -- Which way the guardian voted.
  vote                 TEXT    NOT NULL CHECK (vote IN ('for', 'against')),

  -- The guardian's votes when they voted.
  weight               INTEGER NOT NULL CHECK (weight >= 1),

  -- The guardianVote object exactly as received, stored whole.
  signature            JSONB   NOT NULL,

  -- true once every validator has accepted the vote. Starts out false.
  approved             BOOLEAN NOT NULL DEFAULT false,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (transaction_id, guardian_account_id)
);

CREATE OR REPLACE TRIGGER guardian_votes_set_updated_at
  BEFORE UPDATE ON guardian_votes
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  guardian_votes                     IS 'One row per guardian per fund proposal. Stand-alone; no foreign keys.';
COMMENT ON COLUMN guardian_votes.transaction_id      IS 'The proposal''s transaction id. SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN guardian_votes.guardian_account_id IS 'The guardian''s account. SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN guardian_votes.vote                IS 'for or against.';
COMMENT ON COLUMN guardian_votes.weight              IS 'The guardian''s votes when they voted: floor of guardian_stake over GUARDIAN_VOTE_ANOS.';
COMMENT ON COLUMN guardian_votes.signature           IS 'The guardianVote object exactly as received, as JSON.';
COMMENT ON COLUMN guardian_votes.approved            IS 'true once every validator accepted the vote. Default false.';
COMMENT ON COLUMN guardian_votes.created_at          IS 'When the row was inserted. Set by default, never changed.';
COMMENT ON COLUMN guardian_votes.updated_at          IS 'When the row last changed. Maintained by the guardian_votes_set_updated_at trigger.';


-- ---------------------------------------------------------------------------
-- logs and archives: where rows go when they leave assisted_transfers,
-- escrow_transfers or fund_proposals (src/records/records.queries.js). The
-- two tables have the same columns. source is the table the row left,
-- outcome why (written, userCancelled, receiverCancelled, arbitratedSuccess,
-- arbitratedCancel or voteFailed), record the whole row as JSON plus its
-- child rows: { row }, { row, arbitrations } or { row, votes }. Each move is
-- one database transaction: the insert here, then the deletes there. Every
-- validator does every move for itself, at the same logical moment, so the
-- copies stay identical. Logs may be purged after a time:
--
--   DELETE FROM logs WHERE created_at < now() - interval '1 month';
--
-- Archives are kept. Rows here never change, so there is no updated_at and no
-- trigger. Nothing from pending or locked_transactions is logged: the chain
-- holds everything they had.
-- Stand-alone tables: no foreign keys.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS logs (
  -- The transaction the row was about. SHA-256 digest, 32 raw bytes.
  transaction_id  BYTEA   PRIMARY KEY
                          CHECK (octet_length(transaction_id) = 32),

  -- The holding table the row left.
  source          TEXT    NOT NULL,

  -- Why it left.
  outcome         TEXT    NOT NULL,

  -- The row's account_id: the sender, or the fund.
  account_id      BYTEA   NOT NULL
                          CHECK (octet_length(account_id) = 32),

  -- The row and its child rows, as JSON.
  record          JSONB   NOT NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  logs                IS 'Rows that left assisted_transfers or escrow_transfers for an everyday reason. May be purged after a time. Stand-alone; no foreign keys.';
COMMENT ON COLUMN logs.transaction_id IS 'SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN logs.source         IS 'The holding table the row left.';
COMMENT ON COLUMN logs.outcome        IS 'Why the row left: written, userCancelled or receiverCancelled.';
COMMENT ON COLUMN logs.account_id     IS 'The row''s account_id. SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN logs.record         IS 'The whole row as JSON, with its child rows: { row }, { row, arbitrations } or { row, votes }.';
COMMENT ON COLUMN logs.created_at     IS 'When the row was moved here. Set by default, never changed.';

CREATE TABLE IF NOT EXISTS archives (
  -- The transaction the row was about. SHA-256 digest, 32 raw bytes.
  transaction_id  BYTEA   PRIMARY KEY
                          CHECK (octet_length(transaction_id) = 32),

  -- The holding table the row left.
  source          TEXT    NOT NULL,

  -- Why it left.
  outcome         TEXT    NOT NULL,

  -- The row's account_id: the seller, or the fund.
  account_id      BYTEA   NOT NULL
                          CHECK (octet_length(account_id) = 32),

  -- The row and its child rows, as JSON.
  record          JSONB   NOT NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  archives                IS 'Rows that left escrow_transfers after a dispute or fund_proposals. Never purged. Stand-alone; no foreign keys.';
COMMENT ON COLUMN archives.transaction_id IS 'SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN archives.source         IS 'The holding table the row left.';
COMMENT ON COLUMN archives.outcome        IS 'Why the row left: written, arbitratedSuccess, arbitratedCancel or voteFailed.';
COMMENT ON COLUMN archives.account_id     IS 'The row''s account_id. SHA-256 digest, 32 raw bytes.';
COMMENT ON COLUMN archives.record         IS 'The whole row as JSON, with its child rows: { row, arbitrations } or { row, votes }.';
COMMENT ON COLUMN archives.created_at     IS 'When the row was moved here. Set by default, never changed.';


-- ---------------------------------------------------------------------------
-- validators: the registry of validators, including this one. Every
-- validator's database holds the same rows (seeded from db/validators.sql).
--
-- Used in two directions: to find who to send receipts to (active rows other
-- than our own id, queried fresh each time so a change takes effect without a
-- restart), and to verify a received message by looking up the sender's id
-- here and using these keys, never keys carried inside the message.
--
-- Rows are never deleted. A validator that leaves is set active = false, so
-- the signatures it made while active can still be verified later.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS validators (
  -- Small integer chosen when the validator joins. Matches VALIDATOR_ID in
  -- that validator's env file.
  id                      INTEGER PRIMARY KEY,

  -- Key that verifies this validator's signatures: a compressed P-256 point,
  -- the same format as the account keys. Validators have no post-quantum key.
  public_key              BYTEA   NOT NULL
                                  CHECK (octet_length(public_key) = 33),

  -- Where to reach it: scheme, host and port, no trailing slash.
  url                     TEXT    NOT NULL,

  -- false once the validator has been removed.
  active                  BOOLEAN NOT NULL DEFAULT true,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- true when this validator is the leader.
  is_leader               BOOLEAN NOT NULL DEFAULT false
);

CREATE OR REPLACE TRIGGER validators_set_updated_at
  BEFORE UPDATE ON validators
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  validators                         IS 'Registry of validators, this one included. Same rows in every validator''s database.';
COMMENT ON COLUMN validators.id                      IS 'Validator id, matches VALIDATOR_ID in its env file.';
COMMENT ON COLUMN validators.public_key              IS 'P-256 public key, 33-byte compressed point.';
COMMENT ON COLUMN validators.url                     IS 'Base URL to reach the validator: scheme, host and port, no trailing slash.';
COMMENT ON COLUMN validators.active                  IS 'false once removed. Rows are never deleted.';
COMMENT ON COLUMN validators.created_at              IS 'When the row was inserted. Set by default, never changed.';
COMMENT ON COLUMN validators.updated_at              IS 'When the row last changed. Maintained by the validators_set_updated_at trigger.';
COMMENT ON COLUMN validators.is_leader               IS 'true when this validator is the leader. Default false.';


-- ---------------------------------------------------------------------------
-- nonces: the replay cache of signed requests at the account level
-- (src/auth/require-account.js), the keyholder's table as it is. An account
-- signing a read (/get-account, /list-transactions) sends a fresh nonce; a
-- second request with the same nonce is 401 replay. Rows are deleted as
-- they expire by the insert that adds a new one. Added after the other
-- tables were in use, so db:setup adds it to an existing database.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS nonces (
  nonce      BYTEA       PRIMARY KEY CHECK (octet_length(nonce) BETWEEN 16 AND 32),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS nonces_expires_at_idx ON nonces (expires_at);

COMMENT ON TABLE  nonces            IS 'The replay cache of signed account-level requests. A duplicate nonce is 401 replay. Expired rows are swept by the next insert.';
COMMENT ON COLUMN nonces.nonce      IS 'The request''s nonce, 16 to 32 raw bytes, never reused.';
COMMENT ON COLUMN nonces.expires_at IS 'now plus twice TIMESTAMP_WINDOW_SECONDS at insert, past which the timestamp check refuses the request anyway.';
