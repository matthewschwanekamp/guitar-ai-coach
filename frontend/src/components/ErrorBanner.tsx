import React from "react";
import { ApiError } from "../types";

export interface DisplayError {
  user_message: string;
  how_to_fix?: string[];
  error_code?: string;
}

interface Props {
  error: DisplayError | ApiError;
}

const ErrorBanner: React.FC<Props> = ({ error }) => {
  if (!error) return null;
  const howToFix = (error as any).how_to_fix || [];
  const code = (error as any).error_code;

  return (
    <div
      style={{
        marginTop: 10,
        padding: 12,
        borderRadius: 10,
        background: "#fff3f3",
        border: "1px solid #ffd0d0",
        color: "#8a1f1f",
      }}
      role="alert"
      aria-live="assertive"
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Something went wrong</div>
      <div style={{ marginBottom: howToFix.length ? 6 : 0 }}>
        {error.user_message || "An error occurred."}
        {code ? ` (code: ${code})` : ""}
      </div>
      {howToFix.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, color: "#7a1a1a" }}>
          {howToFix.slice(0, 4).map((step, idx) => (
            <li key={idx} style={{ marginBottom: 2 }}>
              {step}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default ErrorBanner;
