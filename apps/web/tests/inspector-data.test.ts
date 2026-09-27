import { expect, test } from "bun:test";
import {
  createCanvasConnectionSchema,
  createCanvasEntitySchema,
  updateConnectionSchema,
  updateEntitySchema,
} from "@wooble/contracts";
import { canvasSubtreeIds } from "@wooble/domain";
import catalog from "../src/features/inspector/technology-catalog.json";
import { technologyGroupsByType, technologyItemsForGroup } from "../src/features/inspector/technology-groups";

test("deleting a system includes every nested canvas placement", () => {
  const placements = [
    { entityId: "system", parentEntityId: null },
    { entityId: "service", parentEntityId: "system" },
    { entityId: "nested-system", parentEntityId: "system" },
    { entityId: "database", parentEntityId: "nested-system" },
    { entityId: "other", parentEntityId: null },
  ];
  expect(canvasSubtreeIds(placements, "system")).toEqual(["system", "service", "nested-system", "database"]);
  expect(canvasSubtreeIds(placements, "service")).toEqual(["service"]);
});

test("inspector edit contracts accept technology and documentation while bounding input", () => {
  expect(
    updateEntitySchema.safeParse({
      type: "service",
      name: "Auth Service",
      description: null,
      metadata: {
        technologyStack: ["go", "fiber"],
        technologyVersions: { go: "1.23", fiber: "2.52" },
        repositoryUrl: "https://example.com/repo",
        documentation: "Usage notes",
      },
    }).success,
  ).toBe(true);
  expect(updateEntitySchema.safeParse({ metadata: { technologyStack: ["go"] } }).success).toBe(true);
  expect(
    updateConnectionSchema.safeParse({
      type: "grpc",
      label: "gRPC",
      description: null,
      metadata: { contract: "proto/auth.proto", contractBody: 'syntax = "proto3";' },
    }).success,
  ).toBe(true);
  expect(updateConnectionSchema.safeParse({ metadata: { contractBody: 'syntax = "proto3";' } }).success).toBe(true);
  expect(
    updateEntitySchema.safeParse({
      type: "service",
      name: "Auth Service",
      description: null,
      metadata: { technologyStack: Array.from({ length: 101 }, (_, index) => `tech-${index}`) },
    }).success,
  ).toBe(false);
});

test("IoT connectivity is separate from protocols and unavailable to services and gateways", () => {
  expect(updateEntitySchema.safeParse({ type: "device" }).success).toBe(true);
  expect(
    createCanvasEntitySchema.safeParse({
      type: "device",
      x: 0,
      y: 0,
      parentEntityId: null,
    }).success,
  ).toBe(true);
  expect(updateConnectionSchema.safeParse({ type: "mqtt" }).success).toBe(true);
  expect(
    createCanvasConnectionSchema.safeParse({
      sourceEntityId: "00000000-0000-4000-8000-000000000001",
      targetEntityId: "00000000-0000-4000-8000-000000000002",
      type: "mqtt",
    }).success,
  ).toBe(true);
  expect(catalog.find((item) => item.id === "mqtt")?.category).toBe("Protocols");
  expect(catalog.find((item) => item.id === "esp32")?.category).toBe("Hardware");
  const deviceGroups = technologyGroupsByType.device;
  expect(deviceGroups.map((group) => group.label)).toEqual([
    "Hardware",
    "Sensors",
    "Connectivity",
    "Protocols",
    "Messaging",
  ]);
  const choices = (type: "device" | "service" | "gateway") =>
    technologyGroupsByType[type].flatMap((group) => technologyItemsForGroup(group).map((item) => item.id));
  const deviceChoices = choices("device");
  for (const id of ["esp32", "bme280", "wifi", "bluetooth", "mqtt", "rest", "grpc", "nats"]) {
    expect(deviceChoices).toContain(id);
  }
  expect(technologyItemsForGroup(deviceGroups[2]).map((item) => item.id)).toEqual([
    "zigbee",
    "bluetooth",
    "wifi",
    "lorawan",
  ]);
  expect(technologyItemsForGroup(deviceGroups[3]).map((item) => item.id)).toEqual([
    "mqtt",
    "rest",
    "grpc",
    "graphql",
    "websocket",
  ]);
  expect(deviceChoices).not.toContain("fastify");
  for (const type of ["service", "gateway"] as const) {
    expect(choices(type)).toContain("rest");
    expect(choices(type)).toContain("grpc");
    for (const id of ["wifi", "bluetooth", "zigbee", "lorawan"]) {
      expect(choices(type)).not.toContain(id);
    }
  }
});
