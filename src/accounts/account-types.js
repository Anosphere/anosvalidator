/**
 * The account types a create-account submission may ask for, as the web app
 * sends them in payload.accountType and as accounts.type stores them. The
 * genesis fund account (src/genesis/) has a type of its own, 'fund', that no
 * submission can ask for.
 *
 * The type decides how an account spends (src/transfer/transfer.service.js):
 * a spending account sends plain anosTransfers, escrowTransfers and
 * transfers to the fund; a guarded account sends guardedAnosTransfers and a
 * vault account vaultAnosTransfers, each held in locked_transactions for
 * that account's time lock; an assisted account sends
 * assistedAnosTransfers, held in assisted_transfers until two attestors
 * have attested to each (src/assisted-transfers/).
 */
export const SPENDING = 'spending';
export const GUARDED = 'guarded';
export const VAULT = 'vault';
export const ASSISTED = 'assisted';

export const ACCOUNT_TYPES = Object.freeze([SPENDING, GUARDED, VAULT, ASSISTED]);
