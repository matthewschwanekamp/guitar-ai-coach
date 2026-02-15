import React from "react";

interface Props {
  message: string;
}

const ErrorBanner: React.FC<Props> = ({ message }) => {
  if (!message) return null;
  return (
    <div style={{ background: "#ffe9e9", border: "1px solid #ffb3b3", color: "#a40000", padding: "10px 12px", borderRadius: 8, marginTop: 10 }}>
      {message}
    </div>
  );
};

export default ErrorBanner;
