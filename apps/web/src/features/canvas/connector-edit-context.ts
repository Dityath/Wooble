import { createContext } from "react";
import type { ConnectionPath } from "@wooble/domain";

export interface ConnectorEditState {
  editing: boolean;
  /** A create or Auto Neat request is in flight, so a bend save would be refused. */
  saving: boolean;
  /** Resolves false when the server refused the path, so the editor can report it. */
  saveBend: (id: string, bend: ConnectionPath) => Promise<boolean>;
}

export const ConnectorEditContext = createContext<ConnectorEditState>({
  editing: false,
  saving: false,
  saveBend: async () => true,
});
