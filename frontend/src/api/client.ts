const API_BASE_URL =
  (import.meta as any).env?.VITE_API_BASE_URL?.replace(/\/$/, "") ||
  "http://localhost:8000";

export async function analyzeAudio(file: File) {
  const form = new FormData();
  form.append("file", file);

  const res = await fetch(`${API_BASE_URL}/analyze`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Analyze failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data;
}

export { API_BASE_URL };
