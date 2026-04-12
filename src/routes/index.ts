import { Router, type IRouter } from "express";
import roomsRouter from "./rooms";

const router: IRouter = Router();

router.use(roomsRouter);

export default router;
