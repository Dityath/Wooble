import {
  SystemNode,
  FrontendNode,
  DeviceNode,
  GatewayNode,
  ServiceNode,
  DatabaseNode,
  BrokerNode,
  ExternalNode,
} from "./architecture-nodes";

export const nodeTypes = {
  system: SystemNode,
  frontend: FrontendNode,
  device: DeviceNode,
  gateway: GatewayNode,
  service: ServiceNode,
  database: DatabaseNode,
  broker: BrokerNode,
  external: ExternalNode,
};
