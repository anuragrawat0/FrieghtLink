export const apiOrigin = (process.env.NEXT_PUBLIC_API_ORIGIN || "http://localhost:3001").replace(/\/+$/, "");
export const apiBaseUrl = `${apiOrigin}/api/v1`;
