export const entityTypes = [
  "system",
  "frontend",
  "device",
  "gateway",
  "service",
  "database",
  "broker",
  "external",
] as const;
export type EntityType = (typeof entityTypes)[number];

export type EntityMetadata = {
  language?: string;
  framework?: string;
  repositoryUrl?: string;
  artifactUrl?: string;
  status?: "planned" | "in-progress" | "implemented" | "deprecated";
  engine?: string;
  version?: string;
  technology?: string;
  technologyStack?: string[];
  technologyVersions?: Record<string, string>;
  interfaces?: string[];
  documentation?: string;
  schemaSql?: string;
};

export interface ArchitectureEntity {
  id: string;
  workspaceId: string;
  type: EntityType;
  name: string;
  description: string | null;
  metadata: EntityMetadata;
  createdAt: string;
  updatedAt: string;
}
