import { createIdentifier } from "@yeatz/app-framework/ioc";
import { CloudError } from "@media-marshal/contracts";
import type { CoreHostGateway } from "@media-marshal/contracts/internal/rpc";
export const CloudHostToken = createIdentifier<CoreHostGateway>("media.cloud.host");
export const unavailableHost: CoreHostGateway = {
  context() { throw new CloudError("COMPONENT_UNAVAILABLE"); },
  request() { return Promise.reject(new CloudError("COMPONENT_UNAVAILABLE")); },
};
