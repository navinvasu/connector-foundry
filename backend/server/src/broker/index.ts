// Credential broker module boundary (AB-02).
// Only this module holds the vault read capability — no route may import
// the vault client directly (AB-01 cross-cutting rule).
export {
  VaultClient,
  DevKekProvider,
  KmsKekProvider,
  resolveVault,
  requireVault,
  assertBrokerBoot,
} from './vault.js';
export {
  injectionFor,
  applyInjection,
  DEFAULT_INJECTION,
  type AuthInjection,
} from './inject.js';
export {
  resolveLease,
  resolveProjectTenant,
  DESTROYED_HANDLE,
  type LeaseRequest,
  type LeaseResult,
} from './leases.js';
