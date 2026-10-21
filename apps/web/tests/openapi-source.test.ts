import { describe, expect, it, mock } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ContractEditor } from "../src/features/inspector/contract-editor";
import { generateOpenApi, type Operation, parseOpenApi } from "../src/features/inspector/openapi-source";
import { renderWithQuery } from "./support/render";

function fixtureOperations(source: string) {
  const parsed = parseOpenApi(source);
  if (!parsed) throw new Error("Fixture must parse");
  return parsed.operations;
}

const issueYaml = `openapi: 3.0.3
info: { title: Orders, version: "1" }
paths:
  /orders/{orderId}:
    parameters:
      - { name: orderId, in: path, required: true, schema: { type: string } }
    servers:
      - url: https://orders.example.test
    get: { summary: Read an order, responses: { "200": { description: OK } } }
    head: { summary: Check an order, responses: { "200": { description: OK } } }
`;
const extendedYaml =
  issueYaml
    .replace(
      "    get:",
      `    summary: Orders by ID
    description: Individual order operations
    $ref: '#/components/pathItems/Order'
    x-rate-limit: { requests: 100 }
    options: { summary: Order capabilities, responses: { "204": { description: Allowed } } }
    trace: { summary: Trace an order, x-internal: true, responses: { "200": { description: Trace } } }
    post: { summary: Update an order, responses: { "201": { description: Updated } } }
    get:`,
    )
    .replace(
      "summary: Read an order, responses:",
      "summary: Read an order, x-internal: { enabled: true }, parameters: [{ name: verbose, in: query }], responses:",
    ) +
  `  /reference:
    $ref: '#/components/pathItems/Order'
    description: Shared order path
  /temporary:
    delete: { summary: Remove temporary order, responses: { "204": { description: Removed } } }
x-owner: { team: Orders }
servers: [{ url: https://api.example.test }]
security: [{ apiKey: [] }]
components:
  pathItems:
    Order: { description: Shared order definition }
  schemas:
    Order: { type: object, properties: { id: { type: string } } }
`;
const orderPath = "/orders/{orderId}";

