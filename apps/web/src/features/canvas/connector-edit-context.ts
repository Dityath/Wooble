import { createContext } from "react";
import type { ConnectionPath } from "@wooble/domain";

export interface ConnectorEditState {
  editing: boolean;
  saveBend: (id: string, bend: ConnectionPath) => Promise<void>;
}

export const ConnectorEditContext = createContext<ConnectorEditState>({ editing: false, saveBend: async () => {} });
