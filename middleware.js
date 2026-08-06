/* Vercel requires middleware at the project root — the real logic lives in backend/. */
export { default, config } from "./backend/middleware.js";
