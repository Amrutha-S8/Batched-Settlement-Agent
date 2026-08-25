import { buildDomain, EIP712Domain } from "../../sdk/src/index";
import { getChainContext } from "./chain";

let cachedDomain: EIP712Domain | null = null;

/** The domain every agent's SDK must sign against for this deployment to
 * accept their authorizations — derived straight from the deployed
 * clearinghouse address + chain id so it can never silently drift out of
 * sync with what's actually on-chain. */
export function getDomain(): EIP712Domain {
  if (cachedDomain) return cachedDomain;
  const ctx = getChainContext();
  cachedDomain = buildDomain(ctx.chainId, ctx.addresses.SettlementClearinghouse);
  return cachedDomain;
}
