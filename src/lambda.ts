import { handle } from "hono/aws-lambda";
import app from "./index.js";

// AWS Lambda entry (Function URL / API Gateway v2). Local dev and Docker still use src/index.ts.
export const handler = handle(app);
