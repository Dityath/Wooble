import type { ArchitectureEntity } from "@wooble/domain";
import catalog from "./technology-catalog.json";

type TechnologyCategory = (typeof catalog)[number]["category"];
export type TechnologyGroup = { label: string; categories: TechnologyCategory[] };

const group = (label: string, ...categories: TechnologyCategory[]): TechnologyGroup => ({ label, categories });
const standardGroups = [
  group("Languages", "Languages"),
  group("Hardware", "Hardware"),
  group("Sensors", "Sensors"),
  group("Frontend", "Frontend"),
  group("Backend", "Backend"),
  group("Databases", "Databases"),
  group("Messaging", "Messaging"),
  group("Connectivity", "Connectivity"),
  group("Protocols", "Protocols"),
  group("Infrastructure", "Infrastructure"),
];

export const technologyGroupsByType: Record<ArchitectureEntity["type"], TechnologyGroup[]> = {
  system: [group("Infrastructure", "Infrastructure")],
  frontend: [
    group("Languages", "Languages"),
    group("Frontend", "Frontend"),
    group("Protocols", "Protocols"),
    group("Infrastructure", "Infrastructure"),
  ],
  device: [
    group("Hardware", "Hardware"),
    group("Sensors", "Sensors"),
    group("Connectivity", "Connectivity"),
    group("Protocols", "Protocols"),
    group("Messaging", "Messaging"),
  ],
  gateway: [
    group("Languages", "Languages"),
    group("Backend", "Backend"),
    group("Protocols", "Protocols"),
    group("Infrastructure", "Infrastructure"),
  ],
  service: [
    group("Languages", "Languages"),
    group("Backend", "Backend"),
    group("Databases", "Databases"),
    group("Messaging", "Messaging"),
    group("Protocols", "Protocols"),
    group("Infrastructure", "Infrastructure"),
  ],
  database: [group("Databases", "Databases"), group("Infrastructure", "Infrastructure")],
  broker: [group("Messaging", "Messaging"), group("Protocols", "Protocols"), group("Infrastructure", "Infrastructure")],
  external: standardGroups,
};

export function technologyItemsForGroup(group: TechnologyGroup) {
  return catalog.filter((item) => group.categories.includes(item.category));
}
