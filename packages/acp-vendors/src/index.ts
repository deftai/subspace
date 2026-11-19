import type { ClientLayer } from '@deft-subspace/acp';
import type { AgentWorkbench } from '@deft-subspace/agent-driver';
import { antigravityLayer } from './antigravity.ts';
import { deftLayer } from './deft.ts';
import { vendorServicesLayer } from './services.ts';
import { xaiLayer } from './xai.ts';

export { antigravityLayer, type AntigravityLayerState } from './antigravity.ts';
export { deftLayer, type DeftLayerState } from './deft.ts';
export {
  createVendorServices,
  VENDOR_SERVICES,
  vendorServicesLayer,
  type VendorAuthOutcome,
  type VendorServices,
} from './services.ts';
export { xaiLayer, type XaiLayerState } from './xai.ts';

/** Convenience stack: `vendorServicesLayer()` followed by Deft, xAI, and Antigravity layers. */
export function vendorLayers(workbench: AgentWorkbench): ClientLayer<any>[] {
  return [vendorServicesLayer(), deftLayer(workbench), xaiLayer(workbench), antigravityLayer(workbench)];
}
