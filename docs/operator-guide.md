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

Two VMs in your project, in the same zone: the doorman, which holds the
static external IP, terminates TLS and checks every request before it
reaches you, and the worker, which has an internal IP only and reaches the
internet through the doorman. Set the doorman up first: until it runs, the
worker cannot reach apt, GitHub or npm. The doorman's own install, in
order, is "The doorman VM" in the doormansoftware README. What the project
needs around the two VMs, with `gcloud` from your own machine; `<zone>`,
`<region>`, `<doorman>` and `<worker>` are your zone, region and VM names,
and the rules assume the project's `default` network:

1. The doorman's external IP is a reserved static address, so it survives
   a stop or a rebuild. If it is still ephemeral, promote it:

```bash
gcloud compute addresses create doorman-ip --region <region> --addresses <the IP>
```

2. IP forwarding on the doorman, which the worker's outbound path needs.
   Check it; when it is `False`, export the instance, change
   `canIpForward: false` to `true` in the file, and apply it, which needs
   no stop:

```bash
gcloud compute instances describe <doorman> --zone <zone> --format='value(canIpForward)'
gcloud compute instances export <doorman> --zone <zone> --destination doorman.yaml
gcloud compute instances update-from-file <doorman> --zone <zone> --source doorman.yaml --most-disruptive-allowed-action REFRESH
```

3. Network tags, which the firewall rules and the route select by:

```bash
gcloud compute instances add-tags <doorman> --zone <zone> --tags doorman
gcloud compute instances add-tags <worker> --zone <zone> --tags worker
```

4. Firewall: the four rules a new project's default network comes with
   go, and four of ours replace them. Nothing reaches the worker but the
   doorman, and nothing reaches port 22 anywhere but IAP:

```bash
gcloud compute firewall-rules delete default-allow-ssh default-allow-rdp default-allow-icmp default-allow-internal
gcloud compute firewall-rules create doorman-public --network default --direction INGRESS --allow tcp:80,tcp:3000,tcp:3200 --source-ranges 0.0.0.0/0 --target-tags doorman
gcloud compute firewall-rules create iap-ssh --network default --direction INGRESS --allow tcp:22 --source-ranges 35.235.240.0/20 --target-tags doorman,worker
gcloud compute firewall-rules create worker-to-doorman --network default --direction INGRESS --allow all --source-tags worker --target-tags doorman
gcloud compute firewall-rules create doorman-to-worker --network default --direction INGRESS --allow tcp:3000,tcp:3200 --source-tags doorman --target-tags worker
```

5. The worker's route to the internet, through the doorman. It applies to
   the `worker` tag only, so the doorman keeps the default route:

```bash
gcloud compute routes create worker-egress --network default --destination-range 0.0.0.0/0 --next-hop-instance <doorman> --next-hop-instance-zone <zone> --priority 900 --tags worker
```

6. SSH to either VM goes through IAP, never a public port 22:

```bash
gcloud compute ssh <doorman> --zone <zone> --tunnel-through-iap
gcloud compute ssh <worker> --zone <zone> --tunnel-through-iap
```

7. A Cloud Billing budget on the project with email alerts at 50, 90 and
   100 percent: visibility, not a cap. The hard cap on internet egress is
   the doorman's own monthly quota, 100 GB, described in its README.

Your validator's address for step 8 is `https://<doorman static ip>:3000`.
The `PORT` lines of both servers stay 3000 and 3200: the doorman forwards
to them over the internal IP, and the worker's firewall admits nothing
else.

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
