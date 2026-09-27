export const connectionTypes = ["rest", "grpc", "database", "mqtt", "nats", "kafka"] as const;
export type ConnectionType = (typeof connectionTypes)[number];
export interface ConnectionBend {
  x: number;
  y: number;
}
// Existing canvases store one bend as an object; edited routes store ordered waypoints.
export type ConnectionPath = ConnectionBend | ConnectionBend[] | null;

export interface ArchitectureConnection {
  id: string;
  workspaceId: string;
  sourceEntityId: string;
  targetEntityId: string;
  type: ConnectionType;
  label: string;
  description: string | null;
  metadata: { contract?: string; contractBody?: string; documentation?: string; direction?: "one-way" | "two-way" };
}
