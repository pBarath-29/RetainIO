import { Account } from './types';

/**
 * Whether an account is a customer who has left at renewal. The server marks the subscription
 * `churned`; this is the one place the screens ask, so no page decides "churned" its own way.
 *
 * Churned accounts are not deleted: their renewal record trains the models, their audit trail
 * stands, and a mistaken churn can be reversed from the Renewals page. But they are no longer
 * part of the working portfolio, so they are left out of every list and count of accounts that
 * can still be saved, and shown in a section of their own.
 */
export const isChurned = (account: Pick<Account, 'subscriptionStatus'>): boolean =>
  account.subscriptionStatus === 'churned';

export function splitByStatus<T extends Pick<Account, 'subscriptionStatus'>>(accounts: T[]): { active: T[]; churned: T[] } {
  const active: T[] = [];
  const churned: T[] = [];
  for (const account of accounts) (isChurned(account) ? churned : active).push(account);
  return { active, churned };
}
