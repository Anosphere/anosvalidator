# Operator guide: one validator and one keyholder on one VM

For the operator of validator N of the anos testnet, in the order of the
onboarding visit. Both servers, the validator (this repo) and the keyholder
(keyholdersoftware), run on one Debian 13 VM in the operator's own Google
Cloud project, next to one PostgreSQL. No private key is ever printed or
copied: every key is made on the machine that keeps it, and the only thing
anyone types is the id.

## 1. Before the visit

- Your own Google Cloud project, with billing on.
- The id we hand you, `<N>`. It goes into both `.env` files (step 6) and
  into your row of the registry (step 8).

## 2. The worker VM

- Debian 13, chosen for unattended upgrades; confirm they are on
  (`systemctl status unattended-upgrades`).
- No external IP: the doorman has it (step 3). The worker has an internal
  IP only.
- The `cloud-platform` access scope on the VM's service account, so the
  keyholder can call Cloud KMS.
- Time in sync: `timedatectl` shows `System clock synchronized: yes`.
- PostgreSQL 17 and git from Debian 13's own packages, Node 24 from
  NodeSource:

```bash
sudo apt install postgresql git
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
sudo apt install nodejs
```

PostgreSQL's defaults already match what both servers expect: it listens on
`127.0.0.1:5432`, the `postgres` OS user is a superuser over the unix
socket, and TCP connections take a password.

## 3. Network

Doorman, static IP, firewall, outbound path, TLS: see the doorman plan.

## 4. Cloud KMS

In your project, in the VM's region, or the nearest region that offers
Cloud HSM when yours does not:

- enable the Cloud KMS API;
- a key ring `anos-testnet`;
- a key `keyholder-<N>`, purpose symmetric encryption, protection level
  HSM;
- the role `roles/cloudkms.cryptoKeyEncrypterDecrypter` for the VM's
  service account on that key, and nothing more.

The key's resource name,
`projects/<project>/locations/<region>/keyRings/anos-testnet/cryptoKeys/keyholder-<N>`,
is what goes into `KMS_KEY_NAME` in step 6.

## 5. Install

A system user `anos` with home `/opt/anos`; as that user, both repos under
it, with their dependencies:

```bash
sudo useradd --system --create-home --home-dir /opt/anos --shell /bin/bash anos
sudo chmod 755 /opt/anos
sudo -iu anos
git clone <the anossoftware repository> /opt/anos/anossoftware
git clone <the keyholdersoftware repository> /opt/anos/keyholdersoftware
cd /opt/anos/anossoftware && npm ci
cd /opt/anos/keyholdersoftware && npm ci
```

`/opt/anos` must be traversable by the `postgres` user, which reads each
repo's env files in step 7; the `chmod` makes sure of it whatever
`useradd` chose.

## 6. Keys

As `anos`, in each repo, once:

```bash
cd /opt/anos/anossoftware && npm run make-keys -- --id <N>
cd /opt/anos/keyholdersoftware && npm run make-keys -- --id <N>
```

Each writes its key file (`validator.key`, `keyholder.key`; mode 0600,
never shown) and its `.env`, and refuses to run a second time. The
validator's prints its public key: keep it for step 8 (`npm run show-key`
prints it again). The keyholder's `.env` has five lines to fill, each under
a comment saying what goes there:

- `KMS_KEY_NAME`: the resource name from step 4;
- `HOME_X25519_PUBLIC_KEY` and `HOME_MLKEM_PUBLIC_KEY`: your home
  computer's two public halves, from your keyholder GUI;
- `KEYHOLDER_PUBLIC_KEY_1` and `KEYHOLDER_PUBLIC_KEY_2`: your two YubiKeys'
  public keys, from the same GUI.

Nothing else in either `.env` is typed by hand. Everything shared by every
VM is in each repo's `network/testnet.env`, committed.

## 7. Databases

```bash
cd /opt/anos/anossoftware && sudo -u postgres sh scripts/setup-db.sh
cd /opt/anos/keyholdersoftware && sudo -u postgres sh scripts/setup-db.sh
cd /opt/anos/keyholdersoftware && sudo -u postgres sh scripts/grant-anos-read.sh
```

The first creates the role `anossoftware` and the database `anos` with its
tables; the second the role `keyholdersoftware` and the database
`keyholder`; the third the read-only role `keyholder_reader` in `anos`.
Each script loads `network/testnet.env` and then `.env`. All three are safe
to re-run.

## 8. The registry

Give us the validator's public key from step 6 and the doorman's address,
`https://<doorman static ip>:3000`. We commit your row to
`network/testnet.registry.json` and push; you pull, as `anos`:

```bash
cd /opt/anos/anossoftware && git pull
```

The validator applies the registry at boot and refuses to start while its
own row is missing, inactive, or carries another key.

## 9. The units

```bash
sudo cp /opt/anos/anossoftware/deploy/anos-validator.service /opt/anos/keyholdersoftware/deploy/anos-keyholder.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now anos-validator anos-keyholder
journalctl -fu anos-validator
journalctl -fu anos-keyholder
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3200/health
```

The validator logs `Validator <N>, public key <hex>`, the PostgreSQL line,
the genesis line, `Registry <16 hex>, <n> active`, then listening; its
health answers its id, public key, commit and registry hash. The keyholder
logs `Keyholder <N>`, two PostgreSQL lines, `KMS ok` (a round trip through
your Cloud KMS key), then listening. A server that stops on a configuration
error is restarted every five seconds until the file is fixed; the journal
shows the reason each time.

## 10. Updating

As `anos`, `git pull` in both repos, `npm ci` in a repo whose
`package-lock.json` changed, then:

```bash
sudo systemctl restart anos-validator anos-keyholder
```
