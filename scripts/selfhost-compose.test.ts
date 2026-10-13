import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const base = read("../compose.selfhost.yml");
const local = read("../compose.selfhost.local.yml");
const privateMode = read("../compose.selfhost.private.yml");
const domain = read("../compose.selfhost.domain.yml");
const source = read("../compose.selfhost.source.yml");
const caddy = read("../deploy/Caddyfile");

describe("self-host Compose contract", () => {
  test("requires a release version and has a stable overridable project name", () => {
    expect(base).toMatch(/name: \$\{WOOBLE_COMPOSE_PROJECT_NAME:-wooble\}/);
    expect(base.match(/\$\{WOOBLE_VERSION:\?/g)).toHaveLength(3);
    expect(base).toMatch(/ghcr\.io\/dityath\/wooble-api:\$\{WOOBLE_VERSION:\?/);
    expect(base).toMatch(/ghcr\.io\/dityath\/wooble-web:\$\{WOOBLE_VERSION:\?/);
  });

  test("keeps API and database private and pins proxy peers to configured addresses", () => {
    expect(base).toMatch(/ipv4_address: \$\{WOOBLE_CADDY_IP:-172\.30\.0\.2\}/);
    expect(base).toMatch(/ipv4_address: \$\{WOOBLE_API_IP:-172\.30\.0\.3\}/);
    expect(base).toMatch(/subnet: \$\{WOOBLE_PROXY_SUBNET:-172\.30\.0\.0\/24\}/);
    expect(base).toContain('TRUST_PROXY: "true"');
    expect(base).toMatch(/TRUSTED_PROXY_CIDRS: \$\{TRUSTED_PROXY_CIDRS:-172\.30\.0\.2\/32\}/);
    expect(base).toContain("internal: true");
    expect(base).not.toMatch(/\n\s+(?:api|postgres):[\s\S]*?\n\s+ports:/);
  });

  test("binds local access only to loopback over TLS", () => {
    expect(local).toMatch(/127\.0\.0\.1:\$\{WOOBLE_HTTP_PORT:\?Set WOOBLE_HTTP_PORT\}:443/);
    expect(local).toContain('"tls internal"');
  });

  test("requires private binding and TLS host settings", () => {
    expect(privateMode).toMatch(/\$\{WOOBLE_BIND_ADDRESS:\?Set WOOBLE_BIND_ADDRESS explicitly\}/);
    expect(privateMode).toMatch(/\$\{WOOBLE_CADDY_HOST:\?Set WOOBLE_CADDY_HOST/);
    expect(privateMode).toContain('"tls internal"');
  });

  test("uses Caddy automatic HTTPS for domain mode", () => {
    expect(domain).toMatch(/\$\{WOOBLE_DOMAIN:\?Set WOOBLE_DOMAIN for automatic HTTPS\}/);
    expect(domain).toContain('"443:443"');
    expect(domain).toContain('"80:80"');
  });

  test("source overlay builds all release-image services and Caddy proxies API routes", () => {
    expect(source.match(/target: api/g)).toHaveLength(2);
    expect(source).toContain("target: web");
    expect(caddy).toContain("reverse_proxy api:3001");
    expect(caddy).toContain("handle /api/*");
    expect(caddy).toContain("handle /health");
    expect(caddy).toContain("trusted_proxies static {$CADDY_TRUSTED_PROXY_CIDRS}");
  });
});