for (const format of ["JSON", "YAML"]) {
  const source = format === "JSON" ? JSON.stringify(parseYaml(extendedYaml)) : extendedYaml;
  const original = parseYaml(extendedYaml);
  const parsed = () => {
    const result = parseOpenApi(source);
    if (!result) throw new Error("Fixture must parse");
    return result;
  };
  const save = (operations: Operation[]) => JSON.parse(generateOpenApi("Orders", "1", operations, source));

  describe(`OpenAPI source preservation (${format})`, () => {
    it("preserves absent summaries and empty paths while editing or clearing a summary", () => {
      const document = {
        openapi: "3.1.0",
        info: { title: "Orders", version: "1" },
        paths: {
          "/empty": {},
          "/orders": {
            get: { summary: "Read", responses: { "200": { description: "OK" } } },
            post: { responses: { "201": { description: "Created" } } },
          },
        },
      };
      const input = format === "JSON" ? JSON.stringify(document) : stringifyYaml(document);
      for (const summary of ["Read details", ""]) {
        const operations = fixtureOperations(input).map((operation) =>
          operation.method === "GET" ? { ...operation, summary } : operation,
        );
        const expected = structuredClone(document);
        expected.paths["/orders"].get.summary = summary;
        expect(JSON.parse(generateOpenApi("Orders", "1", operations, input))).toEqual(expected);
      }
    });

    it("hides malformed operations and preserves them through unrelated edits and deletion", () => {
      const document = {
        openapi: "3.1.0",
        info: { title: "Orders", version: "1" },
        paths: { "/a": { get: "keep", put: [], delete: null, patch: 42, post: { summary: "Change" } } },
      };
      const input = format === "JSON" ? JSON.stringify(document) : stringifyYaml(document);
      const operations = fixtureOperations(input);
      expect(operations).toHaveLength(1);
      expect(operations[0].method).toBe("POST");
      const edited = operations.map((operation) => ({ ...operation, summary: "Changed" }));
      const expected = structuredClone(document);
      expected.paths["/a"].post.summary = "Changed";
      expect(JSON.parse(generateOpenApi("Orders", "1", edited, input))).toEqual(expected);
      expect(JSON.parse(generateOpenApi("Orders", "1", [], input))).toEqual({
        ...document,
        paths: { "/a": { get: "keep", put: [], delete: null, patch: 42 } },
      });
    });

    for (const invalid of ["keep", [], null, 42, false]) {
      for (const action of ["move", "add"]) {
        it(`refuses to ${action} onto a malformed operation ${JSON.stringify(invalid)}`, () => {
          const document = {
            openapi: "3.1.0",
            info: { title: "Orders", version: "1" },
            paths: { "/a": { get: invalid }, "/b": { get: { summary: "Read" } } },
          };
          const input = format === "JSON" ? JSON.stringify(document) : stringifyYaml(document);
          const operations = fixtureOperations(input);
          const edited =
            action === "move"
              ? operations.map((operation) => ({ ...operation, path: "a" }))
              : [...operations, { id: "new", method: "GET", path: "a", summary: "New" }];
          expect(() => generateOpenApi("Orders", "1", edited, input)).toThrow(
            "The source has an invalid GET operation at /a. Fix it in the source editor.",
          );
        });
      }
    }

    for (const action of ["move", "add"]) {
      it(`shows an error without saving when a GUI ${action} targets a malformed operation`, async () => {
        const document = {
          openapi: "3.1.0",
          info: { title: "Orders", version: "1" },
          paths: { "/a": { get: "keep", post: { summary: "Change" } } },
        };
        const input = format === "JSON" ? JSON.stringify(document) : stringifyYaml(document);
        const onSave = mock(async (_value: string) => {});
        const { user } = renderWithQuery(createElement(ContractEditor, { value: input, kind: "rest", onSave }));
        await user.click(screen.getByRole("tab", { name: "Visual editor" }));
        if (action === "move") {
          await user.selectOptions(screen.getByLabelText("Method 1"), "GET");
        } else {
          await user.click(screen.getByRole("button", { name: "Add endpoint" }));
          await user.type(screen.getByLabelText("Path 2"), "/a");
        }
        await user.click(screen.getByRole("button", { name: "Save contract" }));
        expect((await screen.findByRole("alert")).textContent).toBe(
          "The source has an invalid GET operation at /a. Fix it in the source editor.",
        );
        expect(onSave).not.toHaveBeenCalled();
        await user.click(screen.getByRole("tab", { name: "Source" }));
        expect((screen.getByLabelText("Contract source") as HTMLTextAreaElement).value).toBe(input);
      });
    }

    it("rejects duplicate normalized destinations", () => {
      expect(() =>
        save([
          ...parsed().operations,
          { id: "duplicate", method: "GET", path: "orders/{orderId}", summary: "Duplicate" },
        ]),
      ).toThrow("Two operations use GET /orders/{orderId}. Change one before saving.");
    });

    for (const invalid of ["invalid", null, []]) {
      it(`preserves untouched invalid path items and rejects moving into ${JSON.stringify(invalid)}`, () => {
        const document = { ...original, paths: { ...original.paths, "/target": invalid } };
        const input = format === "JSON" ? JSON.stringify(document) : stringifyYaml(document);
        const operations = fixtureOperations(input);
        const edited = operations.map((operation) =>
          operation.method === "GET" ? { ...operation, summary: "Edited" } : operation,
        );
        const expected = structuredClone(document);
        expected.paths[orderPath].get.summary = "Edited";
        expect(JSON.parse(generateOpenApi("Orders", "1", edited, input))).toEqual(expected);
        expect(() =>
          generateOpenApi(
            "Orders",
            "1",
            operations.map((operation) => (operation.method === "GET" ? { ...operation, path: "/target" } : operation)),
            input,
          ),
        ).toThrow("The source's path item for /target is not an object. Fix it in the source editor.");
      });
    }

    it("preserves the issue fixture and records source identities", () => {
      const fixture = format === "JSON" ? JSON.stringify(parseYaml(issueYaml)) : issueYaml;
      const result = parseOpenApi(fixture);
      expect(result?.operations).toHaveLength(1);
      expect(result?.operations[0]).toMatchObject({ sourcePath: orderPath, sourceMethod: "get" });
      expect(JSON.parse(generateOpenApi("Orders", "1", result?.operations ?? [], fixture))).toEqual(
        parseYaml(issueYaml),
      );
    });

    it("changes only the edited summary, preserving metadata and unlisted methods", () => {
      const operations = parsed().operations.map((operation) =>
        operation.method === "GET" ? { ...operation, summary: "Read order details" } : operation,
      );
      const expected = structuredClone(original);
      expected.paths[orderPath].get.summary = "Read order details";
      expect(save(operations)).toEqual(expected);
    });

    it("keeps other info and top-level keys when title and version change", () => {
      const document = {
        ...original,
        info: { ...original.info, description: "Orders API", "x-contact": "Orders team" },
      };
      const input =
        format === "JSON"
          ? JSON.stringify(document)
          : source.replace(
              'info: { title: Orders, version: "1" }',
              'info: { title: Orders, version: "1", description: Orders API, x-contact: Orders team }',
            );
      const output = JSON.parse(generateOpenApi("New title", "2", parsed().operations, input));
      expect(output).toEqual({ ...document, info: { ...document.info, title: "New title", version: "2" } });
    });

    it("removes only deleted operations and prunes only empty path items", () => {
      const expected = structuredClone(original);
      delete expected.paths[orderPath].get;
      expect(save(parsed().operations.filter((operation) => operation.method !== "GET"))).toEqual(expected);
      delete expected.paths[orderPath].post;
      delete expected.paths["/temporary"];
      expect(save([])).toEqual(expected);
      const metadataOnly = {
        ...original,
        paths: { "/metadata": { parameters: [], get: original.paths[orderPath].get } },
      };
      const input =
        format === "JSON"
          ? JSON.stringify(metadataOnly)
          : 'openapi: 3.0.3\ninfo: { title: Orders, version: "1" }\npaths:\n  /metadata:\n    parameters: []\n    get: { summary: Read an order }\n';
      expect(JSON.parse(generateOpenApi("Orders", "1", [], input)).paths).toEqual({ "/metadata": { parameters: [] } });
    });

    for (const change of [{ path: "/moved" }, { method: "PATCH" }, { path: "/moved", method: "PUT" }]) {
      it(`moves the original operation with ${JSON.stringify(change)}`, () => {
        const operations = parsed().operations.map((operation) =>
          operation.method === "GET" ? { ...operation, ...change } : operation,
        );
        const output = save(operations);
        const path = change.path ?? orderPath;
        const method = (change.method ?? "GET").toLowerCase();
        const expected = structuredClone(original);
        delete expected.paths[orderPath].get;
        expected.paths[path] ??= {};
        expected.paths[path][method] = original.paths[orderPath].get;
        expect(output).toEqual(expected);
        expect(Object.keys(output.paths)).toEqual([
          ...Object.keys(original.paths),
          ...(change.path ? [change.path] : []),
        ]);
      });
    }

    it("adds defaults for new operations, skips blank paths, and keeps existing path order", () => {
      const output = save([
        ...parsed().operations,
        { id: "new", method: "POST", path: "new", summary: "Create order" },
        { id: "blank", method: "GET", path: "  ", summary: "Ignored" },
      ]);
      expect(output).toEqual({
        ...original,
        paths: {
          ...original.paths,
          "/new": { post: { responses: { "200": { description: "Successful response" } }, summary: "Create order" } },
        },
      });
      expect(Object.keys(output.paths)).toEqual([...Object.keys(original.paths), "/new"]);
    });

    it("preserves original fields when operations swap locations", () => {
      const operations = parsed().operations.map((operation) => ({
        ...operation,
        method: operation.method === "GET" ? "POST" : operation.method === "POST" ? "GET" : operation.method,
      }));
      const expected = structuredClone(original);
      expected.paths[orderPath].get = original.paths[orderPath].post;
      expected.paths[orderPath].post = original.paths[orderPath].get;
      expect(save(operations)).toEqual(expected);
    });

    it("saves HEAD and path parameters through the GUI", async () => {
      const onSave = mock(async (_value: string) => {});
      const fixture = format === "JSON" ? JSON.stringify(parseYaml(issueYaml)) : issueYaml;
      const { user } = renderWithQuery(createElement(ContractEditor, { value: fixture, kind: "rest", onSave }));
      await user.click(screen.getByRole("tab", { name: "Visual editor" }));
      await user.clear(screen.getByLabelText("Summary 1"));
      await user.type(screen.getByLabelText("Summary 1"), "Read order details");
      await user.click(screen.getByRole("button", { name: "Save contract" }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      const expected = parseYaml(issueYaml);
      expected.paths[orderPath].get.summary = "Read order details";
      expect(JSON.parse(onSave.mock.calls[0][0])).toEqual(expected);
    });
  });
}

describe("YAML path aliases", () => {
  const source = `openapi: 3.1.0
info: { title: Orders, version: "1" }
paths:
  /a: &shared { get: { summary: Read } }
  /b: *shared
`;
  it("deletes an operation without deleting its alias", () => {
    const operations = fixtureOperations(source).filter((operation) => operation.path !== "/a");
    const expected = parseYaml(source);
    delete expected.paths["/a"];
    expect(JSON.parse(generateOpenApi("Orders", "1", operations, source))).toEqual(expected);
  });
  it("moves an operation without changing its alias", () => {
    const operations = fixtureOperations(source).map((operation) =>
      operation.path === "/a" ? { ...operation, path: "/moved", summary: "Moved" } : operation,
    );
    const expected = parseYaml(source);
    delete expected.paths["/a"];
    expected.paths["/moved"] = { get: { summary: "Moved" } };
    expect(JSON.parse(generateOpenApi("Orders", "1", operations, source))).toEqual(expected);
  });
});
