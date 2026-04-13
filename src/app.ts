import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";

import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app: Express = express();

// ✅ FIX: use .default for ESM compatibility
const httpLogger = (pinoHttp as any).default ?? pinoHttp;

app.use(
  httpLogger({
    logger,
    serializers: {
      req(req: Request) {
        return {
          id: (req as any).id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res: Response) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
