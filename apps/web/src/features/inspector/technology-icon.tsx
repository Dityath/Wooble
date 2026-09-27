import { Cable, Code2, Cpu, Database, Gauge, Radio, Server } from "lucide-react";
import {
  siAngular,
  siApachekafka,
  siArduino,
  siBluetooth,
  siBun,
  siClickhouse,
  siCplusplus,
  siDart,
  siDjango,
  siDocker,
  siElasticsearch,
  siEspressif,
  siExpress,
  siFastapi,
  siFastify,
  siFlutter,
  siGo,
  siGraphql,
  siJavascript,
  siKotlin,
  siKubernetes,
  siLaravel,
  siMicropython,
  siMongodb,
  siMqtt,
  siMysql,
  siNestjs,
  siNextdotjs,
  siNodedotjs,
  siNuxt,
  siPhp,
  siPostgresql,
  siPython,
  siRabbitmq,
  siRaspberrypi,
  siReact,
  siRedis,
  siRust,
  siSpringboot,
  siSqlite,
  siStmicroelectronics,
  siSvelte,
  siTerraform,
  siTypescript,
  siVuedotjs,
  siZigbee,
  type SimpleIcon,
} from "simple-icons";
import catalog from "./technology-catalog.json";

const brandIcons: Record<string, SimpleIcon> = {
  typescript: siTypescript,
  javascript: siJavascript,
  go: siGo,
  rust: siRust,
  python: siPython,
  kotlin: siKotlin,
  php: siPhp,
  dart: siDart,
  cpp: siCplusplus,
  micropython: siMicropython,
  esp32: siEspressif,
  esp8266: siEspressif,
  "raspberry-pi": siRaspberrypi,
  arduino: siArduino,
  stm32: siStmicroelectronics,
  react: siReact,
  nextjs: siNextdotjs,
  vue: siVuedotjs,
  nuxt: siNuxt,
  angular: siAngular,
  svelte: siSvelte,
  flutter: siFlutter,
  nodejs: siNodedotjs,
  bun: siBun,
  express: siExpress,
  fastify: siFastify,
  nestjs: siNestjs,
  spring: siSpringboot,
  django: siDjango,
  fastapi: siFastapi,
  laravel: siLaravel,
  postgresql: siPostgresql,
  mysql: siMysql,
  sqlite: siSqlite,
  mongodb: siMongodb,
  redis: siRedis,
  elasticsearch: siElasticsearch,
  clickhouse: siClickhouse,
  kafka: siApachekafka,
  rabbitmq: siRabbitmq,
  mqtt: siMqtt,
  graphql: siGraphql,
  zigbee: siZigbee,
  bluetooth: siBluetooth,
  docker: siDocker,
  kubernetes: siKubernetes,
  terraform: siTerraform,
};

const categoryIcons = {
  Hardware: Cpu,
  Sensors: Gauge,
  Messaging: Radio,
  Connectivity: Radio,
  Protocols: Cable,
  Databases: Database,
  Backend: Server,
  Languages: Code2,
  Frontend: Code2,
  Infrastructure: Server,
};

export function TechnologyIcon({ id }: { id: string }) {
  const brand = brandIcons[id];
  if (brand) {
    return (
      <svg aria-hidden="true" className="technology-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d={brand.path} />
      </svg>
    );
  }

  const category = catalog.find((item) => item.id === id)?.category;
  const Fallback = categoryIcons[category as keyof typeof categoryIcons] ?? Code2;
  return <Fallback aria-hidden="true" className="technology-icon" />;
}

export function TechnologyName({ id, label, version }: { id: string; label: string; version?: string }) {
  return (
    <span className="technology-name">
      <TechnologyIcon id={id} />
      <span>
        {label}
        {version ? ` ${version}` : ""}
      </span>
    </span>
  );
}
