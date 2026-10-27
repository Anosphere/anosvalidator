-- db/validators.sql
--
-- The validator registry: one row per validator, and the same rows in every
-- validator's database. scripts/setup-db.sh applies it right after
-- db/schema.sql.
--
-- Safe to re-run. An existing row gets its key and url refreshed; its active
-- and is_leader flags are left alone, so a validator switched off by hand
-- stays off, and leadership, which moves while the validators run, stays
-- where it is. Validator 1 starts as the leader.
--
-- These are the public halves of the development keys in .env-validator1..5,
-- generated 2026-10-20. A testnet gets its own copy of this file with real
-- keys and real hosts.

INSERT INTO validators (id, public_key, url, is_leader) VALUES
  (1,
   decode('0393fe54af1c64dc495012fba6d35fb2b6056178848f8a5ab1c5deeb5c32554645', 'hex'),
   'http://127.0.0.1:3001',
   true),
  (2,
   decode('032461aa771bc76bad83a866f5de626dce607bd089fb01c416d15fa7fb7531126e', 'hex'),
   'http://127.0.0.1:3002',
   false),
  (3,
   decode('03348d84e419dbd842b1ca706de2351503cf997cb058b3b63a66b8db498378e765', 'hex'),
   'http://127.0.0.1:3003',
   false),
  (4,
   decode('021a234f948f0d2f18657181129b172ab9df9444e2f717d31e144558379ae4b897', 'hex'),
   'http://127.0.0.1:3004',
   false),
  (5,
   decode('02e5d30905471ab8c7d08e342546317ed92da2feecb6e4cc2affbff29d7bb4326d', 'hex'),
   'http://127.0.0.1:3005',
   false)
ON CONFLICT (id) DO UPDATE SET
  public_key              = EXCLUDED.public_key,
  url                     = EXCLUDED.url;
