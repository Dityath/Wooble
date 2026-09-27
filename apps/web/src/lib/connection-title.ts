import type { ArchitectureConnection, ConnectionType } from "@wooble/domain";

const protocolNames: Record<ConnectionType, string> = {
  rest: "REST",
  grpc: "gRPC",
  database: "Database",
  mqtt: "MQTT",
  nats: "NATS",
  kafka: "Kafka",
};

export function connectionTitle(connection: Pick<ArchitectureConnection, "label" | "type">): string {
  return connection.label.trim() || protocolNames[connection.type];
}
