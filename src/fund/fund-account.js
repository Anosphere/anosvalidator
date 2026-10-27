import { decodeDigest } from '../crypto/hash.js';
import fundAccount from '../genesis/fund-account.json' with { type: 'json' };

/**
 * The fund's account id: the SHA-256 of the word "anosFund", the accountId
 * of the genesis fund account (src/genesis/). Anos staked with the fund go
 * to this account (transferToFund) and fund proposals pay out of it. Nothing
 * can sign for it: its keys were thrown away after genesis.
 */

/** As the wire carries it: 64 lowercase hex characters. */
export const FUND_ACCOUNT_ID_HEX = fundAccount.payload.accountId;

/** As the database holds it: 32 raw bytes. */
export const FUND_ACCOUNT_ID = decodeDigest(FUND_ACCOUNT_ID_HEX);
