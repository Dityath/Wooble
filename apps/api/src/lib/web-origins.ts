import { parseWebOrigins } from "./config";

const developmentOrigins = Array.from({ length: 7 }, (_, index) => 5173 + index).flatMap((port) => [
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
]);

export const allowedWebOrigins = parseWebOrigins(process.env) ?? developmentOrigins;
