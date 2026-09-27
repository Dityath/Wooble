import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "./input";

export const PasswordInput = React.forwardRef<HTMLInputElement, Omit<React.ComponentProps<"input">, "type">>(
  (props, ref) => {
    const [visible, setVisible] = React.useState(false);
    return (
      <span className="password-field">
        <Input {...props} ref={ref} type={visible ? "text" : "password"} />
        <button
          type="button"
          className="password-visibility"
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          onClick={() => setVisible((value) => !value)}
        >
          {visible ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </span>
    );
  },
);
PasswordInput.displayName = "PasswordInput";
