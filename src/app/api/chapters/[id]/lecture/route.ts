/**
 * @deprecated The lecture endpoint was renamed to /api/chapters/[id]/companion
 * (AI 伴学指南). This route forwards to the canonical handler for one release
 * cycle; new clients must call the companion endpoint.
 */
export { POST } from "../companion/route";
